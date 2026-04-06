const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
  getWallet,
  getWalletTransactions,
  topUpWallet,
  withdrawFromWallet,
} = require("../controllers/wallet.controller");

router.get("/", auth, getWallet);
router.get("/transactions", auth, getWalletTransactions);
router.post("/topup", auth, topUpWallet);
router.post("/withdraw", auth, withdrawFromWallet);

module.exports = router;
