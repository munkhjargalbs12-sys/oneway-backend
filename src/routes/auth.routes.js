


const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");

const {
  register,
  login,
  setRole,
  requestPasswordReset,
  confirmPasswordReset,
} = require("../controllers/auth.controller");

router.post("/register", register);
router.post("/login", login);
router.post("/password/reset/request", requestPasswordReset);
router.post("/password/reset/confirm", confirmPasswordReset);
router.post("/role", auth, setRole);

module.exports = router;
