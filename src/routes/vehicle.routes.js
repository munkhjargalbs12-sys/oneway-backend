const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
  createVehicle,
  getMyVehicle,
  updateMyVehicle,
  verifyMyVehicle,
} = require("../controllers/vehicle.controller");

router.post("/", auth, createVehicle);
router.get("/me", auth, getMyVehicle);
router.patch("/me", auth, updateMyVehicle);
router.post("/verify", auth, verifyMyVehicle);

module.exports = router;
