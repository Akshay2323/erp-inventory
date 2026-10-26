/**
 * Safe schema migrations — never drops tables or deletes data.
 * Tracks applied migrations in schema_migrations.
 */

async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(64) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function hasMigration(connection, id) {
  const [rows] = await connection.query(
    'SELECT id FROM schema_migrations WHERE id = ?',
    [id]
  );
  return rows.length > 0;
}

async function markMigration(connection, id) {
  await connection.query('INSERT INTO schema_migrations (id) VALUES (?)', [id]);
}

async function columnExists(connection, table, column) {
  const dbName = process.env.DB_NAME || 'inventory_db';
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return rows.length > 0;
}

async function indexExists(connection, table, indexName) {
  const dbName = process.env.DB_NAME || 'inventory_db';
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [dbName, table, indexName]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(connection, table, ddl) {
  const match = ddl.match(/ADD COLUMN\s+(\w+)/i);
  const column = match ? match[1] : null;
  if (column && (await columnExists(connection, table, column))) return false;
  await connection.query(`ALTER TABLE \`${table}\` ${ddl}`);
  return true;
}

async function dropIndexIfExists(connection, table, indexName) {
  if (!(await indexExists(connection, table, indexName))) return false;
  await connection.query(`ALTER TABLE \`${table}\` DROP INDEX \`${indexName}\``);
  return true;
}

async function addIndexIfMissing(connection, table, indexName, ddl) {
  if (await indexExists(connection, table, indexName)) return false;
  await connection.query(`ALTER TABLE \`${table}\` ${ddl}`);
  return true;
}

/**
 * Append future schema changes here, e.g.
 *   { id: '001_add_x', async up(connection) { await addColumnIfMissing(...) } }
 */
const MIGRATIONS = [
  {
    id: '010_product_bk_version_columns',
    async up(connection) {
      await addColumnIfMissing(connection, 'product_versions',
        "ADD COLUMN brand_id INT NULL AFTER brand");
      await addColumnIfMissing(connection, 'product_versions',
        "ADD COLUMN tracking_type VARCHAR(30) NOT NULL DEFAULT 'NONE' AFTER block_sales");
      await addColumnIfMissing(connection, 'product_versions',
        "ADD COLUMN valuation_method VARCHAR(30) NOT NULL DEFAULT 'WEIGHTED_AVERAGE' AFTER tracking_type");
      await addColumnIfMissing(connection, 'product_versions',
        "ADD COLUMN warranty_months INT NULL AFTER valuation_method");
      await addColumnIfMissing(connection, 'product_versions',
        "ADD COLUMN stock_uom_id INT NULL AFTER warranty_months");
      await addColumnIfMissing(connection, 'product_versions',
        "ADD COLUMN purchase_uom_id INT NULL AFTER stock_uom_id");
      await addColumnIfMissing(connection, 'product_versions',
        "ADD COLUMN sales_uom_id INT NULL AFTER purchase_uom_id");
    },
  },
];

async function runMigrations(connection) {
  await ensureMigrationsTable(connection);
  let applied = 0;
  for (const migration of MIGRATIONS) {
    if (await hasMigration(connection, migration.id)) continue;
    console.log(`Applying migration: ${migration.id}`);
    await migration.up(connection);
    await markMigration(connection, migration.id);
    applied += 1;
  }
  return applied;
}

module.exports = {
  runMigrations,
  columnExists,
  indexExists,
  addColumnIfMissing,
  addIndexIfMissing,
  dropIndexIfExists,
};
