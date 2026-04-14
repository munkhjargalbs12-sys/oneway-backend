require("dotenv").config();

const bcrypt = require("bcrypt");
const pool = require("../db");

async function ensureAdminTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role VARCHAR(20) DEFAULT 'super_admin',
      is_active BOOLEAN DEFAULT TRUE,
      last_login_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function main() {
  const [emailArg, passwordArg, ...nameParts] = process.argv.slice(2);
  const email = String(emailArg || "").trim().toLowerCase();
  const password = String(passwordArg || "");
  const fullName = String(nameParts.join(" ").trim() || "OneWay Admin");

  if (!email || !password) {
    console.error(
      "Usage: npm run admin:create -- admin@oneway.mn StrongPassword \"OneWay Admin\""
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await ensureAdminTable();

  const hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO admin_users (email, password_hash, full_name, role, is_active)
     VALUES ($1, $2, $3, 'super_admin', TRUE)
     ON CONFLICT (email)
     DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       full_name = EXCLUDED.full_name,
       is_active = TRUE
     RETURNING id, email, full_name, role, is_active, created_at`,
    [email, hash, fullName]
  );

  const admin = result.rows[0];
  console.log("Admin user ready:");
  console.log(
    JSON.stringify(
      {
        id: Number(admin.id),
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
        is_active: Boolean(admin.is_active),
        created_at: admin.created_at,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error("Failed to create admin user:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
