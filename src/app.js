const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const rideRoutes = require("./routes/ride.routes");
const bookingRoutes = require("./routes/booking.routes");
const userRoutes = require("./routes/user.routes");
const ratingRoutes = require("./routes/rating.routes");
const vehicleRoutes = require("./routes/vehicle.routes");
const notificationRoutes = require("./routes/notification.routes");
const routeRoutes = require("./routes/route.routes");
const walletRoutes = require("./routes/wallet.routes");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "oneway-backend" });
});

app.use("/auth", authRoutes);
app.use("/rides", rideRoutes);
app.use("/bookings", bookingRoutes);
app.use("/users", userRoutes);
app.use("/ratings", ratingRoutes);
app.use("/vehicles", vehicleRoutes);
app.use("/notifications", notificationRoutes);
app.use("/route", routeRoutes); // 
app.use("/wallet", walletRoutes);

module.exports = app;
