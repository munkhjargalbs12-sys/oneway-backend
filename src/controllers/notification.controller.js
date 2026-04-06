const pool = require("../db");
const { createNotification } = require("../utils/notify");

function isGenericName(v) {
  const s = String(v || "").trim().toLowerCase();
  return !s || s === "хэрэглэгч" || s === "хэрэлэгч" || s === "user";
}

async function getNotificationMeta(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'notifications' AND column_name IN ('from_user_id', 'booking_id'))
          OR (table_name = 'bookings' AND column_name IN ('status', 'attendance_status'))
        )`
  );

  const cols = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  return {
    hasFromUserId: cols.has("notifications.from_user_id"),
    hasBookingId: cols.has("notifications.booking_id"),
    hasBookingStatus: cols.has("bookings.status"),
    hasAttendanceStatus: cols.has("bookings.attendance_status"),
  };
}

exports.getMyNotifications = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const meta = await getNotificationMeta(client);
    const selectParts = ["n.*"];
    let joinClause = "";

    if (meta.hasBookingId && (meta.hasBookingStatus || meta.hasAttendanceStatus)) {
      if (meta.hasBookingStatus) {
        selectParts.push(`CASE
          WHEN n.booking_id IS NOT NULL AND b.id IS NULL THEN 'canceled'
          ELSE b.status
        END AS booking_status`);
      }
      if (meta.hasAttendanceStatus) {
        selectParts.push("b.attendance_status");
      }
      joinClause = "LEFT JOIN bookings b ON b.id = n.booking_id";
    }

    const { rows } = await client.query(
      `SELECT ${selectParts.join(", ")}
         FROM notifications n
         ${joinClause}
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC`,
      [userId]
    );

    if (!rows.length) return res.json(rows);

    const ids = meta.hasFromUserId
      ? Array.from(
          new Set(
            rows
              .map((n) => Number(n?.from_user_id))
              .filter((id) => Number.isFinite(id) && id > 0)
          )
        )
      : [];

    if (ids.length > 0) {
      const usersRes = await client.query(
        `SELECT id, name, avatar_id
         FROM users
         WHERE id = ANY($1)`,
        [ids]
      );
      const byId = Object.fromEntries(usersRes.rows.map((u) => [Number(u.id), u]));

      for (const n of rows) {
        const fromId = Number(n?.from_user_id);
        const u = byId[fromId];
        if (!u) continue;

        if (isGenericName(n.from_user_name)) {
          n.from_user_name = u.name || n.from_user_name;
        }
        if (!n.from_avatar_id && u.avatar_id) {
          n.from_avatar_id = u.avatar_id;
        }
      }
    }

    res.json(rows);
  } catch (err) {
    console.error("getMyNotifications error:", err);
    res.status(500).json({ error: "Failed to get notifications" });
  } finally {
    client.release();
  }
};

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
    console.error("markAsRead error:", err);
    res.status(500).json({ error: "Failed to update notification" });
  }
};

exports.createNotificationEntry = async (req, res) => {
  try {
    const fromUserId = Number(req.user.id);
    const {
      to_user_id,
      title,
      body,
      type = "booking",
      related_id = null,
      ride_id = null,
      booking_id = null,
      from_user_name = null,
      from_avatar_id = null,
    } = req.body || {};

    const toUserId = Number(to_user_id);
    if (!Number.isFinite(toUserId) || toUserId <= 0) {
      return res.status(400).json({ error: "Invalid to_user_id" });
    }
    if (!title || !body) {
      return res.status(400).json({ error: "title and body are required" });
    }

    await createNotification({
      userId: toUserId,
      title,
      body,
      type,
      relatedId: related_id ?? ride_id,
      fromUserId,
      fromUserName: from_user_name,
      fromAvatarId: from_avatar_id,
      rideId: ride_id,
      bookingId: booking_id,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("createNotificationEntry error:", err);
    res.status(500).json({ error: "Failed to create notification" });
  }
};
