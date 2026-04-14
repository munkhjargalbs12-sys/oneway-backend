const express = require("express");
const router = express.Router();

const adminAuth = require("../middleware/adminAuth");
const adminAuthController = require("../controllers/adminAuth.controller");
const adminController = require("../controllers/admin.controller");

router.post("/auth/login", adminAuthController.login);

router.use(adminAuth);

router.get("/auth/me", adminAuthController.getMe);
router.get("/overview", adminController.getOverview);
router.get("/users", adminController.listUsers);
router.get("/rides", adminController.listRides);
router.get("/bookings", adminController.listBookings);

module.exports = router;
