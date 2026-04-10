const DEFAULT_RESEND_API_URL = "https://api.resend.com/emails";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendEmailWithResend({ to, subject, html, text }) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM_EMAIL || "").trim();
  const apiUrl = String(process.env.RESEND_API_URL || DEFAULT_RESEND_API_URL).trim();

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  if (!from) {
    throw new Error("RESEND_FROM_EMAIL is not configured");
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      text,
    }),
  });

  const raw = await response.text().catch(() => "");
  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw };
    }
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      `Resend request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function sendVerificationCodeEmail({ to, code, expiresInMinutes }) {
  const safeCode = escapeHtml(code);
  const subject = "OneWay email verification code";
  const text = [
    "OneWay email verification",
    "",
    `Your verification code is: ${code}`,
    `This code expires in ${expiresInMinutes} minutes.`,
  ].join("\n");
  const html = [
    "<div style=\"font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;\">",
    "<h2 style=\"margin-bottom: 12px;\">OneWay email verification</h2>",
    "<p style=\"margin: 0 0 12px;\">Use this code to verify your email address.</p>",
    `<div style="display: inline-block; padding: 12px 18px; border-radius: 12px; background: #eff6ff; border: 1px solid #bfdbfe; font-size: 28px; font-weight: 700; letter-spacing: 6px;">${safeCode}</div>`,
    `<p style="margin: 12px 0 0;">This code expires in ${Number(expiresInMinutes)} minutes.</p>`,
    "</div>",
  ].join("");

  return sendEmailWithResend({ to, subject, html, text });
}

module.exports = {
  sendEmailWithResend,
  sendVerificationCodeEmail,
};
