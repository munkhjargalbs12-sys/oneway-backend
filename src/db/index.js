const { Pool } = require("pg");

const dbPort = Number(process.env.DB_PORT) || 5432;

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: dbPort,
});

module.exports = pool;
