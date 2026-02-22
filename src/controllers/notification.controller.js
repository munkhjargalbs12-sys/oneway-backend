const pool = require("../db");

// 🔔 Миний notification-ууд
exports.getMyNotifications = async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error("❌ getMyNotifications error:", err);
    res.status(500).json({ error: "Failed to get notifications" });
  }
};

// ✅ Уншсан болгох
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await pool.query(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ markAsRead error:", err);
    res.status(500).json({ error: "Failed to update notification" });
  }
};
