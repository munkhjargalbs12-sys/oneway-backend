const pool = require("../db");

async function ensureVehicleVerificationColumn() {
  await pool.query(
    "ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_verified BOOLEAN DEFAULT FALSE"
  );
}

const sanitizeText = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizePlate = (value) => {
  const normalized = sanitizeText(value);
  return normalized ? normalized.toUpperCase() : null;
};

const sanitizeSeats = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.trunc(parsed));
};

// 🚘 Driver машин бүртгэх
exports.createVehicle = async (req, res) => {
  try {
    await ensureVehicleVerificationColumn();
    const userId = req.user.id;
    const brand = sanitizeText(req.body?.brand);
    const model = sanitizeText(req.body?.model);
    const color = sanitizeText(req.body?.color);
    const plate_number = sanitizePlate(req.body?.plate_number);
    const seats = sanitizeSeats(req.body?.seats);

    if (!brand || !model || !plate_number) {
      return res.status(400).json({ message: "Brand, model and plate number are required" });
    }

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

exports.updateMyVehicle = async (req, res) => {
  try {
    await ensureVehicleVerificationColumn();
    const userId = req.user.id;

    const currentResult = await pool.query(
      `SELECT *
       FROM vehicles
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [userId]
    );

    const currentVehicle = currentResult.rows[0];
    if (!currentVehicle) {
      return res.status(404).json({ message: "Vehicle not found" });
    }

    const nextBrand =
      req.body?.brand !== undefined ? sanitizeText(req.body.brand) : currentVehicle.brand;
    const nextModel =
      req.body?.model !== undefined ? sanitizeText(req.body.model) : currentVehicle.model;
    const nextColor =
      req.body?.color !== undefined ? sanitizeText(req.body.color) : currentVehicle.color;
    const nextPlate =
      req.body?.plate_number !== undefined
        ? sanitizePlate(req.body.plate_number)
        : currentVehicle.plate_number;
    const nextSeats =
      req.body?.seats !== undefined ? sanitizeSeats(req.body.seats) : currentVehicle.seats;

    if (!nextBrand || !nextModel || !nextPlate) {
      return res.status(400).json({ message: "Brand, model and plate number are required" });
    }

    const result = await pool.query(
      `UPDATE vehicles
       SET brand = $1,
           model = $2,
           color = $3,
           plate_number = $4,
           seats = $5,
           vehicle_verified = FALSE
       WHERE id = $6
       RETURNING *`,
      [nextBrand, nextModel, nextColor, nextPlate, nextSeats, currentVehicle.id]
    );

    res.json({
      success: true,
      vehicle: result.rows[0],
      vehicle_verified: false,
    });
  } catch (err) {
    console.error("updateMyVehicle error:", err);
    res.status(500).json({ message: "Failed to update vehicle" });
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
