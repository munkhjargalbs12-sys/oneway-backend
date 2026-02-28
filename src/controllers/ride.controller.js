const pool = require("../db");

/* =====================================================
   🚗 CREATE RIDE
   ===================================================== */
exports.createRide = async (req, res) => {
  try {
      console.log("🔥 CREATE RIDE BODY:", req.body);
    console.log("🔥 POLYLINE VALUE:", req.body.polyline);

    const userId = req.user.id;

    const {
      start,
      end,
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

    const result = await pool.query(
      `INSERT INTO rides
       (user_id, vehicle_id, start_lat, start_lng, end_lat, end_lng,
        end_location, polyline, price, seats_total, seats_taken,
        ride_date, start_time, days, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,'active')
       RETURNING *`,
      [
        userId,
        vehicle_id,
        start.lat,
        start.lng,
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

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ createRide error:", err);
    res.status(500).json({ error: "Failed to create ride" });
  }
};

/* =====================================================
   🌍 GET ALL ACTIVE RIDES (WITH VEHICLE)
   ===================================================== */
exports.getRides = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         r.id,
         r.status,
         r.ride_date,
         r.start_time,
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
       -- TEMP TEST: show all statuses; switch back to WHERE r.status='active' later
       ORDER BY r.ride_date ASC, r.start_time ASC`
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error("❌ getRides error:", err);
    res.status(500).json({ error: "Failed to get rides" });
  }
};

/* =====================================================
   👤 MY ACTIVE RIDES (DRIVER)
   ===================================================== */
exports.getMyRides = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT r.*, v.brand, v.model, v.color, v.plate_number
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       WHERE r.user_id = $1 AND r.status IN ('active','started')
       ORDER BY r.ride_date DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ getMyRides error:", err);
    res.status(500).json({ error: "Failed to get my rides" });
  }
};

/* =====================================================
   🔍 RIDE DETAIL
   ===================================================== */
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
    console.error("❌ getRideById error:", err);
    res.status(500).json({ error: "Failed to get ride" });
  }
};

/* =====================================================
   🟢 ACTIVE RIDE FOR HOME SCREEN
   ===================================================== */
exports.getActiveRide = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT r.id,
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
       AND r.status IN ('active','started')
       ORDER BY r.ride_date ASC
       LIMIT 1`,
      [userId]
    );

    res.json(result.rows[0] || null);
  } catch (err) {
    console.error("❌ getActiveRide error:", err);
    res.status(500).json({ error: "Failed to get active ride" });
  }
};

/* =====================================================
   📜 MY RIDE HISTORY (DRIVER + PASSENGER)
   ===================================================== */
exports.getMyRideHistory = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT r.*, v.brand, v.model, v.color, v.plate_number
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       WHERE (
         r.user_id = $1
         OR r.id IN (SELECT ride_id FROM bookings WHERE user_id = $1)
       )
       AND r.status IN ('completed', 'cancelled')
       ORDER BY r.ride_date DESC, r.start_time DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ getMyRideHistory error:", err);
    res.status(500).json({ error: "Failed to get ride history" });
  }
};

/* =====================================================
   🚦 RIDE LIFECYCLE
   ===================================================== */
exports.startRide = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      "UPDATE rides SET status='started' WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Ride not found or not owner" });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ startRide error:", err);
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

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Ride not found or not owner" });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ completeRide error:", err);
    res.status(500).json({ error: "Failed to complete ride" });
  }
};

exports.cancelRide = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      "UPDATE rides SET status='cancelled' WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Ride not found or not owner" });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ cancelRide error:", err);
    res.status(500).json({ error: "Failed to cancel ride" });
  }
};
