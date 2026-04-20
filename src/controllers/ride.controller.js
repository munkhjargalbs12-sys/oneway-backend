const pool = require("../db");
const { createNotification } = require("../utils/notify");
const { sendRideReminderNotifications } = require("../services/rideReminderScheduler");
const {
  getDestinationDistanceMeters,
  getRideScope,
  haversineMeters,
} = require("../utils/rideSearch");

const DEFAULT_RIDE_TIMEZONE = "Asia/Ulaanbaatar";
const MIN_RIDE_START_LEAD_MINUTES = 5;

function getRideTimezone() {
  const value = String(process.env.RIDE_TIMEZONE || "").trim();
  return value || DEFAULT_RIDE_TIMEZONE;
}

function toSqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function rideStartExpression(alias = "r") {
  return `(((${alias}.ride_date)::text || ' ' || COALESCE((${alias}.start_time)::text, '00:00:00'))::timestamp)`;
}

function rideStartInstantExpression(alias = "r") {
  return `(${rideStartExpression(alias)} AT TIME ZONE ${toSqlStringLiteral(getRideTimezone())})`;
}

function localTodayExpression() {
  return `((NOW() AT TIME ZONE ${toSqlStringLiteral(getRideTimezone())})::date)`;
}

function upcomingRideCondition(alias = "r") {
  return `(${alias}.ride_date IS NULL OR ${alias}.ride_date >= ${localTodayExpression()})`;
}

function currentRideCondition(alias = "r") {
  return `(LOWER(COALESCE(${alias}.status, '')) = 'started' OR ${upcomingRideCondition(alias)})`;
}

function pastRideCondition(alias = "r") {
  return `(${alias}.ride_date IS NOT NULL AND LOWER(COALESCE(${alias}.status, '')) <> 'started' AND ${alias}.ride_date < ${localTodayExpression()})`;
}

async function ensureRideHistoryHidesTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ride_history_hides (
       user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
       hidden_at TIMESTAMP DEFAULT NOW(),
       PRIMARY KEY (user_id, ride_id)
     )`
  );
}

function sanitizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function parseRideStartDate(rideDate, startTime) {
  const dateMatch = String(rideDate || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(startTime || "")
    .trim()
    .match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!dateMatch || !timeMatch) {
    return null;
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || 0);

  const value = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    Number.isNaN(value.getTime()) ||
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day ||
    value.getHours() !== hour ||
    value.getMinutes() !== minute ||
    value.getSeconds() !== second
  ) {
    return null;
  }

  return value;
}

function getNowInRideTimezone(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: getRideTimezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const partMap = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value])
    );

    return new Date(
      Number(partMap.year),
      Number(partMap.month) - 1,
      Number(partMap.day),
      Number(partMap.hour),
      Number(partMap.minute),
      Number(partMap.second || 0),
      0
    );
  } catch {
    return now;
  }
}

function getRideStartValidationError(rideDate, startTime, now = new Date()) {
  const rideStartDate = parseRideStartDate(rideDate, startTime);

  if (!rideStartDate) {
    return "Огноо эсвэл цагийн мэдээлэл буруу байна. Дахин сонгоно уу.";
  }

  const zonedNow = getNowInRideTimezone(now);
  const minimumStartDate = new Date(zonedNow.getTime() + MIN_RIDE_START_LEAD_MINUTES * 60 * 1000);
  if (rideStartDate.getTime() < minimumStartDate.getTime()) {
    return `Эхлэх цаг өнгөрсөн эсвэл хэт ойрхон байна. Одоо цагаас дор хаяж ${MIN_RIDE_START_LEAD_MINUTES} минутын дараах цаг сонгоно уу.`;
  }

  return null;
}

function normalizePersonName(name, fallback = "Жолооч") {
  const value = String(name || "").trim();
  return value || fallback;
}

function formatRideDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function buildRideCancelledNotificationBody(ride, driverName) {
  const summary = [];
  const endLocation = String(ride?.end_location || "").trim();
  const rideDate = formatRideDate(ride?.ride_date);
  const startTime = String(ride?.start_time || "").trim();

  if (endLocation) {
    summary.push(`${endLocation} чиглэл`);
  } else {
    summary.push("таны захиалсан чиглэл");
  }

  if (rideDate) {
    summary.push(`${rideDate}`);
  }

  if (startTime) {
    summary.push(`${startTime}`);
  }

  const routeSummary = summary.join(" · ");
  return routeSummary
    ? `${driverName} жолооч ${routeSummary} аяллыг цуцаллаа. Өөр тохирох чиглэл сонгоно уу.`
    : `${driverName} жолооч таны захиалсан чиглэлийг цуцаллаа. Өөр тохирох чиглэл сонгоно уу.`;
}

exports.createRide = async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      start,
      end,
      start_location,
      end_location,
      polyline,
      price,
      seats,
      ride_date,
      start_time,
      days,
      vehicle_id,
    } = req.body;

    if (!start || !end || !seats || !ride_date || !start_time || !vehicle_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const rideStartValidationError = getRideStartValidationError(ride_date, start_time);
    if (rideStartValidationError) {
      return res.status(400).json({ error: rideStartValidationError });
    }

    const vehicleRes = await pool.query(
      "SELECT id FROM vehicles WHERE id = $1 AND user_id = $2 LIMIT 1",
      [vehicle_id, userId]
    );
    if (vehicleRes.rowCount === 0) {
      return res.status(403).json({ error: "Vehicle does not belong to current user" });
    }

    const result = await pool.query(
      `INSERT INTO rides
       (user_id, vehicle_id, start_lat, start_lng, start_location, end_lat, end_lng,
        end_location, polyline, price, seats_total, seats_taken,
        ride_date, start_time, days, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,$14,'active')
       RETURNING *`,
      [
        userId,
        vehicle_id,
        start.lat,
        start.lng,
        sanitizeText(start_location),
        end.lat,
        end.lng,
        end_location,
        polyline,
        price,
        seats,
        ride_date,
        start_time,
        days,
      ]
    );

    await sendRideReminderNotifications({
      rideId: Number(result.rows[0]?.id),
    }).catch((error) => {
      console.error("create ride reminder dispatch error:", error?.message || error);
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("createRide error:", err);
    res.status(500).json({ error: "Failed to create ride" });
  }
};

exports.getRides = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         r.id,
         r.status,
         r.created_at,
         r.ride_date,
         r.start_time,
         r.start_lat,
         r.start_lng,
         r.start_location,
         r.end_lat,
         r.end_lng,
         r.end_location,
         r.price,
         (r.seats_total - r.seats_taken) AS available_seats,
         v.brand,
         v.model,
         v.color,
         v.plate_number,
         u.name AS driver_name,
         u.avatar_id
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.status IN ('active', 'scheduled', 'pending')
       AND ${upcomingRideCondition("r")}
       ORDER BY r.created_at DESC NULLS LAST, r.id DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getRides error:", err);
    res.status(500).json({ error: "Failed to get rides" });
  }
};

exports.searchRides = async (req, res) => {
  try {
    const startLat = Number(req.body?.start?.lat);
    const startLng = Number(req.body?.start?.lng);
    const endLat = Number(req.body?.end?.lat);
    const endLng = Number(req.body?.end?.lng);
    const radiusMeters = Number(req.body?.radius_m);
    const requestedScope =
      String(req.body?.scope || "").toLowerCase() === "intercity"
        ? "intercity"
        : "local";

    if (
      !Number.isFinite(startLat) ||
      !Number.isFinite(startLng) ||
      !Number.isFinite(endLat) ||
      !Number.isFinite(endLng) ||
      !Number.isFinite(radiusMeters) ||
      radiusMeters <= 0
    ) {
      return res.status(400).json({ error: "Invalid search coordinates or radius" });
    }

    const result = await pool.query(
      `SELECT
         r.id,
         r.status,
         r.created_at,
         r.ride_date,
         r.start_time,
         r.start_lat,
         r.start_lng,
         r.start_location,
         r.end_lat,
         r.end_lng,
         r.end_location,
         r.polyline,
         r.price,
         (r.seats_total - r.seats_taken) AS available_seats,
         v.brand,
         v.model,
         v.color,
         v.plate_number,
         u.name AS driver_name,
         u.avatar_id
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.status IN ('active', 'scheduled', 'pending')
       AND ${upcomingRideCondition("r")}`
    );

    const startPoint = { lat: startLat, lng: startLng };
    const endPoint = { lat: endLat, lng: endLng };

    const matches = result.rows
      .map((ride) => {
        const scope = getRideScope(ride);
        if (scope !== requestedScope) {
          return null;
        }

        const originDistance = haversineMeters(startPoint, {
          lat: ride.start_lat,
          lng: ride.start_lng,
        });
        const destinationDistance = getDestinationDistanceMeters(ride, endPoint);

        if (
          !Number.isFinite(originDistance) ||
          !Number.isFinite(destinationDistance) ||
          originDistance > radiusMeters ||
          destinationDistance > radiusMeters
        ) {
          return null;
        }

        return {
          ...ride,
          scope,
          origin_distance_m: Math.round(originDistance),
          destination_distance_m: Math.round(destinationDistance),
          match_score: Math.round(originDistance + destinationDistance),
        };
      })
      .filter(Boolean)
      .sort((first, second) => {
        const scoreDelta = Number(first.match_score || 0) - Number(second.match_score || 0);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        const firstTs = new Date(
          `${first.ride_date || ""}T${String(first.start_time || "00:00").slice(0, 5)}:00`
        ).getTime();
        const secondTs = new Date(
          `${second.ride_date || ""}T${String(second.start_time || "00:00").slice(0, 5)}:00`
        ).getTime();

        return firstTs - secondTs;
      });

    res.json(matches);
  } catch (err) {
    console.error("searchRides error:", err);
    res.status(500).json({ error: "Failed to search rides" });
  }
};

exports.getMyRides = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT r.*, v.brand, v.model, v.color, v.plate_number
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       WHERE r.user_id = $1 AND r.status IN ('active','full','scheduled','pending','started')
       AND ${currentRideCondition("r")}
       ORDER BY r.ride_date DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getMyRides error:", err);
    res.status(500).json({ error: "Failed to get my rides" });
  }
};

exports.getMyAllRides = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    await ensureRideHistoryHidesTable(client);

    const result = await client.query(
      `SELECT r.*, v.brand, v.model, v.color, v.plate_number
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       LEFT JOIN ride_history_hides rhh ON rhh.ride_id = r.id AND rhh.user_id = $1
       WHERE r.user_id = $1
       AND rhh.ride_id IS NULL
       ORDER BY r.ride_date DESC NULLS LAST, r.start_time DESC NULLS LAST, r.id DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getMyAllRides error:", err);
    res.status(500).json({ error: "Failed to get all rides" });
  } finally {
    client.release();
  }
};

exports.getRideById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT r.*, v.brand, v.model, v.color, v.plate_number
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       WHERE r.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ride not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("getRideById error:", err);
    res.status(500).json({ error: "Failed to get ride" });
  }
};

exports.getActiveRide = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT r.id,
              r.start_location,
              r.end_location,
              r.ride_date,
              r.start_time,
              v.brand,
              v.model,
              v.color,
              v.plate_number
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       WHERE r.user_id = $1
       AND r.status IN ('active','full','scheduled','pending','started')
       AND ${currentRideCondition("r")}
       ORDER BY CASE WHEN LOWER(COALESCE(r.status, '')) = 'started' THEN 0 ELSE 1 END,
                r.ride_date ASC,
                r.start_time ASC,
                r.id DESC
       LIMIT 1`,
      [userId]
    );

    res.json(result.rows[0] || null);
  } catch (err) {
    console.error("getActiveRide error:", err);
    res.status(500).json({ error: "Failed to get active ride" });
  }
};

exports.getMyRideHistory = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    await ensureRideHistoryHidesTable(client);

    const result = await client.query(
      `SELECT r.*, v.brand, v.model, v.color, v.plate_number
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       LEFT JOIN ride_history_hides rhh ON rhh.ride_id = r.id AND rhh.user_id = $1
       WHERE (
         r.user_id = $1
         OR r.id IN (SELECT ride_id FROM bookings WHERE user_id = $1)
       )
       AND rhh.ride_id IS NULL
       AND (
         r.status IN ('completed', 'cancelled', 'canceled')
         OR ${pastRideCondition("r")}
       )
       ORDER BY r.ride_date DESC, r.start_time DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getMyRideHistory error:", err);
    res.status(500).json({ error: "Failed to get ride history" });
  } finally {
    client.release();
  }
};

exports.hideRideHistoryEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.user.id);
    const rideId = Number(req.params.id);

    if (!Number.isFinite(rideId) || rideId <= 0) {
      return res.status(400).json({ error: "Invalid ride id" });
    }

    await ensureRideHistoryHidesTable(client);

    const access = await client.query(
      `SELECT r.id
       FROM rides r
       WHERE r.id = $1
       AND (
         r.user_id = $2
         OR EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.ride_id = r.id AND b.user_id = $2
         )
       )
       LIMIT 1`,
      [rideId, userId]
    );

    if (access.rowCount === 0) {
      return res.status(404).json({ error: "Ride history entry not found" });
    }

    await client.query(
      `INSERT INTO ride_history_hides (user_id, ride_id, hidden_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, ride_id)
       DO UPDATE SET hidden_at = EXCLUDED.hidden_at`,
      [userId, rideId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("hideRideHistoryEntry error:", err);
    res.status(500).json({ error: "Failed to hide ride history entry" });
  } finally {
    client.release();
  }
};

exports.startRide = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      "UPDATE rides SET status='started' WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Ride not found or not owner" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("startRide error:", err);
    res.status(500).json({ error: "Failed to start ride" });
  }
};

exports.completeRide = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      "UPDATE rides SET status='completed' WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Ride not found or not owner" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("completeRide error:", err);
    res.status(500).json({ error: "Failed to complete ride" });
  }
};

exports.cancelRide = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const rideRes = await client.query(
      `SELECT r.id,
              r.user_id,
              r.status,
              r.end_location,
              r.ride_date,
              r.start_time
         FROM rides r
        WHERE r.id = $1 AND r.user_id = $2
        FOR UPDATE`,
      [id, userId]
    );

    if (rideRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Ride not found or not owner" });
    }

    const ride = rideRes.rows[0];
    const driverRes = await client.query(
      `SELECT name, avatar_id
         FROM users
        WHERE id = $1`,
      [Number(ride.user_id)]
    );
    const driver = driverRes.rows[0] || null;
    const rideStatus = String(ride.status || "").toLowerCase();

    if (rideStatus === "completed") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Completed ride cannot be cancelled" });
    }

    if (rideStatus === "cancelled" || rideStatus === "canceled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ride already cancelled" });
    }

    await client.query(
      "UPDATE rides SET status='cancelled' WHERE id = $1",
      [ride.id]
    );

    const affectedBookingsRes = await client.query(
      `UPDATE bookings
          SET status = 'cancelled'
        WHERE ride_id = $1
          AND COALESCE(status, 'pending') IN ('pending', 'approved')
      RETURNING id, user_id`,
      [ride.id]
    );

    await client.query("COMMIT");

    const driverName = normalizePersonName(driver?.name);
    await Promise.all(
      affectedBookingsRes.rows.map((booking) =>
        createNotification({
          userId: Number(booking.user_id),
          title: "Чиглэл цуцлагдлаа",
          body: buildRideCancelledNotificationBody(ride, driverName),
          type: "ride_cancelled",
          relatedId: Number(ride.id),
          fromUserId: Number(userId),
          fromUserName: driverName,
          fromAvatarId: driver?.avatar_id || null,
          rideId: Number(ride.id),
          bookingId: Number(booking.id),
        })
      )
    );

    res.json({
      success: true,
      ride_id: Number(ride.id),
      cancelled_bookings: affectedBookingsRes.rowCount,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    console.error("cancelRide error:", err);
    res.status(500).json({ error: "Failed to cancel ride" });
  } finally {
    client.release();
  }
};
