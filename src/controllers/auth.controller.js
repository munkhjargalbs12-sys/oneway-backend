const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { sendPasswordResetCodeEmail } = require("../utils/resend");

const PASSWORD_RESET_CODE_TTL_MINUTES = 10;

function resolveTrustLevel(user) {
  if (user?.one_way_verified) return 5;
  if (user?.driver_verified && user?.vehicle_verified) return 4;
  if (user?.payment_linked) return 3;
  if (user?.email_verified && user?.phone_verified) return 2;
  return 1;
}

function normalizeAccountRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (value === "rider") return "passenger";
  if (value === "driver" || value === "passenger") return value;
  return null;
}

function generateResetCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function maskEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const [name, domain] = email.split("@");
  if (!name || !domain) return "";
  const visible = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(2, name.length - visible.length))}@${domain}`;
}

function hashPasswordResetCode(userId, email, code) {
  const secret = process.env.JWT_SECRET || process.env.PASSWORD_RESET_SECRET || "oneway-password-reset";
  return crypto
    .createHash("sha256")
    .update(`${userId}:${email}:${code}:${secret}`)
    .digest("hex");
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
  const normalizedRole = normalizeAccountRole(role);

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

  if (!normalizedRole) {
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
                balance, locked_balance,
                email_verified, phone_verified, identity_verified, driver_license_verified,
                payment_linked, driver_verified, one_way_verified,
                verification_status, verification_submitted_at, verification_approved_at, verification_rejected_at, verification_note
      `,
      [phone, hash, name, normalizedRole, resolvedAvatarId]
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
        balance: Number(user.balance ?? 0),
        locked_balance: Number(user.locked_balance ?? 0),
        email_verified: Boolean(user.email_verified),
        phone_verified: Boolean(user.phone_verified),
        identity_verified: Boolean(user.identity_verified),
        driver_license_verified: Boolean(user.driver_license_verified),
        vehicle_verified: false,
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
        COALESCE((
          SELECT BOOL_OR(v.vehicle_verified)
          FROM vehicles v
          WHERE v.user_id = users.id
        ), FALSE) AS vehicle_verified,
        (CASE
          WHEN one_way_verified THEN 5
          WHEN driver_verified AND COALESCE((
            SELECT BOOL_OR(v.vehicle_verified)
            FROM vehicles v
            WHERE v.user_id = users.id
          ), FALSE) THEN 4
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
        balance: Number(user.balance ?? 0),
        locked_balance: Number(user.locked_balance ?? 0),
        email_verified: Boolean(user.email_verified),
        phone_verified: Boolean(user.phone_verified),
        identity_verified: Boolean(user.identity_verified),
        driver_license_verified: Boolean(user.driver_license_verified),
        vehicle_verified: Boolean(user.vehicle_verified),
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

exports.requestPasswordReset = async (req, res) => {
  const phone = String(req.body?.phone || "").trim();

  if (!phone) {
    return res.status(400).json({ message: "Phone is required" });
  }

  if (!/^[0-9]{8}$/.test(phone)) {
    return res.status(400).json({ message: "Invalid phone number" });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT id, email, COALESCE(email_verified, FALSE) AS email_verified, COALESCE(is_blocked, FALSE) AS is_blocked
        FROM users
       WHERE phone = $1
       LIMIT 1
      `,
      [phone]
    );

    const user = rows[0];
    if (!user || user.is_blocked) {
      return res.json({ success: true });
    }

    const email = String(user.email || "").trim().toLowerCase();
    if (!email || !user.email_verified) {
      return res.status(400).json({ message: "Verified email is required to reset password" });
    }

    const code = generateResetCode();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_CODE_TTL_MINUTES * 60 * 1000);
    const codeHash = hashPasswordResetCode(user.id, email, code);

    await pool.query("DELETE FROM password_reset_codes WHERE user_id = $1", [user.id]);
    await pool.query(
      `
      INSERT INTO password_reset_codes (user_id, email, code_hash, expires_at)
      VALUES ($1, $2, $3, $4)
      `,
      [user.id, email, codeHash, expiresAt]
    );

    await sendPasswordResetCodeEmail({
      to: email,
      code,
      expiresInMinutes: PASSWORD_RESET_CODE_TTL_MINUTES,
    });

    res.json({ success: true, masked_email: maskEmail(email) });
  } catch (err) {
    console.error("requestPasswordReset error:", err);
    res.status(500).json({ message: "Failed to send password reset code" });
  }
};

exports.confirmPasswordReset = async (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  const code = String(req.body?.code || "").trim();
  const password = String(req.body?.password || "").trim();
  const confirmPassword = String(
    req.body?.confirmPassword || req.body?.confirm_password || req.body?.password_confirmation || ""
  ).trim();

  if (!phone || !code || !password || !confirmPassword) {
    return res.status(400).json({ message: "Phone, code and password are required" });
  }

  if (!/^[0-9]{8}$/.test(phone)) {
    return res.status(400).json({ message: "Invalid phone number" });
  }

  if (!/^[0-9]{6}$/.test(code)) {
    return res.status(400).json({ message: "Invalid reset code" });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ message: "Password and password confirmation do not match" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT u.id, u.email, prc.code_hash, prc.expires_at
        FROM users u
        JOIN password_reset_codes prc ON prc.user_id = u.id
       WHERE u.phone = $1
         AND LOWER(prc.email) = LOWER(COALESCE(u.email, ''))
         AND COALESCE(u.email_verified, FALSE) = TRUE
         AND prc.consumed_at IS NULL
       ORDER BY prc.created_at DESC
       LIMIT 1
      `,
      [phone]
    );

    const reset = rows[0];
    if (!reset) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid or expired reset code" });
    }

    if (new Date(reset.expires_at).getTime() < Date.now()) {
      await client.query(
        "DELETE FROM password_reset_codes WHERE user_id = $1",
        [reset.id]
      );
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid or expired reset code" });
    }

    const expectedHash = hashPasswordResetCode(reset.id, String(reset.email || "").trim().toLowerCase(), code);
    if (expectedHash !== reset.code_hash) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid or expired reset code" });
    }

    const hash = await bcrypt.hash(password, 12);
    await client.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2",
      [hash, reset.id]
    );
    await client.query(
      "UPDATE password_reset_codes SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL",
      [reset.id]
    );

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    console.error("confirmPasswordReset error:", err);
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("confirmPasswordReset rollback error:", rollbackError);
    }
    res.status(500).json({ message: "Failed to reset password" });
  } finally {
    client.release();
  }
};

/**
 * Set role
 */
exports.setRole = async (req, res) => {
  try {
    const userId = req.user.id;
    const { role } = req.body;
    const normalizedRole = normalizeAccountRole(role);

    if (!normalizedRole) {
      return res.status(400).json({ message: "Invalid role" });
    }

    await pool.query(
      "UPDATE users SET role = $1 WHERE id = $2",
      [normalizedRole, userId]
    );

    res.json({ success: true, role: normalizedRole });
  } catch (err) {
    console.error("setRole error:", err);
    res.status(500).json({ message: "Failed to set role" });
  }
};
