const pool = require("../db");
const crypto = require("crypto");
const { createNotification } = require("../utils/notify");
const { haversineMeters } = require("../utils/rideSearch");

const START_RADIUS_METERS = 15;
const TRACKING_WINDOW_BEFORE_MINUTES = 30;
const TRACKING_WINDOW_AFTER_MINUTES = 90;
const MAX_ALLOWED_ACCURACY_METERS = 80;
const MEETUP_PIN_LENGTH = 4;
const MEETUP_PIN_REGEX = /^\d{4}$/;

const NON_TRACKABLE_RIDE_STATUSES = new Set(["completed", "cancelled", "canceled"]);
const STARTABLE_RIDE_STATUSES = ["active", "full", "scheduled", "pending"];

let ridePresencePinColumnsReady = false;

async function ensureRidePresencePinColumns(client) {
  if (ridePresencePinColumnsReady) {
    return;
  }

  await client.query(
    "ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS pin_confirmed_at TIMESTAMP"
  );
  await client.query(
    "ALTER TABLE ride_presence ADD COLUMN IF NOT EXISTS pin_confirmed_by INT REFERENCES users(id) ON DELETE SET NULL"
  );

  ridePresencePinColumnsReady = true;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "driver" ? "driver" : "rider";
}

function normalizePersonName(name, fallback = "Жолооч") {
  const value = String(name || "").trim();
  return value || fallback;
}

function normalizeLocationLabel(value) {
  const label = String(value || "").trim();
  return label || null;
}

function getRideStartDate(ride) {
  const rideDate = String(ride?.ride_date || "").trim();
  const rawTime = String(ride?.start_time || "").trim();

  if (!rideDate || !rawTime) {
    return null;
  }

  const timeValue = /^\d{2}:\d{2}$/.test(rawTime) ? `${rawTime}:00` : rawTime;
  const date = new Date(`${rideDate}T${timeValue}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinTrackingWindow(ride, now = new Date()) {
  const startDate = getRideStartDate(ride);
  if (!startDate) {
    return true;
  }

  const startsAt = startDate.getTime();
  const windowOpenAt = startsAt - TRACKING_WINDOW_BEFORE_MINUTES * 60 * 1000;
  const windowCloseAt = startsAt + TRACKING_WINDOW_AFTER_MINUTES * 60 * 1000;
  const currentTime = now.getTime();

  return currentTime >= windowOpenAt && currentTime <= windowCloseAt;
}

function roundDistance(value) {
  if (value === null || typeof value === "undefined" || value === "") {
    return null;
  }

  const distance = Number(value);
  if (!Number.isFinite(distance)) {
    return null;
  }

  return Math.round(distance * 10) / 10;
}

function normalizeMeetupPin(value) {
  return String(value ?? "").replace(/\D/g, "").trim();
}

function normalizeDateSeed(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function buildMeetupPin(ride) {
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || "oneway-meetup-pin";
  const createdAt = normalizeDateSeed(ride?.created_at);
  const seed = [
    Number(ride?.id) || 0,
    Number(ride?.user_id) || 0,
    createdAt,
    String(ride?.ride_date || ""),
    String(ride?.start_time || ""),
  ].join(":");
  const digest = crypto.createHmac("sha256", secret).update(seed).digest("hex");
  const numeric = parseInt(digest.slice(0, 8), 16) % 10 ** MEETUP_PIN_LENGTH;

  return String(numeric).padStart(MEETUP_PIN_LENGTH, "0");
}

function getEffectiveStartRadiusMeters() {
  return START_RADIUS_METERS;
}

function buildRideStartedNotificationBody(ride) {
  const startLocation = normalizeLocationLabel(ride?.start_location);
  const endLocation = normalizeLocationLabel(ride?.end_location);

  if (startLocation && endLocation) {
    return `${startLocation} цэг дээр баг бүрдлээ. ${endLocation} чиглэлийн OneWay амжилттай эхэллээ.`;
  }

  if (startLocation) {
    return `${startLocation} цэг дээр баг бүрдлээ. OneWay амжилттай эхэллээ.`;
  }

  if (endLocation) {
    return `${endLocation} чиглэлийн OneWay амжилттай эхэллээ.`;
  }

  return "Бүгд уулзах цэг дээрээ ирлээ. OneWay амжилттай эхэллээ.";
}

function buildMeetupCheckInNotifications({ ride, actor, approvedBookings }) {
  const rideId = Number(ride.id);
  const driverId = Number(ride.user_id);
  const driverName = normalizePersonName(ride.driver_name);

  if (actor.role === "driver") {
    return approvedBookings.map((booking) => ({
      userId: Number(booking.user_id),
      title: "Жолооч уулзах цэг дээр ирлээ",
      body: "Жолооч уулзах цэг дээр ирлээ. PIN кодоо аваад ирцээ баталгаажуулна уу.",
      type: "meetup_driver_checked_in",
      relatedId: rideId,
      fromUserId: driverId,
      fromUserName: driverName,
      fromAvatarId: ride.driver_avatar_id || null,
      rideId,
      bookingId: Number(booking.id),
      role: "rider",
    }));
  }

  const riderBooking = approvedBookings.find(
    (booking) => Number(booking.user_id) === Number(actor.user_id)
  );
  const riderName = normalizePersonName(riderBooking?.name, "Зорчигч");

  return [
    {
      userId: driverId,
      title: "Зорчигч уулзах цэг дээр ирлээ",
      body: `${riderName} уулзах цэг дээр ирлээ. PIN баталгаажуулалт хүлээж байна.`,
      type: "meetup_rider_checked_in",
      relatedId: rideId,
      fromUserId: Number(actor.user_id),
      fromUserName: riderName,
      fromAvatarId: riderBooking?.avatar_id || null,
      rideId,
      bookingId: Number(actor.booking_id) || null,
      role: "driver",
    },
  ];
}

function buildPresenceSummary({ ride, approvedBookings, presenceByUserId }) {
  const driverPresence = presenceByUserId.get(Number(ride.user_id)) || null;
  const driverArrived = Boolean(driverPresence?.arrived_at);
  const approvedPassengerCount = approvedBookings.length;

  const locationVerifiedPassengerCount = approvedBookings.filter((booking) => {
    const row = presenceByUserId.get(Number(booking.user_id));
    return Boolean(row?.arrived_at);
  }).length;

  const arrivedPassengerCount = approvedBookings.filter((booking) => {
    const row = presenceByUserId.get(Number(booking.user_id));
    return Boolean(row?.pin_confirmed_at) || normalizeStatus(booking.attendance_status) === "arrived";
  }).length;

  const everyoneArrived =
    driverArrived &&
    approvedPassengerCount > 0 &&
    arrivedPassengerCount === approvedPassengerCount;

  return {
    driver_arrived: driverArrived,
    approved_passenger_count: approvedPassengerCount,
    location_verified_passenger_count: locationVerifiedPassengerCount,
    confirmed_passenger_count: arrivedPassengerCount,
    arrived_passenger_count: arrivedPassengerCount,
    ready_to_start: everyoneArrived,
  };
}

async function loadRideAccess(client, rideId, userId) {
  const rideRes = await client.query(
    `SELECT r.id,
            r.user_id,
            r.status,
            r.start_lat,
            r.start_lng,
            r.start_location,
            r.end_location,
            to_char(r.ride_date, 'YYYY-MM-DD') AS ride_date,
            r.start_time,
            r.created_at,
            u.name AS driver_name,
            u.avatar_id AS driver_avatar_id
       FROM rides r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.id = $1
      FOR UPDATE OF r`,
    [rideId]
  );

  if (rideRes.rowCount === 0) {
    return { error: { status: 404, body: { error: "Ride not found" } } };
  }

  const ride = rideRes.rows[0];
  const rideStatus = normalizeStatus(ride.status);
  if (NON_TRACKABLE_RIDE_STATUSES.has(rideStatus)) {
    return {
      error: {
        status: 400,
        body: { error: "Ride meetup tracking is not available for this ride" },
      },
    };
  }

  if (!isWithinTrackingWindow(ride)) {
    return {
      error: {
        status: 409,
        body: { error: "Ride meetup tracking window is not active yet" },
      },
    };
  }

  if (Number(ride.user_id) === Number(userId)) {
    return {
      ride,
      actor: {
        user_id: Number(userId),
        role: "driver",
        booking_id: null,
        booking_status: null,
        attendance_status: null,
      },
    };
  }

  const bookingRes = await client.query(
    `SELECT b.id,
            b.ride_id,
            b.user_id,
            b.status AS booking_status,
            COALESCE(b.attendance_status, 'unknown') AS attendance_status
       FROM bookings b
      WHERE b.ride_id = $1
        AND b.user_id = $2
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT 1
      FOR UPDATE`,
    [rideId, userId]
  );

  if (bookingRes.rowCount === 0) {
    return {
      error: { status: 403, body: { error: "Only ride participants can share meetup location" } },
    };
  }

  const booking = bookingRes.rows[0];
  if (normalizeStatus(booking.booking_status) !== "approved") {
    return {
      error: {
        status: 403,
        body: { error: "Only approved bookings can share meetup location" },
      },
    };
  }

  return {
    ride,
    actor: {
      user_id: Number(userId),
      role: "rider",
      booking_id: Number(booking.id),
      booking_status: booking.booking_status,
      attendance_status: booking.attendance_status,
    },
  };
}

async function getApprovedBookings(client, rideId) {
  const result = await client.query(
    `SELECT b.id,
            b.user_id,
            COALESCE(b.attendance_status, 'unknown') AS attendance_status,
            u.name,
            u.avatar_id
       FROM bookings b
       LEFT JOIN users u ON u.id = b.user_id
      WHERE b.ride_id = $1
        AND COALESCE(b.status, 'pending') = 'approved'
      ORDER BY b.created_at ASC, b.id ASC
      FOR UPDATE OF b`,
    [rideId]
  );

  return result.rows.map((row) => ({
    ...row,
    id: Number(row.id),
    user_id: Number(row.user_id),
  }));
}

async function getPresenceRows(client, rideId) {
  const result = await client.query(
    `SELECT *
       FROM ride_presence
      WHERE ride_id = $1
      FOR UPDATE`,
    [rideId]
  );

  const byUserId = new Map();
  for (const row of result.rows) {
    byUserId.set(Number(row.user_id), row);
  }

  return byUserId;
}

async function upsertPresenceRow(client, payload) {
  const result = await client.query(
    `INSERT INTO ride_presence (
       ride_id,
       user_id,
       booking_id,
       role,
       latitude,
       longitude,
       accuracy_meters,
       distance_to_start_meters,
       distance_to_driver_meters,
       within_start_radius,
       within_driver_radius,
       source,
       dwell_started_at,
       arrived_at,
       pin_confirmed_at,
       pin_confirmed_by,
       last_seen_at,
       updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW()
     )
     ON CONFLICT (ride_id, user_id)
     DO UPDATE SET
       booking_id = EXCLUDED.booking_id,
       role = EXCLUDED.role,
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       accuracy_meters = EXCLUDED.accuracy_meters,
       distance_to_start_meters = EXCLUDED.distance_to_start_meters,
       distance_to_driver_meters = EXCLUDED.distance_to_driver_meters,
       within_start_radius = EXCLUDED.within_start_radius,
       within_driver_radius = EXCLUDED.within_driver_radius,
       source = EXCLUDED.source,
       dwell_started_at = EXCLUDED.dwell_started_at,
       arrived_at = EXCLUDED.arrived_at,
       pin_confirmed_at = COALESCE(EXCLUDED.pin_confirmed_at, ride_presence.pin_confirmed_at),
       pin_confirmed_by = COALESCE(EXCLUDED.pin_confirmed_by, ride_presence.pin_confirmed_by),
       last_seen_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      payload.ride_id,
      payload.user_id,
      payload.booking_id,
      payload.role,
      payload.latitude,
      payload.longitude,
      payload.accuracy_meters,
      payload.distance_to_start_meters,
      payload.distance_to_driver_meters,
      payload.within_start_radius,
      payload.within_driver_radius,
      payload.source,
      payload.dwell_started_at,
      payload.arrived_at,
      payload.pin_confirmed_at,
      payload.pin_confirmed_by,
    ]
  );

  return result.rows[0];
}

async function markPassengerArrived(client, bookingId, markedByUserId = null) {
  if (!Number.isFinite(Number(bookingId)) || Number(bookingId) <= 0) {
    return;
  }

  await client.query(
    `UPDATE bookings
        SET attendance_status = 'arrived',
            attendance_marked_at = COALESCE(attendance_marked_at, NOW()),
            attendance_marked_by = COALESCE(attendance_marked_by, $2)
      WHERE id = $1
        AND COALESCE(attendance_status, 'unknown') <> 'arrived'`,
    [bookingId, markedByUserId]
  );
}

async function maybeStartRide(client, ride, approvedBookings, summary) {
  let rideStarted = false;
  let pendingNotifications = [];
  const rideStatus = normalizeStatus(ride.status);

  if (!summary.ready_to_start || !STARTABLE_RIDE_STATUSES.includes(rideStatus)) {
    return { rideStarted, pendingNotifications };
  }

  const startRes = await client.query(
    `UPDATE rides
        SET status = 'started'
      WHERE id = $1
        AND status = ANY($2::text[])
    RETURNING id, status`,
    [Number(ride.id), STARTABLE_RIDE_STATUSES]
  );

  rideStarted = startRes.rowCount > 0;

  if (rideStarted) {
    const driverName = normalizePersonName(ride.driver_name);
    const title = "OneWay аялал амжилттай эхэллээ";
    const body = buildRideStartedNotificationBody(ride);

    pendingNotifications = [
      {
        userId: Number(ride.user_id),
        title,
        body,
        type: "ride_started_auto",
        relatedId: Number(ride.id),
        fromUserId: Number(ride.user_id),
        fromUserName: driverName,
        fromAvatarId: ride.driver_avatar_id || null,
        rideId: Number(ride.id),
        role: "driver",
      },
      ...approvedBookings.map((booking) => ({
        userId: Number(booking.user_id),
        title,
        body,
        type: "ride_started_auto",
        relatedId: Number(ride.id),
        fromUserId: Number(ride.user_id),
        fromUserName: driverName,
        fromAvatarId: ride.driver_avatar_id || null,
        rideId: Number(ride.id),
        bookingId: Number(booking.id),
        role: "rider",
      })),
    ];
  }

  return { rideStarted, pendingNotifications };
}

async function buildPresenceResponse(client, ride, actor) {
  const approvedBookings = await client.query(
    `SELECT b.id,
            b.user_id,
            COALESCE(b.attendance_status, 'unknown') AS attendance_status,
            u.name,
            u.avatar_id
       FROM bookings b
       LEFT JOIN users u ON u.id = b.user_id
      WHERE b.ride_id = $1
        AND COALESCE(b.status, 'pending') = 'approved'
      ORDER BY b.created_at ASC, b.id ASC`,
    [Number(ride.id)]
  );

  const presenceRes = await client.query(
    `SELECT rp.*,
            u.name,
            u.avatar_id
       FROM ride_presence rp
       LEFT JOIN users u ON u.id = rp.user_id
      WHERE rp.ride_id = $1
      ORDER BY CASE WHEN rp.role = 'driver' THEN 0 ELSE 1 END, rp.id ASC`,
    [Number(ride.id)]
  );

  const presenceByUserId = new Map();
  for (const row of presenceRes.rows) {
    presenceByUserId.set(Number(row.user_id), row);
  }

  const summary = buildPresenceSummary({
    ride,
    approvedBookings: approvedBookings.rows,
    presenceByUserId,
  });
  const driverPresence = presenceByUserId.get(Number(ride.user_id)) || null;
  const driverLocationVerified = Boolean(driverPresence?.arrived_at);
  const actorPresence = presenceByUserId.get(Number(actor?.user_id)) || null;

  return {
    ride_id: Number(ride.id),
    ride_status: String(ride.status || ""),
    actor_role: normalizeRole(actor?.role),
    actor_location_verified: Boolean(actorPresence?.arrived_at),
    actor_pin_confirmed: Boolean(actorPresence?.pin_confirmed_at),
    driver_location_verified: driverLocationVerified,
    pin_confirmation_enabled: true,
    meetup_pin_length: MEETUP_PIN_LENGTH,
    meetup_code:
      normalizeRole(actor?.role) === "driver" && driverLocationVerified
        ? buildMeetupPin(ride)
        : null,
    required_start_radius_meters: START_RADIUS_METERS,
    summary,
    participants: [
      {
        user_id: Number(ride.user_id),
        role: "driver",
        booking_id: null,
        name: normalizePersonName(ride.driver_name),
        avatar_id: ride.driver_avatar_id || null,
        attendance_status: summary.driver_arrived ? "arrived" : "unknown",
        location_verified: driverLocationVerified,
        location_verified_at: driverPresence?.arrived_at || null,
        arrived: driverLocationVerified,
        arrived_at: driverPresence?.arrived_at || null,
        pin_confirmed: false,
        pin_confirmed_at: null,
        pin_confirmed_by: null,
        last_seen_at: driverPresence?.last_seen_at || null,
        distance_to_start_meters: roundDistance(driverPresence?.distance_to_start_meters),
        distance_to_driver_meters: null,
        source: driverPresence?.source || null,
      },
      ...approvedBookings.rows.map((booking) => {
        const row = presenceByUserId.get(Number(booking.user_id)) || null;
        const locationVerified = Boolean(row?.arrived_at);
        const pinConfirmed = Boolean(row?.pin_confirmed_at);
        const attendanceArrived = normalizeStatus(booking.attendance_status) === "arrived";
        return {
          user_id: Number(booking.user_id),
          role: "rider",
          booking_id: Number(booking.id),
          name: normalizePersonName(booking.name, "Зорчигч"),
          avatar_id: booking.avatar_id || null,
          attendance_status: String(booking.attendance_status || "unknown"),
          location_verified: locationVerified,
          location_verified_at: row?.arrived_at || null,
          arrived: pinConfirmed || attendanceArrived,
          arrived_at: row?.arrived_at || null,
          pin_confirmed: pinConfirmed,
          pin_confirmed_at: row?.pin_confirmed_at || null,
          pin_confirmed_by: row?.pin_confirmed_by ? Number(row.pin_confirmed_by) : null,
          last_seen_at: row?.last_seen_at || null,
          distance_to_start_meters: roundDistance(row?.distance_to_start_meters),
          distance_to_driver_meters: roundDistance(row?.distance_to_driver_meters),
          source: row?.source || null,
        };
      }),
    ],
  };
}

exports.syncRideMeetupPresence = async (req, res) => {
  const rideId = Number(req.params.id);
  const userId = Number(req.user.id);
  const latitude = toNumber(req.body?.latitude ?? req.body?.lat);
  const longitude = toNumber(req.body?.longitude ?? req.body?.lng);
  const accuracyMeters = toNumber(req.body?.accuracy);
  const checkInRequested =
    req.body?.check_in === true ||
    req.body?.checkIn === true ||
    String(req.body?.action || "").trim().toLowerCase() === "check_in";

  if (!Number.isFinite(rideId) || rideId <= 0) {
    return res.status(400).json({ error: "Invalid ride id" });
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: "Valid latitude and longitude are required" });
  }

  if (Number.isFinite(accuracyMeters) && Number(accuracyMeters) > MAX_ALLOWED_ACCURACY_METERS) {
    return res.status(400).json({
      error: "Location accuracy is too low. Please move to open sky and try again.",
    });
  }

  const client = await pool.connect();
  let pendingNotifications = [];

  try {
    await ensureRidePresencePinColumns(client);
    await client.query("BEGIN");

    const access = await loadRideAccess(client, rideId, userId);
    if (access.error) {
      await client.query("ROLLBACK");
      return res.status(access.error.status).json(access.error.body);
    }

    const { ride, actor } = access;
    const approvedBookings = await getApprovedBookings(client, rideId);
    const presenceByUserId = await getPresenceRows(client, rideId);

    const now = new Date();
    const currentPresence = presenceByUserId.get(userId) || null;
    const distanceToStart = haversineMeters(
      { lat: latitude, lng: longitude },
      { lat: ride.start_lat, lng: ride.start_lng }
    );

    const withinStartRadius =
      Number.isFinite(distanceToStart) &&
      distanceToStart <= getEffectiveStartRadiusMeters();

    let dwellStartedAt = currentPresence?.dwell_started_at || null;
    let arrivedAt = currentPresence?.arrived_at || null;

    if (checkInRequested) {
      if (!withinStartRadius) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Уулзах цэгээс ${START_RADIUS_METERS}м дотор байж ирснээ баталгаажуулна уу.`,
          distance_to_start_meters: roundDistance(distanceToStart),
          required_start_radius_meters: START_RADIUS_METERS,
        });
      }

      if (!arrivedAt) {
        arrivedAt = now.toISOString();
      }
      dwellStartedAt = dwellStartedAt || arrivedAt;
    }

    const source = checkInRequested
      ? "manual_location_check"
      : "none";

    const upsertedPresence = await upsertPresenceRow(client, {
      ride_id: rideId,
      user_id: userId,
      booking_id: actor.booking_id,
      role: actor.role,
      latitude,
      longitude,
      accuracy_meters: accuracyMeters,
      distance_to_start_meters: Number.isFinite(distanceToStart) ? distanceToStart : null,
      distance_to_driver_meters: null,
      within_start_radius: Boolean(withinStartRadius),
      within_driver_radius: false,
      source,
      dwell_started_at: dwellStartedAt,
      arrived_at: arrivedAt,
    });

    presenceByUserId.set(userId, upsertedPresence);

    const justLocationVerified =
      !currentPresence?.arrived_at && Boolean(upsertedPresence.arrived_at);
    if (justLocationVerified) {
      pendingNotifications.push(
        ...buildMeetupCheckInNotifications({ ride, actor, approvedBookings })
      );
    }

    const summary = buildPresenceSummary({
      ride,
      approvedBookings,
      presenceByUserId,
    });

    let rideStarted = false;
    const rideStatus = normalizeStatus(ride.status);
    if (
      summary.ready_to_start &&
      STARTABLE_RIDE_STATUSES.includes(rideStatus)
    ) {
      const startRes = await client.query(
        `UPDATE rides
            SET status = 'started'
          WHERE id = $1
            AND status = ANY($2::text[])
        RETURNING id, status`,
        [rideId, STARTABLE_RIDE_STATUSES]
      );

      rideStarted = startRes.rowCount > 0;

      if (rideStarted) {
        const driverName = normalizePersonName(ride.driver_name);
        const title = "OneWay амжилттай эхэллээ";
        const body = buildRideStartedNotificationBody(ride);

        pendingNotifications.push(
          {
            userId: Number(ride.user_id),
            title,
            body,
            type: "ride_started_auto",
            relatedId: Number(ride.id),
            fromUserId: Number(ride.user_id),
            fromUserName: driverName,
            fromAvatarId: ride.driver_avatar_id || null,
            rideId: Number(ride.id),
            role: "driver",
          },
          ...approvedBookings.map((booking) => ({
            userId: Number(booking.user_id),
            title,
            body,
            type: "ride_started_auto",
            relatedId: Number(ride.id),
            fromUserId: Number(ride.user_id),
            fromUserName: driverName,
            fromAvatarId: ride.driver_avatar_id || null,
            rideId: Number(ride.id),
            bookingId: Number(booking.id),
            role: "rider",
          }))
        );
      }
    }

    const presenceResponse = await buildPresenceResponse(
      client,
      { ...ride, status: rideStarted ? "started" : ride.status },
      actor
    );

    await client.query("COMMIT");

    await Promise.all(
      pendingNotifications.map((payload) => createNotification(payload))
    );

    return res.json({
      ...presenceResponse,
      success: true,
      ride_id: rideId,
      ride_status: rideStarted ? "started" : String(ride.status || ""),
      actor_role: actor.role,
      tracking: {
        source,
        check_in: Boolean(checkInRequested),
        within_start_radius: Boolean(withinStartRadius),
        distance_to_start_meters: roundDistance(distanceToStart),
        location_verified: Boolean(upsertedPresence.arrived_at),
        location_verified_at: upsertedPresence.arrived_at || null,
        arrived: Boolean(upsertedPresence.arrived_at),
        arrived_at: upsertedPresence.arrived_at || null,
        pin_confirmed: Boolean(upsertedPresence.pin_confirmed_at),
      },
      summary: presenceResponse.summary || summary,
      ride_started: rideStarted,
      required_start_radius_meters: START_RADIUS_METERS,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("sync ride meetup presence error:", err);
    return res.status(500).json({ error: "Failed to sync ride meetup presence" });
  } finally {
    client.release();
  }
};

exports.confirmRideMeetupPin = async (req, res) => {
  const rideId = Number(req.params.id);
  const userId = Number(req.user.id);
  const submittedPin = normalizeMeetupPin(req.body?.code ?? req.body?.pin);

  if (!Number.isFinite(rideId) || rideId <= 0) {
    return res.status(400).json({ error: "Invalid ride id" });
  }

  if (!MEETUP_PIN_REGEX.test(submittedPin)) {
    return res.status(400).json({ error: "A valid 4 digit meetup PIN is required" });
  }

  const client = await pool.connect();
  let pendingNotifications = [];

  try {
    await ensureRidePresencePinColumns(client);
    await client.query("BEGIN");

    const access = await loadRideAccess(client, rideId, userId);
    if (access.error) {
      await client.query("ROLLBACK");
      return res.status(access.error.status).json(access.error.body);
    }

    const { ride, actor } = access;

    if (actor.role !== "rider") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Only passengers can confirm the meetup PIN" });
    }

    if (submittedPin !== buildMeetupPin(ride)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid meetup PIN" });
    }

    const approvedBookings = await getApprovedBookings(client, rideId);
    const presenceByUserId = await getPresenceRows(client, rideId);
    const nowIso = new Date().toISOString();
    const currentPresence = presenceByUserId.get(userId) || null;
    const currentDriverPresence = presenceByUserId.get(Number(ride.user_id)) || null;

    if (!currentDriverPresence?.arrived_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Жолооч уулзах цэг дээр ирснээ баталгаажуулсны дараа PIN ашиглана.",
      });
    }

    if (!currentPresence?.arrived_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Эхлээд уулзах цэг дээр ирснээ location-аар баталгаажуулна уу.",
      });
    }

    const riderPresence = await upsertPresenceRow(client, {
      ride_id: rideId,
      user_id: userId,
      booking_id: actor.booking_id,
      role: "rider",
      latitude: currentPresence?.latitude ?? null,
      longitude: currentPresence?.longitude ?? null,
      accuracy_meters: currentPresence?.accuracy_meters ?? null,
      distance_to_start_meters: currentPresence?.distance_to_start_meters ?? null,
      distance_to_driver_meters: currentPresence?.distance_to_driver_meters ?? null,
      within_start_radius: Boolean(currentPresence?.within_start_radius),
      within_driver_radius: Boolean(currentPresence?.within_driver_radius),
      source: currentPresence?.source || "manual_location_check",
      dwell_started_at: currentPresence?.dwell_started_at || currentPresence?.arrived_at || nowIso,
      arrived_at: currentPresence.arrived_at,
      pin_confirmed_at: currentPresence?.pin_confirmed_at || nowIso,
      pin_confirmed_by: userId,
    });

    await markPassengerArrived(client, actor.booking_id, userId);
    presenceByUserId.set(userId, riderPresence);

    const summary = buildPresenceSummary({
      ride,
      approvedBookings,
      presenceByUserId,
    });

    const startResult = await maybeStartRide(client, ride, approvedBookings, summary);
    const rideStarted = startResult.rideStarted;
    pendingNotifications = startResult.pendingNotifications;
    const response = await buildPresenceResponse(
      client,
      { ...ride, status: rideStarted ? "started" : ride.status },
      actor
    );

    await client.query("COMMIT");

    await Promise.all(
      pendingNotifications.map((payload) => createNotification(payload))
    );

    return res.json({
      ...response,
      success: true,
      pin_confirmed: true,
      ride_started: rideStarted,
      ride_status: rideStarted ? "started" : response.ride_status,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("confirm ride meetup pin error:", err);
    return res.status(500).json({ error: "Failed to confirm meetup PIN" });
  } finally {
    client.release();
  }
};

exports.getRideMeetupPresence = async (req, res) => {
  const rideId = Number(req.params.id);
  const userId = Number(req.user.id);

  if (!Number.isFinite(rideId) || rideId <= 0) {
    return res.status(400).json({ error: "Invalid ride id" });
  }

  const client = await pool.connect();

  try {
    await ensureRidePresencePinColumns(client);
    const access = await loadRideAccess(client, rideId, userId);
    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const response = await buildPresenceResponse(client, access.ride, access.actor);
    return res.json(response);
  } catch (err) {
    console.error("get ride meetup presence error:", err);
    return res.status(500).json({ error: "Failed to load ride meetup presence" });
  } finally {
    client.release();
  }
};
