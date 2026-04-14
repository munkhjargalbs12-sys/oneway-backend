const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../db");

function signAdminToken(admin) {
  return jwt.sign(
    {
      adminUserId: Number(admin.id),
      role: admin.role || "super_admin",
    },
    process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function toAdminPayload(row) {
  return {
    id: Number(row.id),
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    is_active: Boolean(row.is_active),
    last_login_at: row.last_login_at,
  };
}

exports.login = async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, password_hash, full_name, role, is_active, last_login_at
         FROM admin_users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1`,
      [email]
    );

    const admin = result.rows[0];
    if (!admin || !admin.is_active) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    await pool.query(
      "UPDATE admin_users SET last_login_at = NOW() WHERE id = $1",
      [admin.id]
    );

    const token = signAdminToken(admin);
    res.json({
      token,
      admin: toAdminPayload(admin),
    });
  } catch (err) {
    console.error("admin login error:", err);
    res.status(500).json({ message: "Failed to sign in" });
  }
};

exports.getMe = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, role, is_active, last_login_at
         FROM admin_users
        WHERE id = $1
        LIMIT 1`,
      [req.admin.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Admin user not found" });
    }

    res.json({ admin: toAdminPayload(result.rows[0]) });
  } catch (err) {
    console.error("admin getMe error:", err);
    res.status(500).json({ message: "Failed to load admin profile" });
  }
};
