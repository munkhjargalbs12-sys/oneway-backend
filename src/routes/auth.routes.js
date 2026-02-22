


const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");

const {
  register,
  login,
  setRole,
} = require("../controllers/auth.controller");

router.post("/register", register);
router.post("/login", login);
router.post("/role", auth, setRole);

module.exports = router;