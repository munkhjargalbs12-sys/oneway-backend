const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../db");

function resolveTrustLevel(user) {
  if (user?.one_way_verified) return 5;
  if (user?.driver_verified) return 4;
  if (user?.payment_linked) return 3;
  if (user?.email_verified && user?.phone_verified) return 2;
  return 1;
}

/**
 * Register
 */
exports.register = async (req, res) => {
  const {
    phone,
    password,
    confirmPassword,
    confirm_password,
    password_confirmation,
    name,
    role = "passenger",
    avatar_id,
    avatar,
  } = req.body;
  const resolvedAvatarId = avatar_id || avatar || "guy";

  if (!phone || !password || !name) {
    return res.status(400).json({ message: "Name, phone and password required" });
  }

  const normalizedPassword = String(password).trim();
  const repeatedPassword = String(confirmPassword || confirm_password || password_confirmation || "").trim();
  if (!repeatedPassword) {
    return res.status(400).json({ message: "Password confirmation is required" });
  }

  if (normalizedPassword !== repeatedPassword) {
    return res.status(400).json({ message: "Password and password confirmation do not match" });
  }

  if (!/^[0-9]{8}$/.test(phone)) {
    return res.status(400).json({ message: "Invalid phone number" });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  if (!["passenger", "driver"].includes(role)) {
    return res.status(400).json({ message: "Invalid role" });
  }

  try {
    const existing = await pool.query(
      "SELECT id FROM users WHERE phone=$1",
      [phone]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Phone already registered" });
    }

    const hash = await bcrypt.hash(normalizedPassword, 12);

    const { rows } = await pool.query(
      `
      INSERT INTO users (
        phone, password_hash, name, role, avatar_id, rating, email_verified, phone_verified, identity_verified, driver_license_verified, payment_linked, driver_verified, one_way_verified
      ) VALUES (
        $1, $2, $3, $4, $5, 1, false, false, false, false, false, false, false
      )
      RETURNING id, phone, name, role, avatar_id, rating,
                email_verified, phone_verified, identity_verified, driver_license_verified,
                payment_linked, driver_verified, one_way_verified,
                verification_status, verification_submitted_at, verification_approved_at, verification_rejected_at, verification_note
      `,
      [phone, hash, name, role, resolvedAvatarId]
    );

    const user = rows[0];

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        avatar_id: user.avatar_id,
        rating: Number(user.rating ?? 1),
        email_verified: Boolean(user.email_verified),
        phone_verified: Boolean(user.phone_verified),
        identity_verified: Boolean(user.identity_verified),
        driver_license_verified: Boolean(user.driver_license_verified),
        verification_status: user.verification_status,
        verification_submitted_at: user.verification_submitted_at,
        verification_approved_at: user.verification_approved_at,
        verification_rejected_at: user.verification_rejected_at,
        verification_note: user.verification_note,
        trust_level: resolveTrustLevel(user),
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Login
 */
exports.login = async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ message: "Phone and password required" });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        *,
        (CASE
          WHEN one_way_verified THEN 5
          WHEN driver_verified THEN 4
          WHEN payment_linked THEN 3
          WHEN email_verified AND phone_verified THEN 2
          ELSE 1
        END) AS trust_level
      FROM users
      WHERE phone = $1
      `,
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
        rating: Number(user.rating ?? 1),
        email_verified: Boolean(user.email_verified),
        phone_verified: Boolean(user.phone_verified),
        identity_verified: Boolean(user.identity_verified),
        driver_license_verified: Boolean(user.driver_license_verified),
        verification_status: user.verification_status,
        verification_submitted_at: user.verification_submitted_at,
        verification_approved_at: user.verification_approved_at,
        verification_rejected_at: user.verification_rejected_at,
        verification_note: user.verification_note,
        trust_level: Number(user.trust_level ?? resolveTrustLevel(user)),
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Set role
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
    console.error("setRole error:", err);
    res.status(500).json({ message: "Failed to set role" });
  }
};
