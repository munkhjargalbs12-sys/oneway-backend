const pool = require("../db");

// 🚘 Driver машин бүртгэх
exports.createVehicle = async (req, res) => {
  try {
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
    const userId = req.user.id;

    const result = await pool.query(
      "SELECT * FROM vehicles WHERE user_id = $1 LIMIT 1",
      [userId]
    );

    res.json(result.rows[0] || null);
  } catch (err) {
    console.error("❌ getMyVehicle error:", err);
    res.status(500).json({ message: "Failed to get vehicle" });
  }
};
