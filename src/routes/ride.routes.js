const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");

const {
  createRide,
  getRides,
  searchRides,
  getRideById,
  getMyRides,
  getMyAllRides,
  getActiveRide,
  getMyRideHistory,
  hideRideHistoryEntry,
  startRide,
  completeRide,
  cancelRide,
} = require("../controllers/ride.controller");
const {
  syncRideMeetupPresence,
  getRideMeetupPresence,
} = require("../controllers/ridePresence.controller");

// 🌍 Public — бүх active rides
router.get("/", getRides);
router.post("/search", searchRides);

// 🔐 Auth required
router.get("/mine", auth, getMyRides);
router.get("/mine/all", auth, getMyAllRides);
router.get("/active", auth, getActiveRide);
router.get("/history", auth, getMyRideHistory);
router.post("/", auth, createRide);
router.delete("/:id/history", auth, hideRideHistoryEntry);

// 🚦 Ride lifecycle
router.get("/:id/presence", auth, getRideMeetupPresence);
router.post("/:id/presence", auth, syncRideMeetupPresence);
router.patch("/:id/start", auth, startRide);
router.patch("/:id/complete", auth, completeRide);
router.patch("/:id/cancel", auth, cancelRide);

// 🌍 Dynamic route LAST
router.get("/:id", getRideById);

module.exports = router;
