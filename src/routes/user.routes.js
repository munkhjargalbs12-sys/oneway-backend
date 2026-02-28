const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const userController = require("../controllers/user.controller");

router.get("/me", auth, userController.getMe);
router.patch("/avatar", auth, userController.updateAvatar);
router.get("/:id/rating", userController.getUserRating);
router.get("/:id", userController.getPublicById);

module.exports = router;
