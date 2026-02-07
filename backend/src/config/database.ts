import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

const logger = pino();

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,

  // ── Security hardening ──
  multipleStatements: false,             // Prevents stacked-query injection (e.g., "; DROP TABLE")
  flags: ['-FOUND_ROWS'],               // Don't leak extra metadata
  connectTimeout: 10000,                 // 10s connect timeout to prevent hanging
});

logger.info('MySQL pool created');

export default pool;