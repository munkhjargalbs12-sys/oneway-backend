const pool = require("../db");
const { createNotification } = require("../utils/notify");

exports.bookSeat = async (req, res) => {
  const userId = req.user.id;
  const { ride_id, seats = 1 } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const rideRes = await client.query(
      `SELECT user_id, seats_total, seats_taken, status
       FROM rides
       WHERE id=$1
       FOR UPDATE`,
      [ride_id]
    );

    if (rideRes.rows.length === 0)
      throw new Error("Ride not found");

    const ride = rideRes.rows[0];

    if (ride.status !== "active")
      throw new Error("Ride not available");

    if (ride.seats_taken + seats > ride.seats_total)
      throw new Error("Not enough seats");

    // 🎟 Booking insert
    await client.query(
      `INSERT INTO bookings (ride_id, user_id, seats_booked)
       VALUES ($1,$2,$3)`,
      [ride_id, userId, seats]
    );

    // 🪑 Seats update
    const newTaken = ride.seats_taken + seats;
    const newStatus = newTaken >= ride.seats_total ? "full" : "active";

    await client.query(
      `UPDATE rides
       SET seats_taken=$1, status=$2
       WHERE id=$3`,
      [newTaken, newStatus, ride_id]
    );

    await client.query("COMMIT");

    // 🔔 Driver notification (transaction-аас гадуур)
    await createNotification({
      userId: ride.user_id,
      title: "Шинэ захиалга",
      body: "Таны чиглэлд зорчигч суудал захиаллаа",
      type: "booking",
      relatedId: ride_id,
    });

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ booking error:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};
