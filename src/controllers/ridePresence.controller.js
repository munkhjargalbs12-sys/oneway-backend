const pool = require("../db");
const { createNotification } = require("../utils/notify");
const { haversineMeters } = require("../utils/rideSearch");

const START_RADIUS_METERS = 20;
const DRIVER_RADIUS_METERS = 30;
const DWELL_SECONDS_REQUIRED = 5 * 60;
const DRIVER_FRESHNESS_SECONDS = 2 * 60;
const TRACKING_WINDOW_BEFORE_MINUTES = 30;
const TRACKING_WINDOW_AFTER_MINUTES = 90;
const MAX_ALLOWED_ACCURACY_METERS = 80;

const NON_TRACKABLE_RIDE_STATUSES = new Set(["completed", "cancelled", "canceled"]);
const STARTABLE_RIDE_STATUSES = ["active", "full", "scheduled", "pending"];

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

function isFreshTimestamp(value, now = new Date(), freshnessSeconds = DRIVER_FRESHNESS_SECONDS) {
  if (!value) {
    return false;
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return now.getTime() - timestamp <= freshnessSeconds * 1000;
}

function roundDistance(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 10) / 10;
}

function getEffectiveStartRadiusMeters(accuracyMeters) {
  if (!Number.isFinite(accuracyMeters)) {
    return START_RADIUS_METERS;
  }

  return Math.max(START_RADIUS_METERS, Math.min(Number(accuracyMeters), 35));
}

function getEffectiveDriverRadiusMeters(accuracyMeters) {
  if (!Number.isFinite(accuracyMeters)) {
    return DRIVER_RADIUS_METERS;
  }

  return Math.max(DRIVER_RADIUS_METERS, Math.min(Number(accuracyMeters), 45));
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

function buildPresenceSummary({ ride, approvedBookings, presenceByUserId }) {
  const driverPresence = presenceByUserId.get(Number(ride.user_id)) || null;
  const driverArrived = Boolean(driverPresence?.arrived_at);
  const approvedPassengerCount = approvedBookings.length;

  const arrivedPassengerCount = approvedBookings.filter((booking) => {
    const row = presenceByUserId.get(Number(booking.user_id));
    return Boolean(row?.arrived_at) || normalizeStatus(booking.attendance_status) === "arrived";
  }).length;

  const everyoneArrived =
    driverArrived &&
    approvedPassengerCount > 0 &&
    arrivedPassengerCount === approvedPassengerCount;

  return {
    driver_arrived: driverArrived,
    approved_passenger_count: approvedPassengerCount,
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
            r.ride_date,
            r.start_time,
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
       last_seen_at,
       updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW()
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
    ]
  );

  return result.rows[0];
}

async function markPassengerArrived(client, bookingId) {
  if (!Number.isFinite(Number(bookingId)) || Number(bookingId) <= 0) {
    return;
  }

  await client.query(
    `UPDATE bookings
        SET attendance_status = 'arrived',
            attendance_marked_at = COALESCE(attendance_marked_at, NOW())
      WHERE id = $1
        AND COALESCE(attendance_status, 'unknown') <> 'arrived'`,
    [bookingId]
  );
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

  return {
    ride_id: Number(ride.id),
    ride_status: String(ride.status || ""),
    actor_role: normalizeRole(actor?.role),
    required_start_radius_meters: START_RADIUS_METERS,
    required_driver_radius_meters: DRIVER_RADIUS_METERS,
    required_dwell_seconds: DWELL_SECONDS_REQUIRED,
    summary,
    participants: [
      {
        user_id: Number(ride.user_id),
        role: "driver",
        booking_id: null,
        name: normalizePersonName(ride.driver_name),
        avatar_id: ride.driver_avatar_id || null,
        attendance_status: summary.driver_arrived ? "arrived" : "unknown",
        arrived: Boolean(presenceByUserId.get(Number(ride.user_id))?.arrived_at),
        arrived_at: presenceByUserId.get(Number(ride.user_id))?.arrived_at || null,
        last_seen_at: presenceByUserId.get(Number(ride.user_id))?.last_seen_at || null,
        distance_to_start_meters: roundDistance(
          Number(presenceByUserId.get(Number(ride.user_id))?.distance_to_start_meters)
        ),
        distance_to_driver_meters: null,
        source: presenceByUserId.get(Number(ride.user_id))?.source || null,
      },
      ...approvedBookings.rows.map((booking) => {
        const row = presenceByUserId.get(Number(booking.user_id)) || null;
        return {
          user_id: Number(booking.user_id),
          role: "rider",
          booking_id: Number(booking.id),
          name: normalizePersonName(booking.name, "Зорчигч"),
          avatar_id: booking.avatar_id || null,
          attendance_status: String(booking.attendance_status || "unknown"),
          arrived: Boolean(row?.arrived_at) || normalizeStatus(booking.attendance_status) === "arrived",
          arrived_at: row?.arrived_at || null,
          last_seen_at: row?.last_seen_at || null,
          distance_to_start_meters: roundDistance(Number(row?.distance_to_start_meters)),
          distance_to_driver_meters: roundDistance(Number(row?.distance_to_driver_meters)),
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
    const driverPresence = presenceByUserId.get(Number(ride.user_id)) || null;

    const distanceToStart = haversineMeters(
      { lat: latitude, lng: longitude },
      { lat: ride.start_lat, lng: ride.start_lng }
    );

    const withinStartRadius =
      Number.isFinite(distanceToStart) &&
      distanceToStart <= getEffectiveStartRadiusMeters(accuracyMeters);

    const canUseDriverFallback =
      actor.role !== "driver" &&
      driverPresence &&
      Number.isFinite(Number(driverPresence.latitude)) &&
      Number.isFinite(Number(driverPresence.longitude)) &&
      isFreshTimestamp(driverPresence.last_seen_at, now);

    const distanceToDriver = canUseDriverFallback
      ? haversineMeters(
          { lat: latitude, lng: longitude },
          {
            lat: Number(driverPresence.latitude),
            lng: Number(driverPresence.longitude),
          }
        )
      : Number.POSITIVE_INFINITY;

    const withinDriverRadius =
      canUseDriverFallback &&
      Number.isFinite(distanceToDriver) &&
      distanceToDriver <= getEffectiveDriverRadiusMeters(accuracyMeters);

    const matchedMeetupPoint = withinStartRadius || withinDriverRadius;
    const previousMatch =
      Boolean(currentPresence?.within_start_radius) ||
      Boolean(currentPresence?.within_driver_radius);
    const previousSampleFresh = isFreshTimestamp(currentPresence?.last_seen_at, now, 3 * 60);

    let dwellStartedAt = currentPresence?.dwell_started_at || null;
    let arrivedAt = currentPresence?.arrived_at || null;

    if (matchedMeetupPoint) {
      if (!arrivedAt) {
        if (!(previousMatch && dwellStartedAt && previousSampleFresh)) {
          dwellStartedAt = now.toISOString();
        }

        if (dwellStartedAt) {
          const dwellSeconds = Math.max(
            0,
            (now.getTime() - new Date(dwellStartedAt).getTime()) / 1000
          );

          if (dwellSeconds >= DWELL_SECONDS_REQUIRED) {
            arrivedAt = now.toISOString();
          }
        }
      }
    } else if (!arrivedAt) {
      dwellStartedAt = null;
    }

    const source = withinStartRadius
      ? "start_point"
      : withinDriverRadius
        ? "driver_fallback"
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
      distance_to_driver_meters: Number.isFinite(distanceToDriver) ? distanceToDriver : null,
      within_start_radius: Boolean(withinStartRadius),
      within_driver_radius: Boolean(withinDriverRadius),
      source,
      dwell_started_at: dwellStartedAt,
      arrived_at: arrivedAt,
    });

    presenceByUserId.set(userId, upsertedPresence);

    const justArrived = !currentPresence?.arrived_at && Boolean(upsertedPresence.arrived_at);
    if (actor.role === "rider" && justArrived) {
      await markPassengerArrived(client, actor.booking_id);
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
    }

    await client.query("COMMIT");

    await Promise.all(
      pendingNotifications.map((payload) => createNotification(payload))
    );

    return res.json({
      success: true,
      ride_id: rideId,
      ride_status: rideStarted ? "started" : String(ride.status || ""),
      actor_role: actor.role,
      tracking: {
        source,
        within_start_radius: Boolean(withinStartRadius),
        within_driver_radius: Boolean(withinDriverRadius),
        distance_to_start_meters: roundDistance(distanceToStart),
        distance_to_driver_meters: roundDistance(distanceToDriver),
        arrived: Boolean(upsertedPresence.arrived_at),
        arrived_at: upsertedPresence.arrived_at || null,
        dwell_started_at: upsertedPresence.dwell_started_at || null,
        dwell_seconds: upsertedPresence.dwell_started_at
          ? Math.max(
              0,
              Math.floor(
                (now.getTime() - new Date(upsertedPresence.dwell_started_at).getTime()) / 1000
              )
            )
          : 0,
      },
      summary,
      ride_started: rideStarted,
      required_start_radius_meters: START_RADIUS_METERS,
      required_driver_radius_meters: DRIVER_RADIUS_METERS,
      required_dwell_seconds: DWELL_SECONDS_REQUIRED,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("sync ride meetup presence error:", err);
    return res.status(500).json({ error: "Failed to sync ride meetup presence" });
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
