const express = require("express");

const {
  autocompletePlaces,
  getPlaceDetails,
} = require("../controllers/place.controller");

const router = express.Router();

router.post("/autocomplete", autocompletePlaces);
router.get("/:placeId", getPlaceDetails);

module.exports = router;
