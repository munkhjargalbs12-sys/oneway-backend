const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");

const {
  createRide,
  getRides,
  getRideById,
  getMyRides,
  getActiveRide,
  startRide,
  completeRide,
  cancelRide,
} = require("../controllers/ride.controller");

// 🌍 Public — бүх active rides
router.get("/", getRides);

// 🔐 Auth required
router.get("/mine", auth, getMyRides);
router.get("/active", auth, getActiveRide);
router.post("/", auth, createRide);

// 🚦 Ride lifecycle
router.patch("/:id/start", auth, startRide);
router.patch("/:id/complete", auth, completeRide);
router.patch("/:id/cancel", auth, cancelRide);

// 🌍 Dynamic route LAST
router.get("/:id", getRideById);

module.exports = router;
