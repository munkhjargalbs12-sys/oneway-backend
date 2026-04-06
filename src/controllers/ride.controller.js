const pool = require("../db");

exports.createRide = async (req, res) => {
  try {
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

    const vehicleRes = await pool.query(
      "SELECT id FROM vehicles WHERE id = $1 AND user_id = $2 LIMIT 1",
      [vehicle_id, userId]
    );
    if (vehicleRes.rowCount === 0) {
      return res.status(403).json({ error: "Vehicle does not belong to current user" });
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
       WHERE r.status IN ('active', 'scheduled', 'pending')
       ORDER BY r.ride_date ASC, r.start_time ASC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getRides error:", err);
    res.status(500).json({ error: "Failed to get rides" });
  }
};

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
    console.error("getMyRides error:", err);
    res.status(500).json({ error: "Failed to get my rides" });
  }
};

exports.getMyAllRides = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT r.*, v.brand, v.model, v.color, v.plate_number
       FROM rides r
       LEFT JOIN vehicles v ON r.vehicle_id = v.id
       WHERE r.user_id = $1
       ORDER BY r.ride_date DESC NULLS LAST, r.start_time DESC NULLS LAST, r.id DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getMyAllRides error:", err);
    res.status(500).json({ error: "Failed to get all rides" });
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
    console.error("getActiveRide error:", err);
    res.status(500).json({ error: "Failed to get active ride" });
  }
};

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
    console.error("getMyRideHistory error:", err);
    res.status(500).json({ error: "Failed to get ride history" });
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

  try {
    const result = await pool.query(
      "UPDATE rides SET status='cancelled' WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Ride not found or not owner" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("cancelRide error:", err);
    res.status(500).json({ error: "Failed to cancel ride" });
  }
};
