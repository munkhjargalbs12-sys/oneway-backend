const pool = require("../db");
const avatars = require("../constants/avatars");

/**
 * 👤 GET current user profile
 * 🔐 auth middleware req.user.id өгнө
 */
exports.getMe = async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await pool.query(
      `SELECT id, name, phone, role, avatar_id
       FROM users
       WHERE id = $1`,
      [userId]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ getMe error:", err);
    res.status(500).json({ message: "Failed to get user" });
  }
};

/**
 * 🖼 UPDATE avatar
 */
exports.updateAvatar = async (req, res) => {
  try {
    const userId = req.user.id;
    const { avatar_id } = req.body;

    if (!avatars.includes(avatar_id)) {
      return res.status(400).json({ message: "Invalid avatar" });
    }

    await pool.query(
      "UPDATE users SET avatar_id = $1 WHERE id = $2",
      [avatar_id, userId]
    );

    res.json({ success: true, avatar_id });
  } catch (err) {
    console.error("❌ updateAvatar error:", err);
    res.status(500).json({ message: "Failed to update avatar" });
  }
};

/**
 * ⭐ USER RATING SUMMARY
 * Public endpoint
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
    console.error("❌ getUserRating error:", err);
    res.status(500).json({ error: "Failed to get rating" });
  }
};
