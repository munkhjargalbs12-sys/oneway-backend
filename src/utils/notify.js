const pool = require("../db");
const { sendPushToUser } = require("./push");

async function findDuplicateNotification(existingColumns, payload) {
  const normalizedType = String(payload?.type || "").trim().toLowerCase();
  const userId = Number(payload?.userId);
  const bookingId = Number(payload?.bookingId);
  const fromUserId = Number(payload?.fromUserId);
  const rideId = Number(payload?.rideId);

  if (
    normalizedType &&
    existingColumns.has("user_id") &&
    existingColumns.has("booking_id") &&
    existingColumns.has("type") &&
    Number.isFinite(userId) &&
    userId > 0 &&
    Number.isFinite(bookingId) &&
    bookingId > 0
  ) {
    const duplicateByBooking = await pool.query(
      `SELECT id
         FROM notifications
        WHERE user_id = $1
          AND booking_id = $2
          AND LOWER(COALESCE(type, '')) = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [userId, bookingId, normalizedType]
    );

    if (duplicateByBooking.rowCount > 0) {
      return duplicateByBooking.rows[0];
    }
  }

  if (
    normalizedType === "booking" &&
    existingColumns.has("user_id") &&
    existingColumns.has("from_user_id") &&
    existingColumns.has("ride_id") &&
    existingColumns.has("type") &&
    Number.isFinite(userId) &&
    userId > 0 &&
    Number.isFinite(fromUserId) &&
    fromUserId > 0 &&
    Number.isFinite(rideId) &&
    rideId > 0
  ) {
    const duplicateByRide = await pool.query(
      `SELECT id
         FROM notifications
        WHERE user_id = $1
          AND from_user_id = $2
          AND ride_id = $3
          AND LOWER(COALESCE(type, '')) = $4
          AND created_at >= NOW() - INTERVAL '10 minutes'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [userId, fromUserId, rideId, normalizedType]
    );

    if (duplicateByRide.rowCount > 0) {
      return duplicateByRide.rows[0];
    }
  }

  return null;
}

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
    const duplicate = await findDuplicateNotification(existing, {
      userId,
      type,
      bookingId,
      fromUserId,
      rideId,
    });
    if (duplicate) return duplicate;

    const cols = keys.filter((k) => existing.has(k) && typeof baseValues[k] !== "undefined");
    if (cols.length === 0) return;

    const params = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map((k) => baseValues[k]);

    const result = await pool.query(
      `INSERT INTO notifications (${cols.join(", ")})
       VALUES (${params.join(", ")})
       RETURNING id`,
      values
    );

    const inserted = result.rows[0] || null;

    if (inserted?.id && Number.isFinite(Number(userId)) && title && body) {
      sendPushToUser(Number(userId), {
        title,
        body,
        data: {
          notificationId: Number(inserted.id),
          type: type || null,
          relatedId: relatedId || null,
          rideId: rideId || null,
          bookingId: bookingId || null,
          screen: "/notifications",
        },
        sound: "default",
      }).catch((pushErr) => {
        console.error("push send error:", pushErr.message || pushErr);
      });
    }

    return inserted;
  } catch (err) {
    console.error("notify error:", err);
  }
};
