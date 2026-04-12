const crypto = require("crypto");
const pool = require("../db");
const avatars = require("../constants/avatars");
const { sendVerificationCodeEmail } = require("../utils/resend");

const isExpoPushToken = (value) =>
  /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(String(value || "").trim());

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_VERIFICATION_TTL_MINUTES = Math.max(
  1,
  Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES) || 10
);
const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = Math.max(
  0,
  Number(process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS) || 60
);

const sanitizeText = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeEmail = (value) => {
  const normalized = sanitizeText(value);
  return normalized ? normalized.toLowerCase() : null;
};

const hashEmailVerificationCode = (userId, email, code) => {
  const secret = String(
    process.env.EMAIL_VERIFICATION_SECRET || process.env.JWT_SECRET || ""
  );

  return crypto
    .createHash("sha256")
    .update(`${userId}:${email}:${code}:${secret}`)
    .digest("hex");
};

/**
 * GET current user profile
 */
exports.getMe = async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await pool.query(
      `SELECT
         u.id,
         u.name,
         u.phone,
         u.role,
         u.avatar_id,
         u.email,
         COALESCE(u.rating, 1) AS rating,
         COALESCE(u.balance, 0) AS balance,
         COALESCE(u.locked_balance, 0) AS locked_balance,
         u.payment_account,
         u.driver_license_number,
         COALESCE(u.identity_verified, false) AS identity_verified,
         COALESCE(u.driver_license_verified, false) AS driver_license_verified,
         u.verification_status,
         u.verification_submitted_at,
         u.verification_approved_at,
         u.verification_rejected_at,
         u.verification_note,
         COALESCE(u.email_verified, false) AS email_verified,
         COALESCE(u.phone_verified, false) AS phone_verified,
         COALESCE(u.payment_linked, false) AS payment_linked,
         COALESCE(u.driver_verified, false) AS driver_verified,
         COALESCE((
           SELECT v.vehicle_verified
           FROM vehicles v
           WHERE v.user_id = u.id
           ORDER BY v.created_at DESC, v.id DESC
           LIMIT 1
         ), false) AS vehicle_verified,
         (CASE
           WHEN u.one_way_verified THEN 5
           WHEN u.driver_verified AND COALESCE((
             SELECT v.vehicle_verified
             FROM vehicles v
             WHERE v.user_id = u.id
             ORDER BY v.created_at DESC, v.id DESC
             LIMIT 1
           ), false) THEN 4
           WHEN u.payment_linked THEN 3
           WHEN u.email_verified AND u.phone_verified THEN 2
           ELSE 1
         END) AS trust_level
       FROM users u
       WHERE u.id = $1`,
      [userId]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("getMe error:", err);
    res.status(500).json({ message: "Failed to get user" });
  }
};

exports.getPublicById = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const { rows } = await pool.query(
      `SELECT id, name, avatar_id
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("getPublicById error:", err);
    res.status(500).json({ message: "Failed to get user" });
  }
};

/**
 * UPDATE avatar
 */
exports.updateAvatar = async (req, res) => {
  try {
    const userId = req.user.id;
    const { avatar_id } = req.body;
    const { confirm } = req.body;

    if (!avatars.includes(avatar_id)) {
      return res.status(400).json({ message: "Invalid avatar" });
    }

    if (confirm !== true) {
      return res.status(200).json({
        success: true,
        requires_confirmation: true,
        message: "Do you want to save this avatar?",
        avatar_id,
      });
    }

    await pool.query(
      "UPDATE users SET avatar_id = $1 WHERE id = $2",
      [avatar_id, userId]
    );

    res.json({ success: true, avatar_id });
  } catch (err) {
    console.error("updateAvatar error:", err);
    res.status(500).json({ message: "Failed to update avatar" });
  }
};

/**
 * USER RATING SUMMARY
 */
exports.getUserRating = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
         COUNT(*)::int AS total_ratings,
         COALESCE(AVG(rating),0)::numeric(2,1) AS avg_rating
       FROM ratings
       WHERE to_user = $1`,
      [id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("getUserRating error:", err);
    res.status(500).json({ error: "Failed to get rating" });
  }
};

exports.setEmailVerification = async (req, res) => {
  let client;

  try {
    const userId = Number(req.user.id);
    const email = sanitizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    const duplicateEmail = await pool.query(
      `SELECT id
         FROM users
        WHERE LOWER(email) = LOWER($1)
          AND id <> $2
        LIMIT 1`,
      [email, userId]
    );

    if (duplicateEmail.rows.length > 0) {
      return res.status(409).json({ message: "Email is already in use" });
    }

    const currentUserResult = await pool.query(
      `SELECT email, COALESCE(email_verified, FALSE) AS email_verified
         FROM users
        WHERE id = $1`,
      [userId]
    );

    const currentUser = currentUserResult.rows[0];
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    if (
      currentUser.email_verified &&
      String(currentUser.email || "").toLowerCase() === email
    ) {
      return res.json({
        success: true,
        email,
        email_verified: true,
        already_verified: true,
      });
    }

    if (EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS > 0) {
      const cooldownResult = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) AS elapsed_seconds
           FROM email_verification_codes
          WHERE user_id = $1
            AND email = $2
            AND consumed_at IS NULL
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1`,
        [userId, email]
      );

      const elapsedSeconds = Number(cooldownResult.rows[0]?.elapsed_seconds);
      if (
        Number.isFinite(elapsedSeconds) &&
        elapsedSeconds < EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS
      ) {
        const retryAfter = Math.ceil(
          EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS - elapsedSeconds
        );
        return res.status(429).json({
          message: `Please wait ${retryAfter} seconds before requesting a new code`,
          retry_after_seconds: retryAfter,
        });
      }
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashEmailVerificationCode(userId, email, code);
    const expiresAt = new Date(
      Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000
    );

    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM email_verification_codes WHERE user_id = $1",
      [userId]
    );
    await client.query(
      `INSERT INTO email_verification_codes (user_id, email, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, email, codeHash, expiresAt]
    );

    await sendVerificationCodeEmail({
      to: email,
      code,
      expiresInMinutes: EMAIL_VERIFICATION_TTL_MINUTES,
    });

    await client.query("COMMIT");

    res.json({
      success: true,
      email,
      email_verified: false,
      code_sent: true,
      expires_in_seconds: EMAIL_VERIFICATION_TTL_MINUTES * 60,
    });
  } catch (err) {
    console.error("setEmailVerification error:", err);
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("setEmailVerification rollback error:", rollbackError);
      }
    }
    res.status(500).json({ message: "Failed to send verification code" });
  } finally {
    client?.release();
  }
};

exports.confirmEmailVerification = async (req, res) => {
  let client;

  try {
    const userId = Number(req.user.id);
    const email = sanitizeEmail(req.body?.email);
    const code = sanitizeText(req.body?.code || req.body?.verification_code);

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    if (!code) {
      return res.status(400).json({ message: "Verification code is required" });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: "Verification code must be 6 digits" });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const codeResult = await client.query(
      `SELECT id, code_hash, expires_at
         FROM email_verification_codes
        WHERE user_id = $1
          AND email = $2
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [userId, email]
    );

    const verificationRow = codeResult.rows[0];
    if (!verificationRow) {
      await client.query("ROLLBACK");
      client.release();
      client = null;
      return res.status(400).json({ message: "No active verification code found" });
    }

    if (new Date(verificationRow.expires_at).getTime() <= Date.now()) {
      await client.query(
        `DELETE FROM email_verification_codes
          WHERE user_id = $1
            AND email = $2
            AND consumed_at IS NULL`,
        [userId, email]
      );
      await client.query("COMMIT");
      client.release();
      client = null;
      return res.status(400).json({ message: "Verification code has expired" });
    }

    const expectedHash = hashEmailVerificationCode(userId, email, code);
    if (verificationRow.code_hash !== expectedHash) {
      await client.query("ROLLBACK");
      client.release();
      client = null;
      return res.status(400).json({ message: "Invalid verification code" });
    }

    const duplicateEmail = await client.query(
      `SELECT id
         FROM users
        WHERE LOWER(email) = LOWER($1)
          AND id <> $2
        LIMIT 1`,
      [email, userId]
    );

    if (duplicateEmail.rows.length > 0) {
      await client.query("ROLLBACK");
      client.release();
      client = null;
      return res.status(409).json({ message: "Email is already in use" });
    }

    await client.query(
      `UPDATE users
          SET email = $1,
              email_verified = TRUE
        WHERE id = $2`,
      [email, userId]
    );

    await client.query(
      `UPDATE email_verification_codes
          SET consumed_at = NOW()
        WHERE id = $1`,
      [verificationRow.id]
    );

    await client.query(
      `DELETE FROM email_verification_codes
        WHERE user_id = $1
          AND id <> $2`,
      [userId, verificationRow.id]
    );

    await client.query("COMMIT");

    res.json({ success: true, email, email_verified: true });
  } catch (err) {
    console.error("confirmEmailVerification error:", err);
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("confirmEmailVerification rollback error:", rollbackError);
      }
    }
    res.status(500).json({ message: "Failed to verify email" });
  } finally {
    client?.release();
  }
};

exports.setPhoneVerification = async (req, res) => {
  try {
    const userId = req.user.id;
    const phone = sanitizeText(req.body?.phone);

    if (!phone) {
      return res.status(400).json({ message: "Phone is required" });
    }

    const result = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND phone = $2",
      [userId, phone]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Phone does not match registered phone" });
    }

    await pool.query(
      "UPDATE users SET phone_verified = TRUE WHERE id = $1",
      [userId]
    );

    res.json({ success: true, phone, phone_verified: true });
  } catch (err) {
    console.error("setPhoneVerification error:", err);
    res.status(500).json({ message: "Failed to verify phone" });
  }
};

exports.setPaymentLink = async (req, res) => {
  try {
    const userId = req.user.id;
    const payment_account = sanitizeText(req.body?.payment_account) || sanitizeText(req.body?.account);

    if (!payment_account) {
      return res.status(400).json({ message: "Payment account is required" });
    }

    await pool.query(
      "UPDATE users SET payment_account = $1, payment_linked = TRUE WHERE id = $2",
      [payment_account, userId]
    );

    res.json({ success: true, payment_account, payment_linked: true });
  } catch (err) {
    console.error("setPaymentLink error:", err);
    res.status(500).json({ message: "Failed to verify payment account" });
  }
};

exports.setDriverVerification = async (req, res) => {
  try {
    const userId = req.user.id;
    const driver_license_number = sanitizeText(req.body?.driver_license_number);

    if (!driver_license_number) {
      return res.status(400).json({ message: "Driver license number is required" });
    }

    await pool.query(
      `UPDATE users
       SET driver_license_number = $1,
           driver_verified = TRUE,
           driver_license_verified = TRUE,
           verification_status = 'approved',
           verification_submitted_at = COALESCE(verification_submitted_at, NOW()),
           verification_approved_at = NOW(),
           verification_rejected_at = NULL,
           verification_note = NULL
       WHERE id = $2`,
      [driver_license_number, userId]
    );

    res.json({
      success: true,
      driver_license_number,
      driver_verified: true,
      driver_license_verified: true,
      verification_status: "approved",
    });
  } catch (err) {
    console.error("setDriverVerification error:", err);
    res.status(500).json({ message: "Failed to verify driver license" });
  }
};

exports.savePushToken = async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const expoPushToken = sanitizeText(
      req.body?.expo_push_token ?? req.body?.push_token
    );

    if (!expoPushToken || !isExpoPushToken(expoPushToken)) {
      return res.status(400).json({ message: "Invalid Expo push token" });
    }

    await pool.query(
      `UPDATE users
          SET expo_push_token = NULL,
              expo_push_token_updated_at = NOW()
        WHERE id <> $2
          AND expo_push_token = $1`,
      [expoPushToken, userId]
    );

    await pool.query(
      `UPDATE users
          SET expo_push_token = $1,
              expo_push_token_updated_at = NOW()
        WHERE id = $2`,
      [expoPushToken, userId]
    );

    res.json({ success: true, expo_push_token: expoPushToken });
  } catch (err) {
    console.error("savePushToken error:", err);
    res.status(500).json({ message: "Failed to save push token" });
  }
};

exports.clearPushToken = async (req, res) => {
  try {
    const userId = Number(req.user.id);

    await pool.query(
      `UPDATE users
          SET expo_push_token = NULL,
              expo_push_token_updated_at = NOW()
        WHERE id = $1`,
      [userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("clearPushToken error:", err);
    res.status(500).json({ message: "Failed to clear push token" });
  }
};
