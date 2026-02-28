const pool = require("../db");
const { createNotification } = require("../utils/notify");

async function getBookingMeta(client) {
  const { rows } = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'bookings'
        AND column_name IN ('seats', 'seats_booked', 'status', 'approved_by', 'approved_at', 'rejected_at')`
  );

  const cols = new Set(rows.map((r) => r.column_name));
  return {
    seatColumn: cols.has("seats") ? "seats" : cols.has("seats_booked") ? "seats_booked" : null,
    hasStatus: cols.has("status"),
    hasApprovedBy: cols.has("approved_by"),
    hasApprovedAt: cols.has("approved_at"),
    hasRejectedAt: cols.has("rejected_at"),
  };
}

function normalizeRequesterName(userRow, fallbackId) {
  const name = String(userRow?.name || "").trim();
  if (name) return name;
  const phone = String(userRow?.phone || "").trim();
  if (phone) return phone;
  return `ID-${fallbackId}`;
}

exports.getMyBookings = async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT DISTINCT ride_id
       FROM bookings
       WHERE user_id = $1`,
      [userId]
    );

    res.json({ ride_ids: result.rows.map((r) => Number(r.ride_id)) });
  } catch (err) {
    console.error("failed to load my bookings:", err.message);
    res.status(500).json({ error: "Failed to load bookings" });
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

    if (!['active', 'scheduled', 'pending'].includes(String(ride.status || '').toLowerCase())) {
      throw new Error("Ride not available");
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

    await client.query("COMMIT");

    const requesterRes = await pool.query(
      `SELECT id, name, phone, avatar_id
       FROM users
       WHERE id = $1`,
      [userId]
    );
    const requester = requesterRes.rows[0] || { id: userId };
    const requesterName = normalizeRequesterName(requester, userId);

    await createNotification({
      userId: Number(ride.user_id),
      title: "Суудлын захиалга",
      body: `${requesterName} хэрэглэгч таны чиглэлд суудал захиаллаа.`,
      type: "booking",
      relatedId: rideId,
      fromUserId: userId,
      fromUserName: requesterName,
      fromAvatarId: requester.avatar_id || null,
      rideId,
      bookingId,
    });

    res.json({ success: true, booking_id: bookingId, status: meta.hasStatus ? "pending" : "approved" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("booking error:", err.message);
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

    res.json({ success: true });
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

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("reject booking error:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};
