const mysql = require('mysql2/promise');
require('dotenv').config();
const { encryptPassword, migratePasswordsToAes } = require('../services/passwordService');
const { CREATE_TABLES_SQL } = require('./ddl');
const { runMigrations } = require('./migrate');
const { PREDEFINED_UOMS } = require('./productConfig');

/**
 * Safe database setup — never drops tables or deletes live data.
 * - Creates database if missing
 * - Creates missing tables only (CREATE IF NOT EXISTS)
 * - Applies incremental migrations (ALTER only)
 * - Seeds default platform admin only when users table is empty
 * - Encrypts any plaintext passwords with AES
 */
async function seedDefaults(connection) {
  const [users] = await connection.query('SELECT COUNT(*) AS cnt FROM users');
  if (Number(users[0].cnt) === 0) {
    await connection.query(
      `INSERT INTO users (username, email, full_name, password_encrypted, role)
       VALUES (?, ?, ?, ?, ?)`,
      ['admin', 'admin@inventory-app.local', 'System Admin', encryptPassword('admin123'), 'ADMIN']
    );
    console.log('Default login created: username=admin  password=admin123');
  }
  const upgraded = await migratePasswordsToAes(connection);
  if (upgraded > 0) console.log(`Encrypted ${upgraded} plaintext password(s) with AES.`);

  // Section B — system UOMs (company_id NULL)
  for (const u of PREDEFINED_UOMS) {
    const [existing] = await connection.query(
      'SELECT id FROM units_of_measure WHERE company_id IS NULL AND code = ? LIMIT 1',
      [u.code]
    );
    if (existing.length) continue;
    await connection.query(
      `INSERT INTO units_of_measure (company_id, code, name, category, decimal_precision, is_system, status, created_by)
       VALUES (NULL, ?, ?, ?, ?, 1, 'ACTIVE', 'system')`,
      [u.code, u.name, u.category, u.decimal_precision]
    );
  }
}

async function initDb() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'sa.1',
    multipleStatements: true,
  });

  const dbName = process.env.DB_NAME || 'inventory_db';
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await connection.query(`USE \`${dbName}\``);

  await connection.query(CREATE_TABLES_SQL);
  const migrated = await runMigrations(connection);
  await seedDefaults(connection);

  console.log(`Database "${dbName}" ready (live data preserved).`);
  if (migrated > 0) console.log(`Applied ${migrated} migration(s).`);
  console.log('To wipe all data intentionally: npm run reset-db -- --confirm');

  await connection.end();
}

if (require.main === module) {
  initDb().catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
}

module.exports = { seedDefaults };
