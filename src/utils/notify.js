const pool = require("../db");

exports.createNotification = async (payload) => {
  try {
    const {
      userId,
      title,
      body,
      type = null,
      relatedId = null,
      fromUserId = null,
      fromUserName = null,
      fromAvatarId = null,
      rideId = null,
      bookingId = null,
    } = payload || {};

    const baseValues = {
      user_id: userId,
      title,
      body,
      type,
      related_id: relatedId,
      from_user_id: fromUserId,
      from_user_name: fromUserName,
      from_avatar_id: fromAvatarId,
      ride_id: rideId,
      booking_id: bookingId,
    };

    const keys = Object.keys(baseValues);
    const colRes = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'notifications'
          AND column_name = ANY($1)`,
      [keys]
    );

    const existing = new Set(colRes.rows.map((r) => r.column_name));
    const cols = keys.filter((k) => existing.has(k) && typeof baseValues[k] !== "undefined");
    if (cols.length === 0) return;

    const params = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map((k) => baseValues[k]);

    await pool.query(
      `INSERT INTO notifications (${cols.join(", ")})
       VALUES (${params.join(", ")})`,
      values
    );
  } catch (err) {
    console.error("notify error:", err);
  }
};
