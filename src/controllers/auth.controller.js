const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../db");

/**
 * 🆕 Register
 */
exports.register = async (req, res) => {
  const { phone, password, name, role = "passenger", avatar_id, avatar } = req.body;
  const resolvedAvatarId = avatar_id || avatar || "guy";

  // 🔎 Required
  if (!phone || !password || !name) {
    return res.status(400).json({ message: "Name, phone and password required" });
  }

  // 📱 Phone basic validation (8 digit)
  if (!/^[0-9]{8}$/.test(phone)) {
    return res.status(400).json({ message: "Invalid phone number" });
  }

  // 🔐 Password strength
  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  // 👤 Role validation
  if (!["passenger", "driver"].includes(role)) {
    return res.status(400).json({ message: "Invalid role" });
  }

  try {
    // Давхардал шалгах
    const existing = await pool.query(
      "SELECT id FROM users WHERE phone=$1",
      [phone]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Phone already registered" });
    }

    const hash = await bcrypt.hash(password, 12);

    const { rows } = await pool.query(
      `
      INSERT INTO users (phone, password_hash, name, role, avatar_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, phone, name, role, avatar_id
      `,
      [phone, hash, name, role, resolvedAvatarId]
    );

    const user = rows[0];

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({ token, user });
  } catch (err) {
    console.error("❌ Register error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * 🔐 Login
 */
exports.login = async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ message: "Phone and password required" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE phone = $1",
      [phone]
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (user.is_blocked) {
      return res.status(403).json({ message: "Account is blocked" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    await pool.query(
      "UPDATE users SET last_login_at = NOW() WHERE id=$1",
      [user.id]
    );

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        avatar_id: user.avatar_id,
        rating: user.rating,
      },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * 🧑‍✈️ Set role
 */
exports.setRole = async (req, res) => {
  try {
    const userId = req.user.id;
    const { role } = req.body;

    if (!["driver", "passenger"].includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    await pool.query(
      "UPDATE users SET role = $1 WHERE id = $2",
      [role, userId]
    );

    res.json({ success: true, role });
  } catch (err) {
    console.error("❌ setRole error:", err);
    res.status(500).json({ message: "Failed to set role" });
  }
};
