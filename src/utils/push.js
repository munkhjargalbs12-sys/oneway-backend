const pool = require("../db");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

async function fetchWithFallback(...args) {
  if (typeof fetch === "function") {
    return fetch(...args);
  }

  const { default: nodeFetch } = await import("node-fetch");
  return nodeFetch(...args);
}

function isExpoPushToken(token) {
  const value = String(token || "").trim();
  return /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(value);
}

async function getUserPushToken(userId) {
  if (!Number.isFinite(Number(userId)) || Number(userId) <= 0) {
    return null;
  }

  const result = await pool.query(
    `SELECT expo_push_token
       FROM users
      WHERE id = $1`,
    [Number(userId)]
  );

  const token = result.rows[0]?.expo_push_token;
  return isExpoPushToken(token) ? String(token).trim() : null;
}

async function sendExpoPushNotification(message) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const accessToken = String(process.env.EXPO_PUSH_ACCESS_TOKEN || "").trim();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetchWithFallback(EXPO_PUSH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.errors?.[0]?.message ||
        payload?.message ||
        `Expo push request failed (${response.status})`
    );
  }

  return payload;
}

async function sendPushToUser(userId, { title, body, data = {}, sound = "default" } = {}) {
  const token = await getUserPushToken(userId);
  if (!token || !title || !body) {
    return null;
  }

  return sendExpoPushNotification({
    to: token,
    title,
    body,
    sound,
    priority: "high",
    channelId: "default",
    data,
  });
}

module.exports = {
  isExpoPushToken,
  sendPushToUser,
};
