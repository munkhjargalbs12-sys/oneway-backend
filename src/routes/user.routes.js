const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const userController = require("../controllers/user.controller");

// 🔐 Нэвтэрсэн хэрэглэгчийн мэдээлэл
router.get("/me", auth, userController.getMe);

// 🔐 Avatar солих
router.patch("/avatar", auth, userController.updateAvatar);

// 🌍 Хэрэглэгчийн рейтинг (public)
router.get("/:id/rating", userController.getUserRating);

module.exports = router;
