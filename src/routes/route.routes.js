const express = require("express");
const router = express.Router();
const { computeRoute } = require("../controllers/route.controller");

router.post("/", computeRoute);

module.exports = router;
