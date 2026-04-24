const pool = require("../db");
const { sendPushToUser } = require("./push");

const RIDE_LEVEL_DEDUPED_TYPES = new Set(["ride_reminder", "ride_started_auto"]);

async function ensureNotificationHiddenColumn() {
  await pool.query(
    "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMP"
  );
}

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

  if (
    RIDE_LEVEL_DEDUPED_TYPES.has(normalizedType) &&
    existingColumns.has("user_id") &&
    existingColumns.has("ride_id") &&
    existingColumns.has("type") &&
    Number.isFinite(userId) &&
    userId > 0 &&
    Number.isFinite(rideId) &&
    rideId > 0
  ) {
    const duplicateByRide = await pool.query(
      `SELECT id
         FROM notifications
        WHERE user_id = $1
          AND ride_id = $2
          AND LOWER(COALESCE(type, '')) = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [userId, rideId, normalizedType]
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
      role = null,
      data = null,
      sound = "default",
      channelId = "default",
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
    if (duplicate) return { ...duplicate, created: false };

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

    const inserted = result.rows[0]
      ? { ...result.rows[0], created: true }
      : null;

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
          role: role || null,
          screen: "/notifications",
          ...(data && typeof data === "object" ? data : {}),
        },
        sound,
        channelId,
      }).catch((pushErr) => {
        console.error("push send error:", pushErr.message || pushErr);
      });
    }

    return inserted;
  } catch (err) {
    console.error("notify error:", err);
  }
};

exports.hideRideReminderNotifications = async ({ rideId, userIds = [] } = {}) => {
  try {
    const normalizedRideId = Number(rideId);
    if (!Number.isFinite(normalizedRideId) || normalizedRideId <= 0) {
      return { hiddenCount: 0 };
    }

    const normalizedUserIds = Array.from(
      new Set(
        (Array.isArray(userIds) ? userIds : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
      )
    );

    await ensureNotificationHiddenColumn();

    const params = [normalizedRideId, "ride_reminder"];
    const userFilter =
      normalizedUserIds.length > 0
        ? `AND user_id = ANY($${params.push(normalizedUserIds)}::int[])`
        : "";

    const result = await pool.query(
      `UPDATE notifications
          SET hidden_at = COALESCE(hidden_at, NOW())
        WHERE ride_id = $1
          AND LOWER(COALESCE(type, '')) = $2
          AND hidden_at IS NULL
          ${userFilter}`,
      params
    );

    return { hiddenCount: result.rowCount };
  } catch (err) {
    console.error("hide ride reminder notifications error:", err);
    return { hiddenCount: 0 };
  }
};
