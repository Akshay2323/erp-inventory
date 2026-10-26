const mysql = require('mysql2/promise');
require('dotenv').config();

const sharedPool = mysql.createPool({
  host: process.env.SHARED_DB_HOST || process.env.DB_HOST || 'localhost',
  port: Number(process.env.SHARED_DB_PORT || process.env.DB_PORT) || 3306,
  user: process.env.SHARED_DB_USER || process.env.DB_USER || 'root',
  password: process.env.SHARED_DB_PASSWORD || process.env.DB_PASSWORD || 'sa.1',
  database: process.env.SHARED_DB_NAME || 'hrms_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
});

module.exports = sharedPool;
