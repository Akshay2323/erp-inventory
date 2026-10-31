/**
 * Wipe all master / transaction dummy data for fresh manual testing.
 * Keeps: platform ADMIN users (company_id IS NULL), schema_migrations,
 * and re-seeds system UOMs.
 *
 * Usage: node scripts/truncate_all_masters.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const { ALL_TABLES } = require('../src/config/ddl');
const { PRODUCT_TABLES } = require('../src/config/productDdl');
const { PARTY_TABLES } = require('../src/config/partyDdl');
const { ACCOUNTING_TABLES } = require('../src/config/accountingDdl');

(async () => {
  const dbName = process.env.DB_NAME;
  if (!dbName || dbName === process.env.SHARED_DB_NAME) {
    throw new Error(`Refusing to wipe: DB_NAME must be inventory DB only (got "${dbName}")`);
  }
  if (!/inventory/i.test(dbName)) {
    throw new Error(`Refusing to wipe non-inventory DB "${dbName}". Set DB_NAME=inventory_db`);
  }

  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbName,
    multipleStatements: true,
  });

  console.log(`DB=${dbName} (inventory only — HRMS/shared untouched)`);

  // Prefer declared module lists; fall back to ALL_TABLES minus keepers
  const keep = new Set(['users', 'schema_migrations']);
  const ordered = [
    ...ACCOUNTING_TABLES,
    ...PRODUCT_TABLES,
    ...PARTY_TABLES,
    'branch_versions',
    'branches',
    'company_versions',
    'companies',
  ];
  // Dedupe while preserving order
  const seen = new Set();
  const tables = [];
  for (const t of [...ordered, ...ALL_TABLES]) {
    if (keep.has(t) || seen.has(t)) continue;
    seen.add(t);
    tables.push(t);
  }

  // Discover any leftover *_audit / company_* tables that exist
  const [existing] = await c.query('SHOW TABLES');
  const existingNames = new Set(existing.map((r) => Object.values(r)[0]));
  for (const name of existingNames) {
    if (keep.has(name) || seen.has(name)) continue;
    if (/^(client_|vendor_|sales_|purchase_|company_|branch_|product_|inventory_|bom_|production_|warehouse_|ledger_|voucher_|financial_)/i.test(name)
      || name === 'bills_of_materials') {
      tables.push(name);
      seen.add(name);
    }
  }

  const toWipe = tables.filter((t) => existingNames.has(t));
  console.log(`Truncating ${toWipe.length} tables…`);

  await c.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of toWipe) {
    try {
      const [[{ c: before }]] = await c.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
      await c.query(`TRUNCATE TABLE \`${t}\``);
      if (before > 0) console.log(`  ${t}: ${before} → 0`);
    } catch (e) {
      console.warn(`  skip ${t}: ${e.message}`);
    }
  }

  // Remove company-scoped users; keep platform ADMIN (company_id NULL)
  const [delUsers] = await c.query(
    `DELETE FROM users WHERE company_id IS NOT NULL OR role = 'COMPANY_ADMIN'`
  );
  console.log(`  users (company-scoped removed): ${delUsers.affectedRows}`);

  // Ensure at least one ADMIN remains
  const [[{ admins }]] = await c.query(
    `SELECT COUNT(*) AS admins FROM users WHERE role = 'ADMIN' AND company_id IS NULL`
  );
  if (!admins) {
    console.warn('WARNING: no platform ADMIN left — create via seed / register');
  } else {
    console.log(`  platform ADMIN users kept: ${admins}`);
  }

  await c.query('SET FOREIGN_KEY_CHECKS = 1');

  // Re-seed system UOMs
  const { seedSystemUoms } = require('../src/services/product/uomService');
  const uoms = await seedSystemUoms();
  console.log(`System UOMs re-seeded: ${Array.isArray(uoms) ? uoms.length : uoms?.created ?? 'ok'}`);

  // Summary counts
  for (const t of ['companies', 'branches', 'clients', 'vendors', 'products', 'sales_vouchers', 'purchase_vouchers', 'users', 'units_of_measure']) {
    if (!existingNames.has(t)) continue;
    const [[{ c: n }]] = await c.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    console.log(`  check ${t}=${n}`);
  }

  await c.end();
  console.log('Done — DB clean for manual testing.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
