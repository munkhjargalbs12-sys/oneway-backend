const pool = require("../db");

const expectedRatingErrors = new Set([
  "Invalid ride_id",
  "Invalid rating",
  "Ride not found",
  "Ride is not completed",
  "Invalid to_user_id",
  "You did not participate in this ride",
  "Passenger did not participate in this ride",
  "No-show bookings cannot be rated",
  "You cannot rate yourself",
  "You have already rated this user for this ride",
]);

exports.createRating = async (req, res) => {
  const fromUserId = Number(req.user.id);
  const rideId = Number(req.body?.ride_id);
  const requestedToUserId = Number(req.body?.to_user_id);
  const rating = Number(req.body?.rating);
  const comment =
    typeof req.body?.comment === "string" && req.body.comment.trim().length > 0
      ? req.body.comment.trim()
      : null;

  if (!Number.isFinite(rideId) || rideId <= 0) {
    return res.status(400).json({ error: "Invalid ride_id" });
  }

  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Invalid rating" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const rideRes = await client.query(
      `SELECT id, user_id, status
       FROM rides
       WHERE id = $1
       LIMIT 1`,
      [rideId]
    );

    if (rideRes.rowCount === 0) {
      throw new Error("Ride not found");
    }

    const ride = rideRes.rows[0];
    if (String(ride.status || "").toLowerCase() !== "completed") {
      throw new Error("Ride is not completed");
    }

    let toUserId = null;

    if (Number(ride.user_id) === fromUserId) {
      if (!Number.isFinite(requestedToUserId) || requestedToUserId <= 0) {
        throw new Error("Invalid to_user_id");
      }

      const passengerRes = await client.query(
        `SELECT id
         FROM bookings
         WHERE ride_id = $1
           AND user_id = $2
           AND COALESCE(status, 'approved') = 'approved'
         LIMIT 1`,
        [rideId, requestedToUserId]
      );

      if (passengerRes.rowCount === 0) {
        throw new Error("Passenger did not participate in this ride");
      }

      toUserId = requestedToUserId;
    } else {
      const bookingRes = await client.query(
        `SELECT COALESCE(status, 'approved') AS status,
                COALESCE(attendance_status, 'unknown') AS attendance_status
         FROM bookings
         WHERE ride_id = $1
           AND user_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [rideId, fromUserId]
      );

      if (bookingRes.rowCount === 0 || bookingRes.rows[0].status !== "approved") {
        throw new Error("You did not participate in this ride");
      }

      if (bookingRes.rows[0].attendance_status === "no_show") {
        throw new Error("No-show bookings cannot be rated");
      }

      toUserId = Number(ride.user_id);
      if (
        Number.isFinite(requestedToUserId) &&
        requestedToUserId > 0 &&
        requestedToUserId !== toUserId
      ) {
        throw new Error("Invalid to_user_id");
      }
    }

    if (!Number.isFinite(toUserId) || toUserId <= 0) {
      throw new Error("Invalid to_user_id");
    }

    if (toUserId === fromUserId) {
      throw new Error("You cannot rate yourself");
    }

    const duplicateRes = await client.query(
      `SELECT id
       FROM ratings
       WHERE ride_id = $1
         AND from_user = $2
         AND to_user = $3
       LIMIT 1`,
      [rideId, fromUserId, toUserId]
    );

    if (duplicateRes.rowCount > 0) {
      throw new Error("You have already rated this user for this ride");
    }

    await client.query(
      `INSERT INTO ratings (ride_id, from_user, to_user, rating, comment)
       VALUES ($1, $2, $3, $4, $5)`,
      [rideId, fromUserId, toUserId, rating, comment]
    );

    const avgRes = await client.query(
      `SELECT COALESCE(AVG(rating), 0)::numeric(2,1) AS avg_rating
       FROM ratings
       WHERE to_user = $1`,
      [toUserId]
    );

    const avgRating = Number(avgRes.rows[0]?.avg_rating || 0);

    await client.query(
      `UPDATE users
       SET rating = $1
       WHERE id = $2`,
      [avgRating, toUserId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      ride_id: rideId,
      to_user_id: toUserId,
      avg_rating: avgRating,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("rating error:", err);

    if (expectedRatingErrors.has(err.message)) {
      return res.status(400).json({ error: err.message });
    }

    res.status(500).json({ error: "Failed to submit rating" });
  } finally {
    client.release();
  }
};
