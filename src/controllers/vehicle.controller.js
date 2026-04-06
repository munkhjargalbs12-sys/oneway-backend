const pool = require("../db");

async function ensureVehicleVerificationColumn() {
  await pool.query(
    "ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_verified BOOLEAN DEFAULT FALSE"
  );
}

// 🚘 Driver машин бүртгэх
exports.createVehicle = async (req, res) => {
  try {
    await ensureVehicleVerificationColumn();
    const userId = req.user.id;
    const { brand, model, color, plate_number, seats } = req.body;

    const result = await pool.query(
      `INSERT INTO vehicles (user_id, brand, model, color, plate_number, seats)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [userId, brand, model, color, plate_number, seats]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ createVehicle error:", err);
    res.status(500).json({ message: "Failed to create vehicle" });
  }
};

// 🚘 Миний машин
exports.getMyVehicle = async (req, res) => {
  try {
    await ensureVehicleVerificationColumn();
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT *
       FROM vehicles
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [userId]
    );

    res.json(result.rows[0] || null);
  } catch (err) {
    console.error("❌ getMyVehicle error:", err);
    res.status(500).json({ message: "Failed to get vehicle" });
  }
};

exports.verifyMyVehicle = async (req, res) => {
  try {
    const userId = req.user.id;
    await ensureVehicleVerificationColumn();

    const vehicleResult = await pool.query(
      `SELECT id
       FROM vehicles
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [userId]
    );

    if (vehicleResult.rowCount === 0) {
      return res.status(400).json({ message: "Vehicle is required" });
    }

    const vehicleId = vehicleResult.rows[0].id;

    const updateResult = await pool.query(
      `UPDATE vehicles
       SET vehicle_verified = TRUE
       WHERE id = $1
       RETURNING *`,
      [vehicleId]
    );

    res.json({
      success: true,
      vehicle: updateResult.rows[0],
      vehicle_verified: true,
    });
  } catch (err) {
    console.error("❌ verifyMyVehicle error:", err);
    res.status(500).json({ message: "Failed to verify vehicle" });
  }
};
