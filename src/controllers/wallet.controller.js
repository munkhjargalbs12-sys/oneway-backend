const pool = require("../db");

function normalizeAmount(rawAmount) {
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount)) return null;
  if (!Number.isInteger(amount)) return null;
  return amount;
}

async function getWalletSummary(userId, client = pool) {
  const result = await client.query(
    `SELECT COALESCE(balance, 0) AS balance,
            COALESCE(locked_balance, 0) AS locked_balance
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );

  const row = result.rows[0] || {};
  const balance = Number(row.balance || 0);
  const lockedBalance = Number(row.locked_balance || 0);

  return {
    balance,
    locked_balance: lockedBalance,
    available_balance: Math.max(balance - lockedBalance, 0),
  };
}

exports.getWallet = async (req, res) => {
  try {
    const summary = await getWalletSummary(Number(req.user.id));
    res.json(summary);
  } catch (err) {
    console.error("getWallet error:", err);
    res.status(500).json({ error: "Failed to load wallet" });
  }
};

exports.getWalletTransactions = async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const result = await pool.query(
      `SELECT id, type, title, amount, created_at
       FROM wallet_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [userId]
    );

    res.json(
      result.rows.map((row) => ({
        id: String(row.id),
        type: row.type,
        title: row.title,
        amount: Number(row.amount || 0),
        created_at: row.created_at,
      }))
    );
  } catch (err) {
    console.error("getWalletTransactions error:", err);
    res.status(500).json({ error: "Failed to load wallet transactions" });
  }
};

exports.topUpWallet = async (req, res) => {
  const userId = Number(req.user.id);
  const amount = normalizeAmount(req.body?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE users
       SET balance = COALESCE(balance, 0) + $1
       WHERE id = $2`,
      [amount, userId]
    );

    const transactionRes = await client.query(
      `INSERT INTO wallet_transactions (user_id, type, title, amount)
       VALUES ($1, 'topup', 'Top up', $2)
       RETURNING id, type, title, amount, created_at`,
      [userId, amount]
    );

    const summary = await getWalletSummary(userId, client);

    await client.query("COMMIT");

    res.json({
      success: true,
      transaction: {
        id: String(transactionRes.rows[0].id),
        type: transactionRes.rows[0].type,
        title: transactionRes.rows[0].title,
        amount: Number(transactionRes.rows[0].amount || 0),
        created_at: transactionRes.rows[0].created_at,
      },
      wallet: summary,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("topUpWallet error:", err);
    res.status(500).json({ error: "Failed to top up wallet" });
  } finally {
    client.release();
  }
};

exports.withdrawFromWallet = async (req, res) => {
  const userId = Number(req.user.id);
  const amount = normalizeAmount(req.body?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const summaryBefore = await getWalletSummary(userId, client);
    if (amount > summaryBefore.available_balance) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient balance" });
    }

    await client.query(
      `UPDATE users
       SET balance = COALESCE(balance, 0) - $1
       WHERE id = $2`,
      [amount, userId]
    );

    const transactionRes = await client.query(
      `INSERT INTO wallet_transactions (user_id, type, title, amount)
       VALUES ($1, 'withdrawal', 'Withdrawal', $2)
       RETURNING id, type, title, amount, created_at`,
      [userId, -amount]
    );

    const summaryAfter = await getWalletSummary(userId, client);
    const fee = Math.floor(amount * 0.01);

    await client.query("COMMIT");

    res.json({
      success: true,
      fee,
      receive_amount: Math.max(amount - fee, 0),
      transaction: {
        id: String(transactionRes.rows[0].id),
        type: transactionRes.rows[0].type,
        title: transactionRes.rows[0].title,
        amount: Number(transactionRes.rows[0].amount || 0),
        created_at: transactionRes.rows[0].created_at,
      },
      wallet: summaryAfter,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("withdrawFromWallet error:", err);
    res.status(500).json({ error: "Failed to withdraw from wallet" });
  } finally {
    client.release();
  }
};
