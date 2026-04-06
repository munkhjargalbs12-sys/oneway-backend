const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
  bookSeat,
  getMyBookings,
  approveBooking,
  rejectBooking,
  markBookingAttendance,
} = require("../controllers/booking.controller");

router.get("/mine", auth, getMyBookings);
router.post("/", auth, bookSeat);
router.patch("/:id/approve", auth, approveBooking);
router.patch("/:id/reject", auth, rejectBooking);
router.patch("/:id/attendance", auth, markBookingAttendance);

module.exports = router;
