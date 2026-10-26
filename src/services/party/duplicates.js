const pool = require('../../config/db');
const { httpError, cleanText } = require('../common');

const NAME_STOP_WORDS = new Set([
  'm', 's', 'ms', 'messrs', 'the', 'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company',
  'corp', 'corporation', 'inc', 'and', 'opc',
]);

/** "M/s. Shree Ganesh Traders Pvt. Ltd." → "shree ganesh traders" */
function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NAME_STOP_WORDS.has(w))
    .join(' ');
}

/** Latest profile version of every non-merged record in a company. */
function latestProfilesSql(cfg) {
  return `
    SELECT p.id, p.code, p.company_id, v.name, v.legal_name, v.gstin, v.pan, v.mobile, v.alt_mobile, v.email, v.status
    FROM ${cfg.table} p
    JOIN ${cfg.versionTable} v ON v.${cfg.fk} = p.id AND v.effective_to IS NULL
    WHERE p.merged_into_id IS NULL`;
}

async function gstinOwners(conn, cfg, companyId, gstin, excludeId) {
  if (!gstin) return [];
  const gst = cfg.children.gst_registrations.table;
  const [rows] = await conn.query(
    `SELECT p.id, p.code, 'PRIMARY' AS source FROM ${cfg.table} p
     JOIN ${cfg.versionTable} v ON v.${cfg.fk} = p.id AND v.effective_to IS NULL
     WHERE p.company_id = ? AND p.merged_into_id IS NULL AND p.id <> ? AND v.gstin = ?
     UNION
     SELECT p.id, p.code, 'ADDITIONAL' AS source FROM ${cfg.table} p
     JOIN ${gst} g ON g.${cfg.fk} = p.id AND g.effective_to IS NULL AND g.is_active = 1
     WHERE p.company_id = ? AND p.merged_into_id IS NULL AND p.id <> ? AND g.gstin = ?`,
    [companyId, excludeId || 0, gstin, companyId, excludeId || 0, gstin]
  );
  return rows;
}

async function assertGstinFree(conn, cfg, companyId, gstin, excludeId) {
  const owners = await gstinOwners(conn, cfg, companyId, gstin, excludeId);
  if (owners.length) {
    throw httpError(409, `GSTIN ${gstin} is already used by ${cfg.label.toLowerCase()} ${owners[0].code}`);
  }
}

/**
 * errors   → hard duplicates (GSTIN)
 * warnings → probable duplicates (PAN, mobile, email, similar name) — need acknowledge_duplicates
 */
async function findDuplicates(conn, cfg, companyId, data, excludeId = null) {
  const errors = [];
  const warnings = [];

  for (const owner of await gstinOwners(conn, cfg, companyId, data.gstin, excludeId)) {
    errors.push({ match_on: 'GSTIN', value: data.gstin, record: { id: owner.id, code: owner.code } });
  }

  const phones = [data.mobile, data.alt_mobile].filter(Boolean);
  const conds = [];
  const params = [companyId, excludeId || 0];
  if (data.pan) { conds.push('v.pan = ?'); params.push(data.pan); }
  if (phones.length) { conds.push('(v.mobile IN (?) OR v.alt_mobile IN (?))'); params.push(phones, phones); }
  if (data.email) { conds.push('v.email = ?'); params.push(data.email); }
  const nameKey = normalizeName(data.name);
  const firstWord = nameKey.split(' ')[0];
  if (firstWord) { conds.push('(LOWER(v.name) LIKE ? OR LOWER(v.legal_name) LIKE ?)'); params.push(`%${firstWord}%`, `%${firstWord}%`); }

  if (conds.length) {
    const [rows] = await conn.query(
      `${latestProfilesSql(cfg)} AND p.company_id = ? AND p.id <> ? AND (${conds.join(' OR ')}) LIMIT 200`,
      params
    );
    for (const r of rows) {
      const record = { id: r.id, code: r.code, name: r.name, status: r.status };
      if (data.pan && r.pan === data.pan) warnings.push({ match_on: 'PAN', value: data.pan, record });
      const shared = phones.find((m) => m === r.mobile || m === r.alt_mobile);
      if (shared) warnings.push({ match_on: 'MOBILE', value: shared, record });
      if (data.email && r.email === data.email) warnings.push({ match_on: 'EMAIL', value: data.email, record });
      if (nameKey && (normalizeName(r.name) === nameKey || normalizeName(r.legal_name) === nameKey)) {
        warnings.push({ match_on: 'NAME', value: data.name, record });
      }
    }
  }
  return { errors, warnings };
}

/** Company-wide scan — groups of records sharing GSTIN / PAN / mobile / email / normalised name. */
async function scanDuplicates(ctx, query = {}) {
  const { cfg } = ctx;
  const scope = ctx.companyFilter('p.company_id');
  const params = [...scope.params];
  let sql = `${latestProfilesSql(cfg)} AND ${scope.sql}`;
  if (cleanText(query.company_id)) {
    sql += ' AND p.company_id = ?';
    params.push(Number(query.company_id));
  }
  const [rows] = await pool.query(sql, params);

  const groups = new Map();
  const add = (matchOn, value, row) => {
    if (!value) return;
    const key = `${row.company_id}|${matchOn}|${value}`;
    if (!groups.has(key)) groups.set(key, { company_id: row.company_id, match_on: matchOn, value, records: [] });
    groups.get(key).records.push({ id: row.id, code: row.code, name: row.name, status: row.status });
  };
  for (const r of rows) {
    add('GSTIN', r.gstin, r);
    add('PAN', r.pan, r);
    add('MOBILE', r.mobile, r);
    add('EMAIL', r.email, r);
    add('NAME', normalizeName(r.name), r);
  }
  const severity = { GSTIN: 0, PAN: 1, MOBILE: 2, EMAIL: 3, NAME: 4 };
  return [...groups.values()]
    .filter((g) => new Set(g.records.map((r) => r.id)).size > 1)
    .sort((a, b) => severity[a.match_on] - severity[b.match_on]);
}

module.exports = { normalizeName, assertGstinFree, findDuplicates, scanDuplicates };
