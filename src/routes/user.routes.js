const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const userController = require("../controllers/user.controller");

router.get("/me", auth, userController.getMe);
router.patch("/avatar", auth, userController.updateAvatar);
router.post("/push-token", auth, userController.savePushToken);
router.delete("/push-token", auth, userController.clearPushToken);
router.post("/verify/email", auth, userController.setEmailVerification);
router.post("/verify/phone", auth, userController.setPhoneVerification);
router.post("/verify/payment", auth, userController.setPaymentLink);
router.post("/verify/driver-license", auth, userController.setDriverVerification);
router.get("/:id/rating", userController.getUserRating);
router.get("/:id", userController.getPublicById);

module.exports = router;
