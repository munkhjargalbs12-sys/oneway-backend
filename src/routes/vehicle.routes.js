const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { createVehicle, getMyVehicle } = require("../controllers/vehicle.controller");

router.post("/", auth, createVehicle);
router.get("/me", auth, getMyVehicle);

module.exports = router;
