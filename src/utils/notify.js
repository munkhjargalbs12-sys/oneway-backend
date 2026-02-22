const pool = require("../db");

exports.createNotification = async ({ userId, title, body, type, relatedId }) => {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, body, type, related_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, title, body, type, relatedId]
    );
  } catch (err) {
    console.error("❌ notify error:", err);
  }
};
