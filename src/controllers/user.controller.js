const pool = require("../db");
const avatars = require("../constants/avatars");
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
         id,
         name,
         phone,
         role,
         avatar_id,
         email,
         COALESCE(rating, 1) AS rating,
         payment_account,
         driver_license_number,
         COALESCE(identity_verified, false) AS identity_verified,
         COALESCE(driver_license_verified, false) AS driver_license_verified,
         verification_status,
         verification_submitted_at,
         verification_approved_at,
         verification_rejected_at,
         verification_note,
         COALESCE(email_verified, false) AS email_verified,
         COALESCE(phone_verified, false) AS phone_verified,
         COALESCE(payment_linked, false) AS payment_linked,
         COALESCE(driver_verified, false) AS driver_verified,
         (CASE
           WHEN one_way_verified THEN 5
           WHEN driver_verified THEN 4
           WHEN payment_linked THEN 3
           WHEN email_verified AND phone_verified THEN 2
           ELSE 1
         END) AS trust_level
       FROM users
       WHERE id = $1`,
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
      "UPDATE users SET driver_license_number = $1, driver_verified = TRUE WHERE id = $2",
      [driver_license_number, userId]
    );

    res.json({
      success: true,
      driver_license_number,
      driver_verified: true
    });
  } catch (err) {
    console.error("setDriverVerification error:", err);
    res.status(500).json({ message: "Failed to verify driver license" });
  }
};
