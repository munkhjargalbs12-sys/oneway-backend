const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
  getMyNotifications,
  markAsRead,
  createNotificationEntry,
} = require("../controllers/notification.controller");

router.get("/", auth, getMyNotifications);
router.post("/", auth, createNotificationEntry);
router.patch("/:id/read", auth, markAsRead);

module.exports = router;
