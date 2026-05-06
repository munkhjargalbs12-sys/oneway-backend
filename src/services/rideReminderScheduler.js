const pool = require("../db");
const { createNotification } = require("../utils/notify");

const REMINDER_TYPE = "ride_reminder";
const ACTIVE_RIDE_STATUSES = ["active", "full", "scheduled", "pending"];
const NO_SHOW_RIDE_STATUSES = ["active", "full", "scheduled", "pending", "started"];
const REMINDER_ADVISORY_LOCK_ID = 58420317;
const DEFAULT_RIDE_TIMEZONE = "Asia/Ulaanbaatar";
const DEFAULT_LEAD_MINUTES = 10;
const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5 * 1000;
const REMINDER_CHANNEL_ID = "ride-reminder";
const REMINDER_SOUND = "horn.wav";

let schedulerTimer = null;
let runInFlight = null;

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getRideTimezone() {
  const value = String(process.env.RIDE_TIMEZONE || "").trim();
  return value || DEFAULT_RIDE_TIMEZONE;
}

function getReminderLeadMinutes() {
  return toPositiveInt(
    process.env.RIDE_REMINDER_LEAD_MINUTES,
    DEFAULT_LEAD_MINUTES
  );
}

function getReminderPollMs() {
  return toPositiveInt(process.env.RIDE_REMINDER_POLL_MS, DEFAULT_POLL_MS);
}

function getReminderStartupDelayMs() {
  return toPositiveInt(
    process.env.RIDE_REMINDER_STARTUP_DELAY_MS,
    DEFAULT_STARTUP_DELAY_MS
  );
}

function getNoShowGraceMinutes() {
  const parsed = Number(process.env.RIDE_NO_SHOW_GRACE_MINUTES);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 5;
}

function isSchedulerDisabled() {
  return (
    String(process.env.DISABLE_RIDE_REMINDER_SCHEDULER || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function normalizeStartTime(value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  return raw.slice(0, 5);
}

function buildReminderTitle() {
  return "Уулзах цаг дөхлөө • Location асаана уу";
}

function buildReminderBody(candidate) {
  const startLocation = normalizeText(candidate?.start_location);
  const endLocation = normalizeText(candidate?.end_location);
  const startTime = normalizeStartTime(candidate?.start_time);

  const routePrefix = endLocation ? `${endLocation} чиглэлийн` : "Таны аяллын";
  const locationPrompt =
    "Таныг уулзах цэгт цагтаа очсоныг шалгахын тулд байршил заагчаа асаана уу.";

  if (startLocation && startTime) {
    return `${routePrefix} уулзалт ${startTime}-д эхэлнэ. ${startLocation} цэгтээ очоорой. ${locationPrompt}`;
  }

  if (startLocation) {
    return `${routePrefix} уулзалт 10 минутын дараа эхэлнэ. ${startLocation} цэгтээ очоорой. ${locationPrompt}`;
  }

  if (startTime) {
    return `${routePrefix} уулзалт ${startTime}-д эхэлнэ. Уулзах цэгтээ очоорой. ${locationPrompt}`;
  }

  return `10 минутын дараа аялал эхэлнэ. Уулзах цэгтээ очоорой. ${locationPrompt}`;
}

function buildReminderCandidatesQuery(hasRideIdFilter) {
  const rideIdFilter = hasRideIdFilter ? "AND r.id = $4" : "";

  return `
    WITH ride_window AS (
      SELECT
        r.id AS ride_id,
        r.user_id AS driver_id,
        r.start_location,
        r.end_location,
        r.ride_date,
        TO_CHAR(r.start_time, 'HH24:MI:SS') AS start_time,
        u.name AS driver_name,
        u.avatar_id AS driver_avatar_id,
        (
          ((r.ride_date)::text || ' ' || COALESCE((r.start_time)::text, '00:00:00'))::timestamp
          AT TIME ZONE $1
        ) AS ride_starts_at
      FROM rides r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.user_id IS NOT NULL
        AND r.status = ANY($2::text[])
        AND r.ride_date IS NOT NULL
        AND r.start_time IS NOT NULL
        ${rideIdFilter}
    )
    SELECT
      rw.ride_id,
      rw.driver_id,
      rw.driver_name,
      rw.driver_avatar_id,
      rw.start_location,
      rw.end_location,
      rw.ride_date,
      rw.start_time,
      rw.driver_id AS target_user_id,
      NULL::int AS booking_id,
      'driver'::text AS role
    FROM ride_window rw
    LEFT JOIN ride_presence rp
      ON rp.ride_id = rw.ride_id
     AND rp.user_id = rw.driver_id
    WHERE rw.ride_starts_at > NOW()
      AND rw.ride_starts_at <= NOW() + ($3 * INTERVAL '1 minute')
      AND rp.arrived_at IS NULL

    UNION ALL

    SELECT
      rw.ride_id,
      rw.driver_id,
      rw.driver_name,
      rw.driver_avatar_id,
      rw.start_location,
      rw.end_location,
      rw.ride_date,
      rw.start_time,
      b.user_id AS target_user_id,
      b.id AS booking_id,
      'rider'::text AS role
    FROM ride_window rw
    JOIN bookings b ON b.ride_id = rw.ride_id
    LEFT JOIN ride_presence rp
      ON rp.ride_id = rw.ride_id
     AND rp.user_id = b.user_id
    WHERE rw.ride_starts_at > NOW()
      AND rw.ride_starts_at <= NOW() + ($3 * INTERVAL '1 minute')
      AND b.user_id IS NOT NULL
      AND LOWER(COALESCE(b.status, 'pending')) = 'approved'
      AND rp.arrived_at IS NULL

    ORDER BY ride_id ASC, role ASC, booking_id ASC NULLS FIRST
  `;
}

async function loadReminderCandidates(client, rideId = null) {
  const params = [
    getRideTimezone(),
    ACTIVE_RIDE_STATUSES,
    getReminderLeadMinutes(),
  ];

  if (Number.isFinite(Number(rideId)) && Number(rideId) > 0) {
    params.push(Number(rideId));
  }

  const result = await client.query(
    buildReminderCandidatesQuery(params.length === 4),
    params
  );

  return result.rows;
}

async function createReminderNotification(candidate) {
  const rideId = Number(candidate?.ride_id);
  const userId = Number(candidate?.target_user_id);
  const bookingId = Number(candidate?.booking_id);
  const role =
    String(candidate?.role || "").trim().toLowerCase() === "driver"
      ? "driver"
      : "rider";

  if (!Number.isFinite(rideId) || rideId <= 0) {
    return null;
  }

  if (!Number.isFinite(userId) || userId <= 0) {
    return null;
  }

  const driverId = Number(candidate?.driver_id);
  const driverName = normalizeText(candidate?.driver_name);

  return createNotification({
    userId,
    title: buildReminderTitle(),
    body: buildReminderBody(candidate),
    type: REMINDER_TYPE,
    relatedId: rideId,
    fromUserId:
      role === "rider" && Number.isFinite(driverId) && driverId > 0
        ? driverId
        : null,
    fromUserName: role === "rider" ? driverName || "Жолооч" : "OneWay",
    fromAvatarId: role === "rider" ? candidate?.driver_avatar_id || null : null,
    rideId,
    bookingId: Number.isFinite(bookingId) && bookingId > 0 ? bookingId : null,
    role,
    sound: REMINDER_SOUND,
    channelId: REMINDER_CHANNEL_ID,
    data: {
      rideId,
      bookingId: Number.isFinite(bookingId) && bookingId > 0 ? bookingId : null,
      role,
      promptLocation: "meetup",
      reminderSource: "backend",
      screen: "/ride/[id]",
    },
  });
}

async function runReminderDispatch(client, rideId = null) {
  const candidates = await loadReminderCandidates(client, rideId);
  let sentCount = 0;

  for (const candidate of candidates) {
    try {
      const created = await createReminderNotification(candidate);
      if (created?.created) {
        sentCount += 1;
      }
    } catch (error) {
      console.error(
        "ride reminder notification error:",
        error?.message || error
      );
    }
  }

  return sentCount;
}

async function getBookingAttendanceMeta(client) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'bookings'
        AND column_name IN (
          'attendance_status',
          'attendance_marked_at',
          'attendance_marked_by'
        )`
  );
  const columns = new Set(result.rows.map((row) => row.column_name));

  return {
    hasAttendanceStatus: columns.has("attendance_status"),
    hasAttendanceMarkedAt: columns.has("attendance_marked_at"),
    hasAttendanceMarkedBy: columns.has("attendance_marked_by"),
  };
}

async function getBookingSeatExpression(client) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'bookings'
        AND column_name IN ('seats', 'seats_booked')`
  );
  const columns = new Set(result.rows.map((row) => row.column_name));

  if (columns.has("seats")) {
    return "COALESCE(b.seats, 1)";
  }
  if (columns.has("seats_booked")) {
    return "COALESCE(b.seats_booked, 1)";
  }
  return "1";
}

async function markLateUnverifiedPassengersNoShow(client) {
  const meta = await getBookingAttendanceMeta(client);
  if (!meta.hasAttendanceStatus) {
    return 0;
  }

  const setParts = ["attendance_status = 'no_show'"];
  if (meta.hasAttendanceMarkedAt) {
    setParts.push("attendance_marked_at = COALESCE(attendance_marked_at, NOW())");
  }
  const result = await client.query(
    `WITH ride_window AS (
       SELECT
         r.id AS ride_id,
         (
           ((r.ride_date)::text || ' ' || COALESCE((r.start_time)::text, '00:00:00'))::timestamp
           AT TIME ZONE $1
         ) AS ride_starts_at
       FROM rides r
       WHERE r.status = ANY($2::text[])
         AND r.ride_date IS NOT NULL
         AND r.start_time IS NOT NULL
     )
     UPDATE bookings b
        SET ${setParts.join(", ")}
       FROM ride_window rw
      WHERE b.ride_id = rw.ride_id
        AND rw.ride_starts_at <= NOW() - ($3 * INTERVAL '1 minute')
        AND LOWER(COALESCE(b.status, 'pending')) = 'approved'
        AND LOWER(COALESCE(b.attendance_status, 'unknown')) NOT IN ('arrived', 'no_show')
        AND NOT EXISTS (
          SELECT 1
            FROM ride_presence rp
           WHERE rp.ride_id = b.ride_id
             AND rp.user_id = b.user_id
             AND rp.arrived_at IS NOT NULL
        )`,
    [getRideTimezone(), NO_SHOW_RIDE_STATUSES, getNoShowGraceMinutes()]
  );

  return result.rowCount || 0;
}

function buildRideStartedNotificationBody(ride) {
  const startLocation = normalizeText(ride?.start_location);
  const endLocation = normalizeText(ride?.end_location);

  if (startLocation && endLocation) {
    return `${startLocation} цэг дээр баг бүрдлээ. ${endLocation} чиглэлийн OneWay амжилттай эхэллээ.`;
  }
  if (startLocation) {
    return `${startLocation} цэг дээр баг бүрдлээ. OneWay амжилттай эхэллээ.`;
  }
  if (endLocation) {
    return `${endLocation} чиглэлийн OneWay амжилттай эхэллээ.`;
  }
  return "OneWay аялал амжилттай эхэллээ.";
}

async function startReadyRidesAfterNoShow(client) {
  const seatExpr = await getBookingSeatExpression(client);
  const result = await client.query(
    `WITH approved AS (
       SELECT
         b.ride_id,
         SUM(${seatExpr})::int AS approved_seats,
         SUM(
           CASE
             WHEN rp.pin_confirmed_at IS NOT NULL THEN ${seatExpr}
             ELSE 0
           END
         )::int AS confirmed_seats,
         SUM(
           CASE
             WHEN LOWER(COALESCE(b.attendance_status, 'unknown')) = 'no_show' THEN ${seatExpr}
             ELSE 0
           END
         )::int AS no_show_seats
       FROM bookings b
       LEFT JOIN ride_presence rp
         ON rp.ride_id = b.ride_id
        AND rp.user_id = b.user_id
       WHERE LOWER(COALESCE(b.status, 'pending')) = 'approved'
       GROUP BY b.ride_id
     ),
     ready AS (
       SELECT r.id
       FROM rides r
       JOIN approved a ON a.ride_id = r.id
       JOIN ride_presence driver_presence
         ON driver_presence.ride_id = r.id
        AND driver_presence.user_id = r.user_id
        AND driver_presence.arrived_at IS NOT NULL
       WHERE r.status = ANY($1::text[])
         AND a.approved_seats > 0
         AND a.confirmed_seats > 0
         AND a.confirmed_seats + a.no_show_seats >= a.approved_seats
     )
     UPDATE rides r
        SET status = 'started'
       FROM ready
      WHERE r.id = ready.id
      RETURNING
        r.id,
        r.user_id,
        r.start_location,
        r.end_location`,
    [NO_SHOW_RIDE_STATUSES]
  );

  for (const ride of result.rows) {
    const driverResult = await client.query(
      `SELECT name, avatar_id
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [Number(ride.user_id)]
    );
    const driver = driverResult.rows[0] || {};
    const bookings = await client.query(
      `SELECT b.id, b.user_id
         FROM bookings b
        WHERE b.ride_id = $1
          AND LOWER(COALESCE(b.status, 'pending')) = 'approved'
          AND LOWER(COALESCE(b.attendance_status, 'unknown')) <> 'no_show'`,
      [Number(ride.id)]
    );
    const title = "OneWay аялал амжилттай эхэллээ";
    const body = buildRideStartedNotificationBody(ride);
    const driverName = normalizeText(driver.name) || "Жолооч";

    await createNotification({
      userId: Number(ride.user_id),
      title,
      body,
      type: "ride_started_auto",
      relatedId: Number(ride.id),
      fromUserId: Number(ride.user_id),
      fromUserName: driverName,
      fromAvatarId: driver.avatar_id || null,
      rideId: Number(ride.id),
      role: "driver",
    });

    for (const booking of bookings.rows) {
      await createNotification({
        userId: Number(booking.user_id),
        title,
        body,
        type: "ride_started_auto",
        relatedId: Number(ride.id),
        fromUserId: Number(ride.user_id),
        fromUserName: driverName,
        fromAvatarId: driver.avatar_id || null,
        rideId: Number(ride.id),
        bookingId: Number(booking.id),
        role: "rider",
      });
    }
  }

  return result.rowCount || 0;
}

async function withAdvisoryLock(task) {
  const client = await pool.connect();

  try {
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [REMINDER_ADVISORY_LOCK_ID]
    );
    const acquired = Boolean(lockResult.rows[0]?.acquired);

    if (!acquired) {
      return 0;
    }

    try {
      return await task(client);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [REMINDER_ADVISORY_LOCK_ID])
        .catch(() => null);
    }
  } finally {
    client.release();
  }
}

async function runScheduledRideMaintenance() {
  return withAdvisoryLock(async (client) => {
    const reminderCount = await runReminderDispatch(client);
    const noShowCount = await markLateUnverifiedPassengersNoShow(client);
    const startedCount = await startReadyRidesAfterNoShow(client);

    return { reminderCount, noShowCount, startedCount };
  });
}

async function sendRideReminderNotifications({
  rideId = null,
  useAdvisoryLock = false,
} = {}) {
  const execute = async (client) => runReminderDispatch(client, rideId);

  if (useAdvisoryLock) {
    return withAdvisoryLock(execute);
  }

  const client = await pool.connect();
  try {
    return await execute(client);
  } finally {
    client.release();
  }
}

function queueReminderSweep() {
  if (runInFlight) {
    return runInFlight;
  }

  runInFlight = runScheduledRideMaintenance()
    .then((result) => {
      const reminderCount = Number(result?.reminderCount || 0);
      const noShowCount = Number(result?.noShowCount || 0);
      const startedCount = Number(result?.startedCount || 0);

      if (reminderCount > 0) {
        console.log(`ride reminders queued: ${reminderCount}`);
      }
      if (noShowCount > 0) {
        console.log(`late passengers marked no-show: ${noShowCount}`);
      }
      if (startedCount > 0) {
        console.log(`rides auto-started after no-show grace: ${startedCount}`);
      }

      return reminderCount;
    })
    .catch((error) => {
      console.error("ride scheduled maintenance failed:", error?.message || error);
      return 0;
    })
    .finally(() => {
      runInFlight = null;
    });

  return runInFlight;
}

function startRideReminderScheduler() {
  if (isSchedulerDisabled()) {
    console.log("ride reminder scheduler disabled by env");
    return null;
  }

  if (schedulerTimer) {
    return schedulerTimer;
  }

  const startupDelayMs = getReminderStartupDelayMs();
  const pollMs = getReminderPollMs();

  setTimeout(() => {
    void queueReminderSweep();
  }, startupDelayMs);

  schedulerTimer = setInterval(() => {
    void queueReminderSweep();
  }, pollMs);

  console.log(
    `ride reminder scheduler started (lead=${getReminderLeadMinutes()}m, poll=${pollMs}ms, tz=${getRideTimezone()})`
  );

  return schedulerTimer;
}

module.exports = {
  startRideReminderScheduler,
  sendRideReminderNotifications,
};
