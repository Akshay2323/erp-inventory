/**
 * Child records of a client / vendor (addresses, GST registrations, bank accounts, UPI IDs,
 * contacts, documents). Every row is a version of a record identified by root_id:
 *   effective_from / effective_to — same rules as services/versioning.js
 *   is_active — deactivation is itself a dated version (nothing is deleted)
 *   is_default — kept in sync on all versions of a record (immediate, not dated)
 */
const { httpError, today, addDays } = require('../common');
const { loadVersions, resolveVersion, assertEffectiveDate, cancelLatestScheduled } = require('../versioning');
const { stateCodeForName, validateGstConsistency, stateNameForCode } = require('../taxValidation');
const {
  readFields, assertRequired, changedKeys, pick, dbRow, outFields, auditText,
} = require('./fields');
const { writeAudit, writeChildHistory } = require('./audit');
const { assertGstinFree } = require('./duplicates');

const FILE_COLS = ['file_path', 'original_name', 'mime_type', 'file_size'];
const VERIFY_COLS = ['verification_status', 'verified_by', 'verified_at', 'verification_remarks'];
const VERIFY_STATUSES = ['UNVERIFIED', 'VERIFIED', 'REJECTED'];

const CHILD_SLUGS = {
  addresses: 'addresses',
  'gst-registrations': 'gst_registrations',
  'bank-accounts': 'bank_accounts',
  'upi-ids': 'upi_ids',
  contacts: 'contacts',
  documents: 'documents',
};

function childConfig(cfg, key) {
  const child = cfg.children[key];
  if (!child) throw httpError(404, `Unknown section ${key}`);
  return child;
}

function carryCols(child) {
  return [...(child.file ? FILE_COLS : []), ...(child.verification ? VERIFY_COLS : []), 'is_default', 'is_active'];
}

function approvalFor(meta, sensitive) {
  if (meta.approval) return meta.approval;
  if (sensitive) return { status: 'AUTO_APPROVED', approved_by: meta.actor, approved_at: new Date() };
  return null;
}

// ---------- normalisation ----------

/** Type-specific rules on a complete (merged) record. */
function normalizeChild(cfg, key, data, labelPrefix = '') {
  const child = childConfig(cfg, key);
  assertRequired(child.fields, data, labelPrefix);

  if (key === 'addresses') {
    const derived = stateCodeForName(data.state);
    if (!data.state_code) data.state_code = derived;
    else if (derived && data.state_code !== derived && stateNameForCode(data.state_code) !== data.state) {
      throw httpError(400, `${labelPrefix}state_code ${data.state_code} does not match state ${data.state}`);
    }
  }
  if (key === 'gst_registrations') {
    validateGstConsistency(data, { label: labelPrefix.replace(/\.$/, '') });
    if (!data.place_of_supply) data.place_of_supply = data.state_code;
  }
  if (key === 'contacts' && !data.mobile && !data.email) {
    throw httpError(400, `${labelPrefix}mobile or email is required for a contact`);
  }
  if (key === 'documents' && data.issue_date && data.expiry_date && data.expiry_date < data.issue_date) {
    throw httpError(400, `${labelPrefix}expiry_date must be on or after issue_date`);
  }
  return data;
}

async function assertChildUnique(conn, cfg, key, party, data, rootId = 0) {
  const child = childConfig(cfg, key);
  if (child.unique) {
    const cond = child.unique.map((f) => `${f} = ?`).join(' AND ');
    const [rows] = await conn.query(
      `SELECT root_id FROM ${child.table}
       WHERE ${cfg.fk} = ? AND ${cond} AND effective_to IS NULL AND is_active = 1 AND root_id <> ?`,
      [party.id, ...child.unique.map((f) => data[f]), rootId || 0]
    );
    if (rows.length) {
      throw httpError(409, `${child.label} ${child.unique.map((f) => data[f]).join(' / ')} already exists for this ${cfg.label.toLowerCase()}`);
    }
  }
  if (key === 'gst_registrations') {
    const [[profile]] = await conn.query(
      `SELECT gstin FROM ${cfg.versionTable} WHERE ${cfg.fk} = ? ORDER BY effective_from DESC LIMIT 1`,
      [party.id]
    );
    if (profile?.gstin === data.gstin) {
      throw httpError(409, `${data.gstin} is already the primary GSTIN of this ${cfg.label.toLowerCase()}`);
    }
    await assertGstinFree(conn, cfg, party.company_id, data.gstin, party.id);
  }
}

// ---------- read ----------

async function loadChildVersions(conn, cfg, key, partyIds) {
  const child = childConfig(cfg, key);
  const map = new Map();
  if (!partyIds.length) return map;
  const [rows] = await conn.query(
    `SELECT * FROM ${child.table} WHERE ${cfg.fk} IN (?) ORDER BY root_id, effective_from`,
    [partyIds]
  );
  for (const row of rows) {
    if (!map.has(row.root_id)) map.set(row.root_id, []);
    map.get(row.root_id).push(row);
  }
  return map;
}

async function loadRoot(conn, cfg, key, partyId, rootId) {
  const child = childConfig(cfg, key);
  const versions = (await loadVersions(conn, child.table, 'root_id', [Number(rootId)])).get(Number(rootId)) || [];
  if (!versions.length || versions[0][cfg.fk] !== Number(partyId)) {
    throw httpError(404, `${child.label} not found`);
  }
  return versions;
}

function maskValue(value) {
  if (!value) return value;
  const s = String(value);
  return s.length <= 4 ? s : `${'X'.repeat(s.length - 4)}${s.slice(-4)}`;
}

function formatChild(cfg, key, v, { mask = false, partyId } = {}) {
  const child = childConfig(cfg, key);
  const out = { id: v.root_id, version_id: v.id, ...outFields(child.fields, v) };
  if (mask && child.masked) out[child.masked] = maskValue(out[child.masked]);
  if (child.file) {
    out.file = v.file_path
      ? {
        name: v.original_name,
        mime_type: v.mime_type,
        size: v.file_size,
        url: `/api/${cfg.key}/${partyId ?? v[cfg.fk]}/documents/${v.root_id}/file?version_id=${v.id}`,
      }
      : null;
  }
  if (child.verification) {
    out.verification_status = v.verification_status;
    out.verified_by = v.verified_by;
    out.verified_at = v.verified_at;
    out.verification_remarks = v.verification_remarks;
  }
  Object.assign(out, {
    is_default: !!v.is_default,
    is_active: !!v.is_active,
    effective_from: v.effective_from,
    effective_to: v.effective_to,
    remarks: v.remarks,
    created_by: v.created_by,
    created_at: v.created_at,
  });
  return out;
}

/** Records as of a date. Records not yet effective appear only with includeUpcoming. */
function resolveChildren(cfg, key, versionsByRoot, asOf, { includeInactive = false, includeUpcoming = true, mask = false } = {}) {
  const list = [];
  for (const versions of versionsByRoot.values()) {
    const { current, upcoming } = resolveVersion(versions, asOf);
    const shown = current || (includeUpcoming ? upcoming : null);
    if (!shown) continue;
    if (!shown.is_active && !includeInactive) continue;
    list.push({
      ...formatChild(cfg, key, shown, { mask }),
      effective_status: current ? 'EFFECTIVE' : 'NOT_YET_EFFECTIVE',
      upcoming_change: current && upcoming
        ? { version_id: upcoming.id, effective_from: upcoming.effective_from, is_active: !!upcoming.is_active, remarks: upcoming.remarks }
        : null,
    });
  }
  return list.sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.id - b.id);
}

// ---------- write helpers ----------

async function insertVersionRow(conn, cfg, child, { partyId, rootId, values, effectiveDate, reason, actor, approvalId }) {
  const cols = Object.keys(values);
  const [result] = await conn.query(
    `INSERT INTO ${child.table} (root_id, ${cfg.fk}, ${cols.join(', ')}, effective_from, remarks, created_by, approval_id)
     VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
    [rootId || null, partyId, ...Object.values(values), effectiveDate, reason || null, actor, approvalId || null]
  );
  if (!rootId) await conn.query(`UPDATE ${child.table} SET root_id = id WHERE id = ?`, [result.insertId]);
  return { versionId: result.insertId, rootId: rootId || result.insertId };
}

/** Same-date correction or new dated version (closing the latest). */
async function writeVersion(conn, cfg, child, { partyId, latest, values, effectiveDate, reason, actor, approvalId }) {
  assertEffectiveDate(latest, effectiveDate);
  if (effectiveDate === latest.effective_from) {
    const cols = Object.keys(values);
    await conn.query(
      `UPDATE ${child.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, remarks = ?, created_by = ?, approval_id = ?
       WHERE id = ?`,
      [...Object.values(values), reason ?? latest.remarks, actor, approvalId || latest.approval_id, latest.id]
    );
    return { mode: 'CORRECTED', versionId: latest.id };
  }
  await conn.query(`UPDATE ${child.table} SET effective_to = ? WHERE id = ?`, [addDays(effectiveDate, -1), latest.id]);
  const { versionId } = await insertVersionRow(conn, cfg, child, {
    partyId, rootId: latest.root_id, values, effectiveDate, reason, actor, approvalId,
  });
  return { mode: 'NEW_VERSION', versionId };
}

/** Clears is_default on other records in the same default group; returns their root ids. */
async function clearOtherDefaults(conn, cfg, child, partyId, rootId, groupValue) {
  if (!child.defaultGroup) return [];
  let sql = `SELECT DISTINCT root_id FROM ${child.table} WHERE ${cfg.fk} = ? AND is_default = 1 AND root_id <> ?`;
  const params = [partyId, rootId || 0];
  if (child.defaultGroup !== 'ALL') {
    sql += ` AND root_id IN (SELECT root_id FROM ${child.table}
                              WHERE ${cfg.fk} = ? AND effective_to IS NULL AND ${child.defaultGroup} = ?)`;
    params.push(partyId, groupValue);
  }
  const [rows] = await conn.query(sql, params);
  const roots = rows.map((r) => r.root_id);
  if (roots.length) {
    await conn.query(`UPDATE ${child.table} SET is_default = 0 WHERE ${cfg.fk} = ? AND root_id IN (?)`, [partyId, roots]);
  }
  return roots;
}

async function hasActiveDefault(conn, cfg, child, partyId, groupValue) {
  let sql = `SELECT 1 FROM ${child.table} WHERE ${cfg.fk} = ? AND is_default = 1 AND is_active = 1 AND effective_to IS NULL`;
  const params = [partyId];
  if (child.defaultGroup !== 'ALL') {
    sql += ` AND ${child.defaultGroup} = ?`;
    params.push(groupValue);
  }
  const [rows] = await conn.query(`${sql} LIMIT 1`, params);
  return rows.length > 0;
}

function snapshot(child, row) {
  if (!row) return null;
  const snap = pick(child.fields, row);
  for (const c of carryCols(child)) snap[c] = row[c] ?? null;
  return snap;
}

async function logChange(conn, cfg, child, party, meta, { rootId, action, changeType, effectiveDate, changes, oldRow, newRow, sensitive }) {
  const approval = approvalFor(meta, sensitive);
  await writeChildHistory(conn, child, cfg, {
    partyId: party.id,
    rootId,
    changeType,
    oldValues: snapshot(child, oldRow),
    newValues: snapshot(child, newRow),
    effectiveDate,
    reason: meta.reason,
    actor: meta.actor,
    approval,
  });
  await writeAudit(conn, cfg, {
    companyId: party.company_id,
    partyId: party.id,
    entityType: child.entityType,
    entityId: rootId,
    action,
    effectiveDate,
    reason: meta.reason,
    actor: meta.actor,
    role: meta.role,
    approval,
  }, changes);
}

// ---------- operations (run inside a transaction) ----------

/** payload: { child, data, effective_date } — data already validated by readChildInput */
async function execChildCreate(conn, cfg, party, payload, meta) {
  const key = payload.child;
  const child = childConfig(cfg, key);
  const data = normalizeChild(cfg, key, readFields(child.fields, payload.data), '');
  await assertChildUnique(conn, cfg, key, party, data);
  const effectiveDate = payload.effective_date || today();

  const groupValue = child.defaultGroup && child.defaultGroup !== 'ALL' ? data[child.defaultGroup] : null;
  let isDefault = 0;
  if (child.defaultGroup) {
    isDefault = payload.data.is_default === true || ['true', '1', 1].includes(payload.data.is_default)
      || !(await hasActiveDefault(conn, cfg, child, party.id, groupValue)) ? 1 : 0;
  }
  const values = { ...dbRow(child.fields, data), is_default: isDefault, is_active: 1 };
  if (child.file) Object.assign(values, payload.file || {});
  if (child.verification) values.verification_status = 'UNVERIFIED';

  const approvalId = meta.approval?.id;
  const { rootId } = await insertVersionRow(conn, cfg, child, {
    partyId: party.id, rootId: null, values, effectiveDate, reason: meta.reason, actor: meta.actor, approvalId,
  });
  const cleared = isDefault ? await clearOtherDefaults(conn, cfg, child, party.id, rootId, groupValue) : [];

  const changes = Object.keys(child.fields)
    .filter((f) => data[f] !== null && data[f] !== undefined)
    .map((f) => ({ field: f, old: null, new: auditText(child.fields[f], data[f]) }));
  if (child.file && payload.file) changes.push({ field: 'file', old: null, new: payload.file.original_name });
  if (isDefault) changes.push({ field: 'is_default', old: null, new: 'true' });
  await logChange(conn, cfg, child, party, meta, {
    rootId, action: 'ADDED', changeType: 'ADDED', effectiveDate, changes, oldRow: null, newRow: values,
    sensitive: !!child.sensitive,
  });
  for (const other of cleared) {
    await logChange(conn, cfg, child, party, meta, {
      rootId: other, action: 'DEFAULT_CHANGED', changeType: 'DEFAULT_CHANGED', effectiveDate,
      changes: [{ field: 'is_default', old: 'true', new: 'false' }], sensitive: !!child.sensitive,
    });
  }
  return {
    sensitive: !!child.sensitive,
    entityType: child.entityType,
    entityId: rootId,
    effectiveDate,
    summary: `Add ${child.label.toLowerCase()} from ${effectiveDate}`,
  };
}

/** payload: { child, root_id, changes, effective_date, file? } */
async function execChildUpdate(conn, cfg, party, payload, meta) {
  const key = payload.child;
  const child = childConfig(cfg, key);
  const versions = await loadRoot(conn, cfg, key, party.id, payload.root_id);
  const latest = versions[versions.length - 1];
  const changes = readFields(child.fields, payload.changes, { partial: true });
  const changed = changedKeys(child.fields, changes, latest);
  const fileChanged = !!(child.file && payload.file);
  if (!changed.length && !fileChanged) return { noChange: true };

  const effectiveDate = payload.effective_date || today();
  assertEffectiveDate(latest, effectiveDate);
  const merged = normalizeChild(cfg, key, { ...pick(child.fields, latest), ...changes });
  await assertChildUnique(conn, cfg, key, party, merged, latest.root_id);

  const values = { ...dbRow(child.fields, merged) };
  for (const c of carryCols(child)) values[c] = latest[c];
  if (fileChanged) Object.assign(values, payload.file);
  if (child.verification) Object.assign(values, {
    verification_status: 'UNVERIFIED', verified_by: null, verified_at: null, verification_remarks: null,
  });

  const { mode } = await writeVersion(conn, cfg, child, {
    partyId: party.id, latest, values, effectiveDate, reason: meta.reason, actor: meta.actor, approvalId: meta.approval?.id,
  });

  let cleared = [];
  const groupField = child.defaultGroup && child.defaultGroup !== 'ALL' ? child.defaultGroup : null;
  if (groupField && latest.is_default && changed.includes(groupField)) {
    cleared = await clearOtherDefaults(conn, cfg, child, party.id, latest.root_id, merged[groupField]);
  }

  const auditChanges = changed.map((f) => ({
    field: f, old: auditText(child.fields[f], latest[f]), new: auditText(child.fields[f], merged[f]),
  }));
  if (fileChanged) auditChanges.push({ field: 'file', old: latest.original_name, new: payload.file.original_name });
  if (child.verification && latest.verification_status !== 'UNVERIFIED') {
    auditChanges.push({ field: 'verification_status', old: latest.verification_status, new: 'UNVERIFIED' });
  }
  await logChange(conn, cfg, child, party, meta, {
    rootId: latest.root_id,
    action: fileChanged && child.file ? 'REPLACED' : mode === 'CORRECTED' ? 'CORRECTED' : 'MODIFIED',
    changeType: mode === 'CORRECTED' ? 'CORRECTED' : 'MODIFIED',
    effectiveDate, changes: auditChanges, oldRow: latest, newRow: values, sensitive: !!child.sensitive,
  });
  for (const other of cleared) {
    await logChange(conn, cfg, child, party, meta, {
      rootId: other, action: 'DEFAULT_CHANGED', changeType: 'DEFAULT_CHANGED', effectiveDate,
      changes: [{ field: 'is_default', old: 'true', new: 'false' }], sensitive: !!child.sensitive,
    });
  }
  return {
    sensitive: !!child.sensitive,
    entityType: child.entityType,
    entityId: latest.root_id,
    effectiveDate,
    summary: `Change ${child.label.toLowerCase()} #${latest.root_id} (${[...changed, ...(fileChanged ? ['file'] : [])].join(', ')}) from ${effectiveDate}`,
  };
}

/** payload: { child, root_id, is_active, effective_date } */
async function execChildSetActive(conn, cfg, party, payload, meta) {
  const key = payload.child;
  const child = childConfig(cfg, key);
  const versions = await loadRoot(conn, cfg, key, party.id, payload.root_id);
  const latest = versions[versions.length - 1];
  const active = payload.is_active ? 1 : 0;
  if (Number(latest.is_active) === active) {
    throw httpError(400, `${child.label} is already ${active ? 'active' : 'inactive'}`);
  }
  const effectiveDate = payload.effective_date || today();
  if (active) {
    const merged = pick(child.fields, latest);
    await assertChildUnique(conn, cfg, key, party, merged, latest.root_id);
  }

  const values = { ...dbRow(child.fields, pick(child.fields, latest)) };
  for (const c of carryCols(child)) values[c] = latest[c];
  values.is_active = active;
  const wasDefault = !!latest.is_default;
  if (!active) values.is_default = 0;

  await writeVersion(conn, cfg, child, {
    partyId: party.id, latest, values, effectiveDate, reason: meta.reason, actor: meta.actor, approvalId: meta.approval?.id,
  });
  if (!active && wasDefault) {
    await conn.query(`UPDATE ${child.table} SET is_default = 0 WHERE root_id = ?`, [latest.root_id]);
  }

  const changes = [{ field: 'is_active', old: active ? 'false' : 'true', new: active ? 'true' : 'false' }];
  if (!active && wasDefault) changes.push({ field: 'is_default', old: 'true', new: 'false' });
  await logChange(conn, cfg, child, party, meta, {
    rootId: latest.root_id,
    action: active ? 'REACTIVATED' : 'DEACTIVATED',
    changeType: active ? 'REACTIVATED' : 'DEACTIVATED',
    effectiveDate, changes, oldRow: latest, newRow: values, sensitive: !!child.sensitive,
  });
  return {
    sensitive: !!child.sensitive,
    entityType: child.entityType,
    entityId: latest.root_id,
    effectiveDate,
    summary: `${active ? 'Reactivate' : 'Deactivate'} ${child.label.toLowerCase()} #${latest.root_id} from ${effectiveDate}`,
  };
}

/** payload: { child, root_id } — default selection is immediate */
async function execChildSetDefault(conn, cfg, party, payload, meta) {
  const key = payload.child;
  const child = childConfig(cfg, key);
  if (!child.defaultGroup) throw httpError(400, `${child.label} has no default selection`);
  const versions = await loadRoot(conn, cfg, key, party.id, payload.root_id);
  const latest = versions[versions.length - 1];
  if (!latest.is_active) throw httpError(400, `Inactive ${child.label.toLowerCase()} cannot be the default`);
  if (latest.is_default) return { noChange: true };

  const groupValue = child.defaultGroup === 'ALL' ? null : latest[child.defaultGroup];
  const cleared = await clearOtherDefaults(conn, cfg, child, party.id, latest.root_id, groupValue);
  await conn.query(`UPDATE ${child.table} SET is_default = 1 WHERE root_id = ?`, [latest.root_id]);

  const effectiveDate = today();
  await logChange(conn, cfg, child, party, meta, {
    rootId: latest.root_id, action: 'DEFAULT_CHANGED', changeType: 'DEFAULT_CHANGED', effectiveDate,
    changes: [{ field: 'is_default', old: 'false', new: 'true' }],
    oldRow: latest, newRow: { ...latest, is_default: 1 }, sensitive: !!child.sensitive,
  });
  for (const other of cleared) {
    await logChange(conn, cfg, child, party, meta, {
      rootId: other, action: 'DEFAULT_CHANGED', changeType: 'DEFAULT_CHANGED', effectiveDate,
      changes: [{ field: 'is_default', old: 'true', new: 'false' }], sensitive: !!child.sensitive,
    });
  }
  return {
    sensitive: !!child.sensitive,
    entityType: child.entityType,
    entityId: latest.root_id,
    effectiveDate,
    summary: `Set ${child.label.toLowerCase()} #${latest.root_id} as ${child.defaultLabel.toLowerCase()}`,
  };
}

/** Verification (bank / UPI / document) — approvers only, applies to the latest version. */
async function execChildVerify(conn, cfg, party, payload, meta) {
  const key = payload.child;
  const child = childConfig(cfg, key);
  if (!child.verification) throw httpError(400, `${child.label} cannot be verified`);
  const status = String(payload.status || '').toUpperCase();
  if (!VERIFY_STATUSES.includes(status)) throw httpError(400, `status must be one of ${VERIFY_STATUSES.join(', ')}`);
  const versions = await loadRoot(conn, cfg, key, party.id, payload.root_id);
  const latest = versions[versions.length - 1];
  if (latest.verification_status === status) throw httpError(400, `${child.label} is already ${status}`);

  await conn.query(
    `UPDATE ${child.table} SET verification_status = ?, verified_by = ?, verified_at = NOW(), verification_remarks = ?
     WHERE id = ?`,
    [status, meta.actor, meta.reason || null, latest.id]
  );
  await logChange(conn, cfg, child, party, meta, {
    rootId: latest.root_id, action: 'VERIFICATION', changeType: 'VERIFIED', effectiveDate: today(),
    changes: [{ field: 'verification_status', old: latest.verification_status, new: status }],
    oldRow: latest, newRow: { ...latest, verification_status: status, verified_by: meta.actor },
    sensitive: false,
  });
  return { entityType: child.entityType, entityId: latest.root_id };
}

async function execChildCancelScheduled(conn, cfg, party, payload, meta) {
  const child = childConfig(cfg, payload.child);
  await loadRoot(conn, cfg, payload.child, party.id, payload.root_id);
  const { cancelled, restored } = await cancelLatestScheduled(conn, {
    table: child.table, fk: 'root_id', parentId: Number(payload.root_id), versionId: payload.version_id,
  });
  await logChange(conn, cfg, child, party, meta, {
    rootId: Number(payload.root_id), action: 'SCHEDULE_CANCELLED', changeType: 'SCHEDULE_CANCELLED',
    effectiveDate: cancelled.effective_from,
    changes: [{ field: null, old: `version ${cancelled.id} from ${cancelled.effective_from}`, new: `version ${restored.id} open-ended` }],
    oldRow: cancelled, newRow: restored, sensitive: false,
  });
  return { entityType: child.entityType, entityId: Number(payload.root_id) };
}

module.exports = {
  CHILD_SLUGS,
  childConfig,
  normalizeChild,
  loadChildVersions,
  loadRoot,
  formatChild,
  resolveChildren,
  execChildCreate,
  execChildUpdate,
  execChildSetActive,
  execChildSetDefault,
  execChildVerify,
  execChildCancelScheduled,
};
