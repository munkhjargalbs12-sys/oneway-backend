const pool = require("../db");
const avatars = require("../constants/avatars");

const isExpoPushToken = (value) =>
  /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(String(value || "").trim());

const sanitizeText = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
           SELECT BOOL_OR(v.vehicle_verified)
           FROM vehicles v
           WHERE v.user_id = u.id
         ), false) AS vehicle_verified,
         (CASE
           WHEN u.one_way_verified THEN 5
           WHEN u.driver_verified AND COALESCE((
             SELECT BOOL_OR(v.vehicle_verified)
             FROM vehicles v
             WHERE v.user_id = u.id
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
  try {
    const userId = req.user.id;
    const email = sanitizeText(req.body?.email);

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    await pool.query(
      "UPDATE users SET email = $1, email_verified = TRUE WHERE id = $2",
      [email, userId]
    );

    res.json({ success: true, email, email_verified: true });
  } catch (err) {
    console.error("setEmailVerification error:", err);
    res.status(500).json({ message: "Failed to verify email" });
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
