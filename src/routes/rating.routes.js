const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { createRating } = require("../controllers/rating.controller");

router.post("/", auth, createRating);

module.exports = router;
