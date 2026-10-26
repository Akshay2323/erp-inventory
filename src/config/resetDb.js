/**
 * DESTRUCTIVE reset — drops all inventory tables and recreates empty schema.
 * Only runs with explicit --confirm flag.
 *
 *   npm run reset-db -- --confirm
 */
const mysql = require('mysql2/promise');
require('dotenv').config();
const { CREATE_TABLES_SQL, ALL_TABLES } = require('./ddl');
const { runMigrations } = require('./migrate');
const { seedDefaults } = require('./initDb');

async function resetDb() {
  if (!process.argv.includes('--confirm')) {
    console.error('Refusing to reset: pass --confirm to drop all tables.');
    console.error('  npm run reset-db -- --confirm');
    process.exit(1);
  }

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

  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of ALL_TABLES) {
    await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
  await connection.query('SET FOREIGN_KEY_CHECKS = 1');

  await connection.query(CREATE_TABLES_SQL);
  await runMigrations(connection);
  await seedDefaults(connection);

  console.log(`Database "${dbName}" reset (all data removed).`);
  await connection.end();
}

resetDb().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
