const pool = require("../db");
const { createNotification } = require("../utils/notify");

const { sendRideReminderNotifications } = require("../services/rideReminderScheduler");

async function getBookingMeta(client) {
  const { rows } = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'bookings'
        AND column_name IN (
          'seats',
          'seats_booked',
          'status',
          'approved_by',
          'approved_at',
          'rejected_at',
          'attendance_status',
          'attendance_marked_at',
          'attendance_marked_by'
        )`
  );

  const cols = new Set(rows.map((r) => r.column_name));
  return {
    seatColumn: cols.has("seats") ? "seats" : cols.has("seats_booked") ? "seats_booked" : null,
    hasStatus: cols.has("status"),
    hasApprovedBy: cols.has("approved_by"),
    hasApprovedAt: cols.has("approved_at"),
    hasRejectedAt: cols.has("rejected_at"),
    hasAttendanceStatus: cols.has("attendance_status"),
    hasAttendanceMarkedAt: cols.has("attendance_marked_at"),
    hasAttendanceMarkedBy: cols.has("attendance_marked_by"),
  };
}

function normalizeRequesterName(userRow, fallbackId) {
  const name = String(userRow?.name || "").trim();
  if (name) return name;
  const phone = String(userRow?.phone || "").trim();
  if (phone) return phone;
  return `ID-${fallbackId}`;
}

function getBookingStatusLabel(status) {
  switch (String(status || "").toLowerCase()) {
    case "pending":
      return "Жолоочийн зөвшөөрөл хүлээж байна";
    case "approved":
      return "Захиалга баталгаажсан";
    case "rejected":
      return "Жолооч зөвшөөрөөгүй";
    case "cancelled":
    case "canceled":
      return "Захиалга цуцлагдсан";
    default:
      return String(status || "");
  }
}

function getRideUnavailableMessage(status) {
  switch (String(status || "").trim().toLowerCase()) {
    case "full":
      return "Ride is full";
    case "started":
      return "Ride already started";
    case "completed":
    case "cancelled":
    case "canceled":
      return "Ride already finished";
    default:
      return "Ride not available";
  }
}

function isExpectedBookingError(message) {
  return [
    "Invalid ride_id",
    "Invalid seats",
    "Invalid booking id",
    "Ride not found",
    "You cannot book your own ride",
    "Ride not available",
    "Ride is full",
    "Ride already started",
    "Ride already finished",
    "Not enough seats",
    "Booking already exists",
    "Booking not found",
    "Only the booking owner can cancel",
    "Only pending or approved bookings can be cancelled",
    "Started ride booking cannot be cancelled",
    "Completed ride booking cannot be cancelled",
    "Cancelled ride booking cannot be cancelled",
  ].includes(String(message || "").trim());
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

async function getRequesterRelationshipSummary(client, { driverId, passengerId, currentBookingId, meta }) {
  const params = [driverId, passengerId, currentBookingId];
  const countParts = [
    "COUNT(*)::int AS total_requests",
    "COUNT(*) FILTER (WHERE COALESCE(b.status, 'approved') = 'approved')::int AS approved_requests",
    "COUNT(*) FILTER (WHERE COALESCE(b.status, 'approved') = 'approved' AND LOWER(COALESCE(r.status, '')) = 'completed')::int AS completed_rides",
  ];

  if (meta.hasAttendanceStatus) {
    countParts.push(
      "COUNT(*) FILTER (WHERE COALESCE(b.attendance_status, 'unknown') = 'no_show')::int AS no_show_count"
    );
  } else {
    countParts.push("0::int AS no_show_count");
  }

  const totalsRes = await client.query(
    `SELECT ${countParts.join(", ")}
       FROM bookings b
       JOIN rides r ON r.id = b.ride_id
      WHERE r.user_id = $1
        AND b.user_id = $2
        AND b.id <> $3`,
    params
  );

  const totals = totalsRes.rows[0] || {};
  const summary = {
    totalRequests: Number(totals.total_requests || 0),
    approvedRequests: Number(totals.approved_requests || 0),
    completedRides: Number(totals.completed_rides || 0),
    noShowCount: Number(totals.no_show_count || 0),
    lastCompletedDate: "",
    lastCompletedLocation: "",
    lastNoShowDate: "",
    lastNoShowLocation: "",
  };

  if (summary.completedRides > 0) {
    const completedRes = await client.query(
      `SELECT r.ride_date, r.end_location
         FROM bookings b
         JOIN rides r ON r.id = b.ride_id
        WHERE r.user_id = $1
          AND b.user_id = $2
          AND b.id <> $3
          AND COALESCE(b.status, 'approved') = 'approved'
          AND LOWER(COALESCE(r.status, '')) = 'completed'
        ORDER BY r.ride_date DESC NULLS LAST, r.start_time DESC NULLS LAST, b.id DESC
        LIMIT 1`,
      params
    );

    const lastCompleted = completedRes.rows[0];
    if (lastCompleted) {
      summary.lastCompletedDate = formatRideDate(lastCompleted.ride_date);
      summary.lastCompletedLocation = String(lastCompleted.end_location || "").trim();
    }
  }

  if (summary.noShowCount > 0 && meta.hasAttendanceStatus) {
    const noShowRes = await client.query(
      `SELECT r.ride_date, r.end_location
         FROM bookings b
         JOIN rides r ON r.id = b.ride_id
        WHERE r.user_id = $1
          AND b.user_id = $2
          AND b.id <> $3
          AND COALESCE(b.attendance_status, 'unknown') = 'no_show'
        ORDER BY r.ride_date DESC NULLS LAST, r.start_time DESC NULLS LAST, b.id DESC
        LIMIT 1`,
      params
    );

    const lastNoShow = noShowRes.rows[0];
    if (lastNoShow) {
      summary.lastNoShowDate = formatRideDate(lastNoShow.ride_date);
      summary.lastNoShowLocation = String(lastNoShow.end_location || "").trim();
    }
  }

  return summary;
}

function buildBookingRequestNotificationBody(requesterName, summary) {
  const lines = [`${requesterName} хэрэглэгч тантай нэг чиглэлд хамт зорчих хүсэлт илгээсэн.`];
  const historyLines = [];

  if (Number(summary?.noShowCount || 0) > 0) {
    let line = `Өмнө нь таны зөвшөөрсөн захиалгуудаас уулзах цэгт ирээгүй ${summary.noShowCount} удаа байна`;
    if (summary.lastNoShowDate) {
      line += summary.lastNoShowLocation
        ? `, сүүлд ${summary.lastNoShowDate}-нд ${summary.lastNoShowLocation} чиглэл дээр`
        : `, сүүлд ${summary.lastNoShowDate}-нд`;
    }
    historyLines.push(`${line}.`);
  }

  if (Number(summary?.completedRides || 0) > 0) {
    let line = `Та хоёр өмнө нь ${summary.completedRides} удаа хамт зорчсон`;
    if (summary.lastCompletedDate) {
      line += summary.lastCompletedLocation
        ? `, сүүлд ${summary.lastCompletedDate}-нд ${summary.lastCompletedLocation} чиглэлд`
        : `, сүүлд ${summary.lastCompletedDate}-нд`;
    }
    historyLines.push(`${line}.`);
  } else if (Number(summary?.totalRequests || 0) > 0) {
    historyLines.push(
      `Энэ зорчигч өмнө нь таны чиглэлүүдэд ${summary.totalRequests} удаа хүсэлт өгч байсан.`
    );
  }

  if (historyLines.length > 0) {
    lines.push("");
    lines.push("Өмнөх түүх:");
    for (const line of historyLines) {
      lines.push(`- ${line}`);
    }
  }

  return lines.join("\n");
}

function buildBookingCancelledNotificationBody(passengerName, ride) {
  const parts = [`${passengerName} хэрэглэгч суудлын захиалгаа цуцаллаа.`];
  const routeParts = [];
  const rideDate = formatRideDate(ride?.ride_date);
  const startTime = String(ride?.start_time || "").trim();
  const endLocation = String(ride?.end_location || "").trim();

  if (endLocation) routeParts.push(`${endLocation} чиглэл`);
  if (rideDate) routeParts.push(rideDate);
  if (startTime) routeParts.push(startTime);

  if (routeParts.length > 0) {
    parts.push(routeParts.join(" · "));
  }

  return parts.join("\n");
}

exports.getMyBookings = async (req, res) => {
  const userId = Number(req.user.id);
  const client = await pool.connect();

  try {
    const meta = await getBookingMeta(client);
    const seatExpr = meta.seatColumn === "seats"
      ? "COALESCE(b.seats, 1)"
      : meta.seatColumn === "seats_booked"
        ? "COALESCE(b.seats_booked, 1)"
        : "1";
    const statusExpr = meta.hasStatus ? "COALESCE(b.status, 'approved')" : "'approved'";
    const approvedAtExpr = meta.hasApprovedAt ? "b.approved_at" : "NULL";
    const rejectedAtExpr = meta.hasRejectedAt ? "b.rejected_at" : "NULL";
    const attendanceStatusExpr = meta.hasAttendanceStatus ? "b.attendance_status" : "NULL";

    const result = await client.query(
      `SELECT DISTINCT ON (b.ride_id)
         b.id AS booking_id,
         b.ride_id,
         ${seatExpr} AS seats,
         ${statusExpr} AS status,
         ${approvedAtExpr} AS approved_at,
         ${rejectedAtExpr} AS rejected_at,
         ${attendanceStatusExpr} AS attendance_status,
         b.created_at AS booking_created_at,
         r.status AS ride_status,
         r.created_at AS ride_created_at,
         to_char(r.ride_date, 'YYYY-MM-DD') AS ride_date,
         TO_CHAR(r.start_time, 'HH24:MI:SS') AS start_time,
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
       FROM bookings b
       LEFT JOIN rides r ON r.id = b.ride_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id
       LEFT JOIN users u ON u.id = r.user_id
       WHERE b.user_id = $1
       ORDER BY b.ride_id, b.created_at DESC, b.id DESC`,
      [userId]
    );

    const bookings = result.rows.map((row) => ({
      booking_id: Number(row.booking_id),
      ride_id: Number(row.ride_id),
      seats: Number(row.seats || 1),
      status: String(row.status || "approved"),
      status_label: getBookingStatusLabel(row.status || "approved"),
      approved_at: row.approved_at,
      rejected_at: row.rejected_at,
      attendance_status: row.attendance_status ? String(row.attendance_status) : null,
      created_at: row.booking_created_at,
      ride: row.ride_status
        ? {
            id: Number(row.ride_id),
            status: String(row.ride_status || ""),
            created_at: row.ride_created_at,
            ride_date: row.ride_date,
            start_time: row.start_time,
            start_lat: row.start_lat !== null ? Number(row.start_lat) : null,
            start_lng: row.start_lng !== null ? Number(row.start_lng) : null,
            start_location: row.start_location,
            end_lat: row.end_lat !== null ? Number(row.end_lat) : null,
            end_lng: row.end_lng !== null ? Number(row.end_lng) : null,
            end_location: row.end_location,
            price: row.price !== null ? Number(row.price) : null,
            available_seats: Number(row.available_seats || 0),
            brand: row.brand,
            model: row.model,
            color: row.color,
            plate_number: row.plate_number,
            driver_name: row.driver_name,
            avatar_id: row.avatar_id,
          }
        : null,
    }));

    const activeBookings = bookings.filter((booking) =>
      ["pending", "approved"].includes(String(booking.status || "").toLowerCase())
    );
    const pendingRideIds = bookings
      .filter((booking) => booking.status === "pending")
      .map((booking) => booking.ride_id);
    const approvedRideIds = bookings
      .filter((booking) => booking.status === "approved")
      .map((booking) => booking.ride_id);
    const rejectedRideIds = bookings
      .filter((booking) => booking.status === "rejected")
      .map((booking) => booking.ride_id);
    const statusByRide = Object.fromEntries(
      bookings.map((booking) => [String(booking.ride_id), booking.status])
    );
    const statusLabelByRide = Object.fromEntries(
      bookings.map((booking) => [String(booking.ride_id), booking.status_label])
    );

    res.json({
      ride_ids: activeBookings.map((booking) => booking.ride_id),
      bookings,
      status_by_ride: statusByRide,
      status_label_by_ride: statusLabelByRide,
      pending_ride_ids: pendingRideIds,
      approved_ride_ids: approvedRideIds,
      rejected_ride_ids: rejectedRideIds,
    });
  } catch (err) {
    console.error("failed to load my bookings:", err.message);
    res.status(500).json({ error: "Failed to load bookings" });
  } finally {
    client.release();
  }
};

exports.bookSeat = async (req, res) => {
  const userId = Number(req.user.id);
  const rideId = Number(req.body?.ride_id);
  const seats = Number(req.body?.seats || 1);

  if (!Number.isFinite(rideId) || rideId <= 0) {
    return res.status(400).json({ error: "Invalid ride_id" });
  }
  if (!Number.isFinite(seats) || seats <= 0) {
    return res.status(400).json({ error: "Invalid seats" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const meta = await getBookingMeta(client);
    if (!meta.seatColumn) {
      throw new Error("bookings table is missing seat column (seats/seats_booked)");
    }

    const rideRes = await client.query(
      `SELECT id, user_id, seats_total, seats_taken, status, end_location
       FROM rides
       WHERE id = $1
       FOR UPDATE`,
      [rideId]
    );

    if (rideRes.rows.length === 0) throw new Error("Ride not found");
    const ride = rideRes.rows[0];

    if (Number(ride.user_id) === userId) {
      throw new Error("You cannot book your own ride");
    }

    const rideStatus = String(ride.status || "").toLowerCase();
    if (!["active", "scheduled", "pending"].includes(rideStatus)) {
      throw new Error(getRideUnavailableMessage(rideStatus));
    }

    if (Number(ride.seats_taken) + seats > Number(ride.seats_total)) {
      throw new Error("Not enough seats");
    }

    const dupQuery = meta.hasStatus
      ? `SELECT id FROM bookings WHERE ride_id = $1 AND user_id = $2 AND status IN ('pending','approved') LIMIT 1`
      : `SELECT id FROM bookings WHERE ride_id = $1 AND user_id = $2 LIMIT 1`;
    const dup = await client.query(dupQuery, [rideId, userId]);
    if (dup.rows.length > 0) throw new Error("Booking already exists");

    const insertCols = ["ride_id", "user_id", meta.seatColumn];
    const insertVals = [rideId, userId, seats];
    if (meta.hasStatus) {
      insertCols.push("status");
      insertVals.push("pending");
    }

    const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(",");
    const bookingRes = await client.query(
      `INSERT INTO bookings (${insertCols.join(",")})
       VALUES (${placeholders})
       RETURNING id`,
      insertVals
    );

    const bookingId = Number(bookingRes.rows[0]?.id || 0);
    const relationshipSummary = await getRequesterRelationshipSummary(client, {
      driverId: Number(ride.user_id),
      passengerId: userId,
      currentBookingId: bookingId,
      meta,
    });

    // Legacy fallback: old schema without booking.status kept immediate behavior.
    if (!meta.hasStatus) {
      const newTaken = Number(ride.seats_taken) + seats;
      const newStatus = newTaken >= Number(ride.seats_total) ? "full" : "active";
      await client.query(
        `UPDATE rides
         SET seats_taken = $1, status = $2
         WHERE id = $3`,
        [newTaken, newStatus, rideId]
      );
    }

    const requesterRes = await client.query(
      `SELECT id, name, phone, avatar_id
       FROM users
       WHERE id = $1`,
      [userId]
    );
    const requester = requesterRes.rows[0] || { id: userId };
    const requesterName = normalizeRequesterName(requester, userId);

    await client.query("COMMIT");

    await createNotification({
      userId: Number(ride.user_id),
      title: "Суудлын захиалга",
      body: buildBookingRequestNotificationBody(requesterName, relationshipSummary),
      type: "booking",
      relatedId: rideId,
      fromUserId: userId,
      fromUserName: requesterName,
      fromAvatarId: requester.avatar_id || null,
      rideId,
      bookingId,
    });

    res.json({
      success: true,
      booking_id: bookingId,
      ride_id: rideId,
      status: meta.hasStatus ? "pending" : "approved",
      status_label: getBookingStatusLabel(meta.hasStatus ? "pending" : "approved"),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (isExpectedBookingError(err.message)) {
      console.warn("booking rejected:", err.message);
    } else {
      console.error("booking error:", err.message);
    }
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};

exports.approveBooking = async (req, res) => {
  const driverId = Number(req.user.id);
  const bookingId = Number(req.params.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const meta = await getBookingMeta(client);
    if (!meta.hasStatus) throw new Error("Booking approval requires bookings.status column");

    const seatExpr = meta.seatColumn === "seats_booked" ? "b.seats_booked" : "b.seats";
    const rowRes = await client.query(
      `SELECT b.id, b.ride_id, b.user_id, ${seatExpr} AS seats, b.status,
              r.user_id AS driver_id, r.seats_total, r.seats_taken, r.status AS ride_status
       FROM bookings b
       JOIN rides r ON r.id = b.ride_id
       WHERE b.id = $1
       FOR UPDATE`,
      [bookingId]
    );

    if (rowRes.rows.length === 0) throw new Error("Booking not found");
    const row = rowRes.rows[0];

    if (Number(row.driver_id) !== driverId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only ride owner can approve" });
    }

    if (String(row.status) !== "pending") {
      throw new Error("Booking is not pending");
    }

    const seats = Number(row.seats || 1);
    if (Number(row.seats_taken) + seats > Number(row.seats_total)) {
      throw new Error("Not enough seats to approve");
    }

    const setParts = ["status = 'approved'"];
    const setVals = [];
    let idx = 1;

    if (meta.hasApprovedBy) {
      setParts.push(`approved_by = $${idx++}`);
      setVals.push(driverId);
    }
    if (meta.hasApprovedAt) {
      setParts.push("approved_at = NOW()");
    }

    await client.query(
      `UPDATE bookings SET ${setParts.join(", ")} WHERE id = $${idx}`,
      [...setVals, bookingId]
    );

    const newTaken = Number(row.seats_taken) + seats;
    const nextRideStatus = newTaken >= Number(row.seats_total) ? "full" : row.ride_status;
    await client.query(
      `UPDATE rides SET seats_taken = $1, status = $2 WHERE id = $3`,
      [newTaken, nextRideStatus, row.ride_id]
    );

    await client.query("COMMIT");

    await createNotification({
      userId: Number(row.user_id),
      title: "Захиалга баталгаажлаа",
      body: "Таны суудлын захиалга жолоочоор зөвшөөрөгдлөө.",
      type: "booking_approved",
      relatedId: Number(row.ride_id),
      fromUserId: driverId,
      rideId: Number(row.ride_id),
      bookingId,
    });

    await sendRideReminderNotifications({
      rideId: Number(row.ride_id),
    }).catch((error) => {
      console.error(
        "approve booking reminder dispatch error:",
        error?.message || error
      );
    });

    res.json({
      success: true,
      booking_id: bookingId,
      ride_id: Number(row.ride_id),
      status: "approved",
      status_label: getBookingStatusLabel("approved"),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("approve booking error:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};

exports.rejectBooking = async (req, res) => {
  const driverId = Number(req.user.id);
  const bookingId = Number(req.params.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const meta = await getBookingMeta(client);
    if (!meta.hasStatus) throw new Error("Booking rejection requires bookings.status column");

    const rowRes = await client.query(
      `SELECT b.id, b.ride_id, b.user_id, b.status, r.user_id AS driver_id
       FROM bookings b
       JOIN rides r ON r.id = b.ride_id
       WHERE b.id = $1
       FOR UPDATE`,
      [bookingId]
    );

    if (rowRes.rows.length === 0) throw new Error("Booking not found");
    const row = rowRes.rows[0];

    if (Number(row.driver_id) !== driverId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only ride owner can reject" });
    }

    if (String(row.status) !== "pending") {
      throw new Error("Booking is not pending");
    }

    const setParts = ["status = 'rejected'"];
    if (meta.hasRejectedAt) setParts.push("rejected_at = NOW()");

    await client.query(
      `UPDATE bookings SET ${setParts.join(", ")} WHERE id = $1`,
      [bookingId]
    );

    await client.query("COMMIT");

    await createNotification({
      userId: Number(row.user_id),
      title: "Захиалга цуцлагдлаа",
      body: "Таны суудлын захиалгыг жолооч зөвшөөрсөнгүй.",
      type: "booking_rejected",
      relatedId: Number(row.ride_id),
      fromUserId: driverId,
      rideId: Number(row.ride_id),
      bookingId,
    });

    res.json({
      success: true,
      booking_id: bookingId,
      ride_id: Number(row.ride_id),
      status: "rejected",
      status_label: getBookingStatusLabel("rejected"),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("reject booking error:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};

exports.markBookingAttendance = async (req, res) => {
  const driverId = Number(req.user.id);
  const bookingId = Number(req.params.id);
  const attendanceStatus = String(req.body?.status || "")
    .trim()
    .toLowerCase();

  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return res.status(400).json({ error: "Invalid booking id" });
  }

  if (!["arrived", "no_show"].includes(attendanceStatus)) {
    return res.status(400).json({ error: "Invalid attendance status" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const meta = await getBookingMeta(client);
    if (!meta.hasAttendanceStatus) {
      throw new Error("Booking attendance requires bookings.attendance_status column");
    }

    const rowRes = await client.query(
      `SELECT b.id, b.ride_id, b.user_id, b.status AS booking_status,
              r.user_id AS driver_id
         FROM bookings b
         JOIN rides r ON r.id = b.ride_id
        WHERE b.id = $1
        FOR UPDATE`,
      [bookingId]
    );

    if (rowRes.rows.length === 0) {
      throw new Error("Booking not found");
    }

    const row = rowRes.rows[0];
    if (Number(row.driver_id) !== driverId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only ride owner can update attendance" });
    }

    if (String(row.booking_status || "").toLowerCase() !== "approved") {
      throw new Error("Only approved bookings can be marked");
    }

    const setParts = ["attendance_status = $1"];
    const setVals = [attendanceStatus];
    let idx = 2;

    if (meta.hasAttendanceMarkedAt) {
      setParts.push("attendance_marked_at = NOW()");
    }
    if (meta.hasAttendanceMarkedBy) {
      setParts.push(`attendance_marked_by = $${idx++}`);
      setVals.push(driverId);
    }

    await client.query(
      `UPDATE bookings
          SET ${setParts.join(", ")}
        WHERE id = $${idx}`,
      [...setVals, bookingId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      booking_id: bookingId,
      ride_id: Number(row.ride_id),
      attendance_status: attendanceStatus,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("mark booking attendance error:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};

exports.cancelMyBooking = async (req, res) => {
  const userId = Number(req.user.id);
  const bookingId = Number(req.params.id);

  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return res.status(400).json({ error: "Invalid booking id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const meta = await getBookingMeta(client);
    if (!meta.hasStatus) {
      throw new Error("Booking cancellation requires bookings.status column");
    }

    const seatExpr = meta.seatColumn === "seats_booked" ? "b.seats_booked" : "b.seats";
    const rowRes = await client.query(
      `SELECT b.id,
              b.ride_id,
              b.user_id,
              ${seatExpr} AS seats,
              b.status AS booking_status,
              r.user_id AS driver_id,
              r.status AS ride_status,
              r.seats_total,
              r.seats_taken,
              r.ride_date,
              r.start_time,
              r.end_location
         FROM bookings b
         JOIN rides r ON r.id = b.ride_id
        WHERE b.id = $1
        FOR UPDATE OF b, r`,
      [bookingId]
    );

    if (rowRes.rowCount === 0) {
      throw new Error("Booking not found");
    }

    const row = rowRes.rows[0];
    if (Number(row.user_id) !== userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the booking owner can cancel" });
    }

    const bookingStatus = String(row.booking_status || "").toLowerCase();
    if (!["pending", "approved"].includes(bookingStatus)) {
      throw new Error("Only pending or approved bookings can be cancelled");
    }

    const rideStatus = String(row.ride_status || "").toLowerCase();
    if (rideStatus === "started") {
      throw new Error("Started ride booking cannot be cancelled");
    }
    if (rideStatus === "completed") {
      throw new Error("Completed ride booking cannot be cancelled");
    }
    if (rideStatus === "cancelled" || rideStatus === "canceled") {
      throw new Error("Cancelled ride booking cannot be cancelled");
    }

    await client.query(
      `UPDATE bookings
          SET status = 'cancelled'
        WHERE id = $1`,
      [bookingId]
    );

    let nextRideStatus = row.ride_status;
    if (bookingStatus === "approved") {
      const nextSeatsTaken = Math.max(0, Number(row.seats_taken || 0) - Number(row.seats || 1));
      if (rideStatus === "full" && nextSeatsTaken < Number(row.seats_total || 0)) {
        nextRideStatus = "active";
      }

      await client.query(
        `UPDATE rides
            SET seats_taken = $1,
                status = $2
          WHERE id = $3`,
        [nextSeatsTaken, nextRideStatus, row.ride_id]
      );
    }

    const passengerRes = await client.query(
      `SELECT id, name, phone, avatar_id
         FROM users
        WHERE id = $1`,
      [userId]
    );
    const passenger = passengerRes.rows[0] || { id: userId };
    const passengerName = normalizeRequesterName(passenger, userId);

    await client.query("COMMIT");

    await createNotification({
      userId: Number(row.driver_id),
      title: "Захиалга цуцлагдлаа",
      body: buildBookingCancelledNotificationBody(passengerName, row),
      type: "booking_cancelled",
      relatedId: Number(row.ride_id),
      fromUserId: userId,
      fromUserName: passengerName,
      fromAvatarId: passenger.avatar_id || null,
      rideId: Number(row.ride_id),
      bookingId,
    });

    res.json({
      success: true,
      booking_id: bookingId,
      ride_id: Number(row.ride_id),
      status: "cancelled",
      status_label: getBookingStatusLabel("cancelled"),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (isExpectedBookingError(err.message)) {
      console.warn("booking cancellation rejected:", err.message);
    } else {
      console.error("cancel booking error:", err.message);
    }
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};
