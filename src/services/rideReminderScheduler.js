const pool = require("../db");
const { createNotification } = require("../utils/notify");

const REMINDER_TYPE = "ride_reminder";
const ACTIVE_RIDE_STATUSES = ["active", "full", "scheduled", "pending"];
const REMINDER_ADVISORY_LOCK_ID = 58420317;
const DEFAULT_RIDE_TIMEZONE = "Asia/Ulaanbaatar";
const DEFAULT_LEAD_MINUTES = 10;
const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5 * 1000;

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
    WHERE rw.ride_starts_at > NOW()
      AND rw.ride_starts_at <= NOW() + ($3 * INTERVAL '1 minute')

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
    WHERE rw.ride_starts_at > NOW()
      AND rw.ride_starts_at <= NOW() + ($3 * INTERVAL '1 minute')
      AND b.user_id IS NOT NULL
      AND LOWER(COALESCE(b.status, 'pending')) = 'approved'

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

  runInFlight = sendRideReminderNotifications({ useAdvisoryLock: true })
    .then((sentCount) => {
      if (sentCount > 0) {
        console.log(`ride reminders queued: ${sentCount}`);
      }

      return sentCount;
    })
    .catch((error) => {
      console.error("ride reminder sweep failed:", error?.message || error);
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
