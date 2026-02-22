const pool = require("../db");

/**
 * ⭐ Create rating + update user average
 */
exports.createRating = async (req, res) => {
  const fromUser = req.user.id;
  const { ride_id, to_user_id, rating, comment } = req.body;

  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: "Invalid rating" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO ratings (ride_id, from_user, to_user, rating, comment)
       VALUES ($1,$2,$3,$4,$5)`,
      [ride_id, fromUser, to_user_id, rating, comment]
    );

    // 🔄 Recalculate user rating
    const result = await client.query(
      `SELECT AVG(rating)::numeric(2,1) as avg_rating,
              COUNT(*) as total
       FROM ratings
       WHERE to_user = $1`,
      [to_user_id]
    );

    const avg = result.rows[0].avg_rating || 0;
    const total = result.rows[0].total;

    await client.query(
      `UPDATE users
       SET rating = $1,
           total_rides = $2
       WHERE id = $3`,
      [avg, total, to_user_id]
    );

    await client.query("COMMIT");

    res.json({ success: true, avg_rating: avg });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ rating error:", err);
    res.status(500).json({ error: "Failed to submit rating" });
  } finally {
    client.release();
  }
};
