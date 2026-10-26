/**
 * Client Master / Vendor Master engine. Every function takes a module context (ctx) built for
 * one module, so clients and vendors never share tables, permissions, audit logs or approvals.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');
const { loadCompanyVersions } = require('../companyService');
const {
  httpError, today, parseDate, cleanText, isTruthy,
} = require('../common');
const {
  loadVersions, resolveVersion, assertEffectiveDate, insertFirstVersion, saveVersion, cancelLatestScheduled,
} = require('../versioning');
const { validateGstConsistency, GST_STATE_CODES } = require('../taxValidation');
const { PAYMENT_MODES } = require('../../config/partyModules');
const {
  readFields, assertRequired, changedKeys, pick, dbRow, outFields, auditText,
} = require('./fields');
const { assertCompanyUsable } = require('./access');
const { writeAudit, listAudit } = require('./audit');
const { findDuplicates, scanDuplicates } = require('./duplicates');
const { collectTransactions } = require('./transactions');
const child = require('./childService');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const CODE_RE = /^[A-Z0-9][A-Z0-9\-_/]{0,29}$/;
const KYC_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'];
/** Profile fields that can trigger each duplicate match — edits only warn about matches they introduce. */
const DUPLICATE_FIELDS = {
  GSTIN: ['gstin'], PAN: ['pan'], MOBILE: ['mobile', 'alt_mobile'], EMAIL: ['email'], NAME: ['name', 'legal_name'],
};

// ---------- helpers ----------

function normalizeCode(value) {
  const code = cleanText(value)?.toUpperCase();
  if (!code) return null;
  if (!CODE_RE.test(code)) throw httpError(400, 'code may contain letters, numbers, - _ / (max 30)');
  return code;
}

function normalizeProfile(cfg, data) {
  validateGstConsistency(data);
  if (!data.place_of_supply) data.place_of_supply = data.state_code;
  if (!data[cfg.holdField]) data.hold_reason = data.hold_reason ?? null;
  assertRequired(cfg.profile, data);
  return data;
}

function normalizeFinancial(cfg, data, effectiveDate) {
  if (Number(data.opening_balance) > 0 && !data.opening_balance_date) data.opening_balance_date = effectiveDate;
  assertRequired(cfg.financial, data);
  return data;
}

function defaultRegistrationType(cfg, data) {
  if (data.gstin) return 'REGULAR';
  return data[cfg.categoryField] === 'RETAIL' ? 'CONSUMER' : 'UNREGISTERED';
}

function approvalFor(meta, sensitive) {
  if (meta.approval) return meta.approval;
  if (sensitive) return { status: 'AUTO_APPROVED', approved_by: meta.actor, approved_at: new Date() };
  return null;
}

function formatVersion(specs, v) {
  if (!v) return null;
  return {
    version_id: v.id,
    ...outFields(specs, v),
    effective_from: v.effective_from,
    effective_to: v.effective_to,
    remarks: v.remarks,
    created_by: v.created_by,
    created_at: v.created_at,
  };
}

async function loadParty(conn, ctx, id, { forUpdate = false } = {}) {
  const { cfg } = ctx;
  const [rows] = await conn.query(
    `SELECT * FROM ${cfg.table} WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [Number(id) || 0]
  );
  if (!rows.length || !ctx.canSeeCompany(rows[0].company_id)) throw httpError(404, `${cfg.label} not found`);
  return rows[0];
}

function assertNotMerged(cfg, party) {
  if (party.merged_into_id) {
    throw httpError(400, `${cfg.label} ${party.code} was merged into #${party.merged_into_id} and cannot be changed`);
  }
}

async function partyVersions(conn, cfg, partyId) {
  const [profile, financial] = await Promise.all([
    loadVersions(conn, cfg.versionTable, cfg.fk, [partyId]),
    loadVersions(conn, cfg.financialTable, cfg.fk, [partyId]),
  ]);
  return { profile: profile.get(partyId) || [], financial: financial.get(partyId) || [] };
}

// ---------- profile & financial operations ----------

async function execVersionedUpdate(conn, cfg, party, payload, meta, kind) {
  const isProfile = kind === 'PROFILE';
  const specs = isProfile ? cfg.profile : cfg.financial;
  const table = isProfile ? cfg.versionTable : cfg.financialTable;
  const sensitiveFields = isProfile ? cfg.sensitiveProfile : cfg.sensitiveFinancial;
  const versions = (await loadVersions(conn, table, cfg.fk, [party.id])).get(party.id) || [];
  const latest = versions[versions.length - 1];
  if (!latest) throw httpError(500, `${cfg.label} has no ${kind.toLowerCase()} history`);

  const changes = readFields(specs, payload.changes || {}, { partial: true });
  const changed = changedKeys(specs, changes, latest);
  if (!changed.length) return { noChange: true };

  const effectiveDate = payload.effective_date || today();
  assertEffectiveDate(latest, effectiveDate);
  const merged = { ...pick(specs, latest), ...changes };
  if (isProfile) {
    normalizeProfile(cfg, merged);
    if (changed.some((f) => Object.values(DUPLICATE_FIELDS).flat().includes(f))) {
      const dup = await findDuplicates(conn, cfg, party.company_id, merged, party.id);
      if (dup.errors.length) throw Object.assign(httpError(409, 'Duplicate found'), { details: dup });
      const relevant = dup.warnings.filter((w) => (DUPLICATE_FIELDS[w.match_on] || []).some((f) => changed.includes(f)));
      if (relevant.length && !isTruthy(payload.acknowledge_duplicates)) {
        throw Object.assign(httpError(409, 'Possible duplicate — resend with acknowledge_duplicates=true to continue'), {
          details: { errors: [], warnings: relevant },
        });
      }
    }
  } else {
    normalizeFinancial(cfg, merged, effectiveDate);
  }

  const sensitive = changed.some((f) => sensitiveFields.includes(f));
  const approval = approvalFor(meta, sensitive);
  const { mode } = await saveVersion(conn, {
    table,
    fk: cfg.fk,
    parentId: party.id,
    latest,
    fields: Object.keys(specs),
    data: dbRow(specs, merged),
    effectiveDate,
    remarks: meta.reason,
    actor: meta.actor,
    extra: { approval_id: meta.approval?.id || null },
  });

  let action = mode === 'CORRECTED' ? 'CORRECTED' : 'UPDATED';
  if (isProfile && changed.includes('status')) action = merged.status === 'INACTIVE' ? 'DEACTIVATED' : 'REACTIVATED';
  await writeAudit(conn, cfg, {
    companyId: party.company_id,
    partyId: party.id,
    entityType: kind,
    entityId: null,
    action,
    effectiveDate,
    reason: meta.reason,
    actor: meta.actor,
    role: meta.role,
    approval,
  }, changed.map((f) => ({ field: f, old: auditText(specs[f], latest[f]), new: auditText(specs[f], merged[f]) })));

  return {
    sensitive,
    entityType: kind,
    entityId: null,
    effectiveDate,
    changed,
    summary: `${isProfile ? 'Profile' : 'Financial settings'}: ${changed.join(', ')} from ${effectiveDate}`,
  };
}

const EXECUTORS = {
  PROFILE_UPDATE: (conn, cfg, party, payload, meta) => execVersionedUpdate(conn, cfg, party, payload, meta, 'PROFILE'),
  FINANCIAL_UPDATE: (conn, cfg, party, payload, meta) => execVersionedUpdate(conn, cfg, party, payload, meta, 'FINANCIAL'),
  CHILD_CREATE: child.execChildCreate,
  CHILD_UPDATE: child.execChildUpdate,
  CHILD_SET_ACTIVE: child.execChildSetActive,
  CHILD_SET_DEFAULT: child.execChildSetDefault,
};

/**
 * Applies a change, or — when it touches sensitive data and the user cannot approve —
 * validates it fully, rolls back and queues it in <module>_approvals.
 */
async function runChange(ctx, partyId, operation, payload) {
  const { cfg } = ctx;
  ctx.assert('edit');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const party = await loadParty(conn, ctx, partyId, { forUpdate: true });
    assertNotMerged(cfg, party);
    const meta = { actor: ctx.actor, role: ctx.role, reason: payload.reason || null };
    const result = await EXECUTORS[operation](conn, cfg, party, payload, meta);
    if (result.noChange) throw httpError(400, 'No changes to save');

    if (result.sensitive && !ctx.can('approve')) {
      await conn.rollback();
      await conn.beginTransaction();
      const [ins] = await conn.query(
        `INSERT INTO ${cfg.approvalTable}
           (company_id, ${cfg.fk}, operation, entity_type, entity_id, summary, payload, effective_date,
            change_reason, requested_by, requested_by_role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          party.company_id, party.id, operation, result.entityType, result.entityId ?? null,
          result.summary, JSON.stringify(payload), result.effectiveDate || null,
          payload.reason || null, ctx.actor, ctx.role,
        ]
      );
      await writeAudit(conn, cfg, {
        companyId: party.company_id,
        partyId: party.id,
        entityType: result.entityType,
        entityId: result.entityId,
        action: 'APPROVAL_REQUESTED',
        effectiveDate: result.effectiveDate,
        reason: payload.reason,
        actor: ctx.actor,
        role: ctx.role,
        approval: { id: ins.insertId, status: 'PENDING' },
        note: result.summary,
      });
      await conn.commit();
      return {
        status: 'PENDING_APPROVAL',
        message: 'Sensitive change saved for approval — it applies once approved',
        approval_id: ins.insertId,
        summary: result.summary,
      };
    }
    await conn.commit();
    return {
      status: 'APPLIED',
      summary: result.summary,
      entity_type: result.entityType,
      entity_id: result.entityId,
      effective_date: result.effectiveDate,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------- create ----------

async function nextCode(conn, cfg, companyId) {
  const prefix = `${cfg.codePrefix}-`;
  const [[row]] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING(code, ?) AS UNSIGNED)) AS n FROM ${cfg.table}
     WHERE company_id = ? AND code REGEXP ?`,
    [prefix.length + 1, companyId, `^${cfg.codePrefix}-[0-9]+$`]
  );
  return `${prefix}${String(Number(row.n || 0) + 1).padStart(5, '0')}`;
}

async function createParty(ctx, body) {
  const { cfg } = ctx;
  ctx.assert('create');
  await assertCompanyUsable(ctx, body.company_id);
  const companyId = Number(body.company_id);

  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const companyStart = (await loadCompanyVersions(pool, companyId))[0]?.effective_from;
  if (companyStart && effectiveDate < companyStart) {
    throw httpError(400, `effective_date cannot be before the company's effective date (${companyStart})`);
  }
  const reason = cleanText(body.reason) ?? null;

  const profile = readFields(cfg.profile, body);
  if (!cleanText(body.gst_registration_type)) profile.gst_registration_type = defaultRegistrationType(cfg, profile);
  normalizeProfile(cfg, profile);

  if (body.financial !== undefined && (typeof body.financial !== 'object' || Array.isArray(body.financial))) {
    throw httpError(400, 'financial must be an object');
  }
  const financial = normalizeFinancial(cfg, readFields(cfg.financial, body.financial || {}), effectiveDate);

  const childInputs = [];
  for (const key of Object.keys(cfg.children)) {
    if (key === 'documents' || body[key] === undefined) continue;
    if (!Array.isArray(body[key])) throw httpError(400, `${key} must be an array`);
    body[key].forEach((item, i) => {
      const label = `${key}[${i}].`;
      child.normalizeChild(cfg, key, readFields(cfg.children[key].fields, item || {}, { labelPrefix: label }), label);
      childInputs.push({ key, data: item });
    });
  }

  const approved = ctx.can('approve');
  const conn = await pool.getConnection();
  let partyId;
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);

    let code = normalizeCode(body.code);
    if (code) {
      const [taken] = await conn.query(`SELECT id FROM ${cfg.table} WHERE company_id = ? AND code = ?`, [companyId, code]);
      if (taken.length) throw httpError(409, `${cfg.label} code ${code} already exists in this company`);
    } else {
      code = await nextCode(conn, cfg, companyId);
    }

    const dup = await findDuplicates(conn, cfg, companyId, profile);
    if (dup.errors.length) throw Object.assign(httpError(409, 'Duplicate found'), { details: dup });
    if (dup.warnings.length && !isTruthy(body.acknowledge_duplicates)) {
      throw Object.assign(
        httpError(409, 'Possible duplicate — resend with acknowledge_duplicates=true to continue'),
        { details: dup }
      );
    }

    const [ins] = await conn.query(
      `INSERT INTO ${cfg.table} (company_id, code, approval_status, approved_by, approved_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [companyId, code, approved ? 'APPROVED' : 'PENDING', approved ? ctx.actor : null, approved ? new Date() : null, ctx.actor]
    );
    partyId = ins.insertId;
    const party = { id: partyId, company_id: companyId, code };

    let approval = null;
    if (!approved) {
      const [appr] = await conn.query(
        `INSERT INTO ${cfg.approvalTable}
           (company_id, ${cfg.fk}, operation, entity_type, summary, effective_date, change_reason, requested_by, requested_by_role)
         VALUES (?, ?, 'RECORD_CREATE', 'RECORD', ?, ?, ?, ?, ?)`,
        [companyId, partyId, `New ${cfg.label.toLowerCase()} ${code} ${profile.name}`, effectiveDate, reason, ctx.actor, ctx.role]
      );
      approval = { id: appr.insertId, status: 'PENDING' };
    }

    await insertFirstVersion(conn, {
      table: cfg.versionTable, fk: cfg.fk, parentId: partyId, fields: Object.keys(cfg.profile),
      data: dbRow(cfg.profile, profile), effectiveDate, remarks: reason, actor: ctx.actor,
    });
    await insertFirstVersion(conn, {
      table: cfg.financialTable, fk: cfg.fk, parentId: partyId, fields: Object.keys(cfg.financial),
      data: dbRow(cfg.financial, financial), effectiveDate, remarks: reason, actor: ctx.actor,
    });

    const auditMeta = {
      companyId, partyId, effectiveDate, reason, actor: ctx.actor, role: ctx.role, approval,
    };
    await writeAudit(conn, cfg, { ...auditMeta, entityType: 'RECORD', action: 'CREATED', note: code });
    const nonEmpty = (specs, data) => Object.keys(specs)
      .filter((f) => data[f] !== null && data[f] !== undefined && !(specs[f].type === 'bool' && !data[f]))
      .map((f) => ({ field: f, old: null, new: auditText(specs[f], data[f]) }));
    await writeAudit(conn, cfg, { ...auditMeta, entityType: 'PROFILE', action: 'ADDED' }, nonEmpty(cfg.profile, profile));
    await writeAudit(conn, cfg, { ...auditMeta, entityType: 'FINANCIAL', action: 'ADDED' }, nonEmpty(cfg.financial, financial));

    const meta = { actor: ctx.actor, role: ctx.role, reason, approval };
    for (const { key, data } of childInputs) {
      await child.execChildCreate(conn, cfg, party, { child: key, data, effective_date: effectiveDate }, meta);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getParty(ctx, partyId, { as_of: effectiveDate });
}

// ---------- read ----------

const LIST_PROFILE_FIELDS = (cfg) => [
  cfg.categoryField, 'name', 'legal_name', 'mobile', 'email', 'gstin', 'pan', 'gst_registration_type',
  'state_code', 'status', cfg.holdField,
];

async function listParties(ctx, query = {}) {
  const { cfg } = ctx;
  ctx.assert('view');
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const scope = ctx.companyFilter('p.company_id');
  const where = [scope.sql];
  const params = [asOf, ...scope.params];
  const add = (sql, ...values) => { where.push(sql); params.push(...values); };

  if (!isTruthy(query.include_merged)) where.push('p.merged_into_id IS NULL');
  if (cleanText(query.company_id)) add('p.company_id = ?', Number(query.company_id));
  if (cleanText(query.approval_status)) add('p.approval_status = ?', String(query.approval_status).toUpperCase());
  if (cleanText(query.kyc_status)) add('p.kyc_status = ?', String(query.kyc_status).toUpperCase());
  if (cleanText(query.status)) add('v.status = ?', String(query.status).toUpperCase());
  if (cleanText(query[cfg.categoryField])) add(`v.${cfg.categoryField} = ?`, String(query[cfg.categoryField]).toUpperCase());
  if (cleanText(query.state_code)) add('v.state_code = ?', String(query.state_code).padStart(2, '0'));
  if (query[cfg.holdField] !== undefined && cleanText(query[cfg.holdField])) add(`v.${cfg.holdField} = ?`, isTruthy(query[cfg.holdField]) ? 1 : 0);
  if (cleanText(query.search)) {
    const like = `%${query.search}%`;
    add('(p.code LIKE ? OR v.name LIKE ? OR v.legal_name LIKE ? OR v.gstin LIKE ? OR v.pan LIKE ? OR v.mobile LIKE ? OR v.email LIKE ?)',
      like, like, like, like, like, like, like);
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const fromSql = `
    FROM ${cfg.table} p
    JOIN ${cfg.versionTable} v ON v.id = COALESCE(
      (SELECT x.id FROM ${cfg.versionTable} x WHERE x.${cfg.fk} = p.id AND x.effective_from <= ?
       ORDER BY x.effective_from DESC LIMIT 1),
      (SELECT y.id FROM ${cfg.versionTable} y WHERE y.${cfg.fk} = p.id ORDER BY y.effective_from LIMIT 1))
    WHERE ${where.join(' AND ')}`;

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${fromSql}`, params);
  const fields = LIST_PROFILE_FIELDS(cfg);
  // Newest master changes first so KYC / approval edits show up at top of the list
  const [rows] = await pool.query(
    `SELECT p.id, p.code, p.company_id, p.approval_status, p.kyc_status, p.kyc_updated_at, p.kyc_remarks,
            p.outstanding_balance, p.advance_balance, p.merged_into_id, p.created_at, p.updated_at,
            v.id AS version_id, v.effective_from,
            ${fields.map((f) => `v.${f}`).join(', ')}
     ${fromSql}
     ORDER BY COALESCE(p.kyc_updated_at, p.updated_at) DESC, p.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]
  );
  const data = rows.map((r) => ({
    id: r.id,
    code: r.code,
    company_id: r.company_id,
    ...Object.fromEntries(fields.map((f) => [f, f === cfg.holdField ? !!r[f] : r[f]])),
    approval_status: r.approval_status,
    /** Live from master row (not versioned) — PENDING / VERIFIED / REJECTED */
    kyc_status: r.kyc_status,
    kyc_updated_at: r.kyc_updated_at,
    kyc_remarks: r.kyc_remarks,
    outstanding_balance: Number(r.outstanding_balance),
    advance_balance: Number(r.advance_balance),
    merged_into_id: r.merged_into_id,
    effective_status: r.effective_from <= asOf ? 'EFFECTIVE' : 'NOT_YET_EFFECTIVE',
    version_id: r.version_id,
    effective_from: r.effective_from,
    updated_at: r.updated_at,
  }));
  return { as_of: asOf, data, page, limit, total: Number(total) };
}

async function pendingApprovals(cfg, partyId) {
  const [rows] = await pool.query(
    `SELECT id, operation, entity_type, entity_id, summary, effective_date, change_reason, requested_by, requested_at
     FROM ${cfg.approvalTable} WHERE ${cfg.fk} = ? AND status = 'PENDING' ORDER BY id`,
    [partyId]
  );
  return rows;
}

async function getParty(ctx, id, query = {}) {
  const { cfg } = ctx;
  ctx.assert('view');
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const party = await loadParty(pool, ctx, id);
  const versions = await partyVersions(pool, cfg, party.id);
  const profile = resolveVersion(versions.profile, asOf);
  const financial = resolveVersion(versions.financial, asOf);
  const mask = !ctx.can('edit');
  const includeInactive = isTruthy(query.include_inactive);

  const sections = {};
  for (const key of Object.keys(cfg.children)) {
    const byRoot = await child.loadChildVersions(pool, cfg, key, [party.id]);
    sections[key] = child.resolveChildren(cfg, key, byRoot, asOf, { includeInactive, mask });
  }

  return {
    id: party.id,
    code: party.code,
    company_id: party.company_id,
    as_of: asOf,
    effective_status: profile.current ? 'EFFECTIVE' : 'NOT_YET_EFFECTIVE',
    approval_status: party.approval_status,
    approved_by: party.approved_by,
    approved_at: party.approved_at,
    approval_remarks: party.approval_remarks,
    kyc_status: party.kyc_status,
    kyc_updated_by: party.kyc_updated_by,
    kyc_updated_at: party.kyc_updated_at,
    kyc_remarks: party.kyc_remarks,
    balances: {
      outstanding_balance: Number(party.outstanding_balance),
      advance_balance: Number(party.advance_balance),
      labels: cfg.balanceLabels,
      note: 'Maintained by transaction modules',
    },
    merged_into_id: party.merged_into_id,
    merged_at: party.merged_at,
    merged_by: party.merged_by,
    merge_reason: party.merge_reason,
    profile: formatVersion(cfg.profile, profile.current || profile.upcoming),
    financial: formatVersion(cfg.financial, financial.current || financial.upcoming),
    upcoming_changes: {
      profile: profile.current && profile.upcoming
        ? { version_id: profile.upcoming.id, effective_from: profile.upcoming.effective_from, remarks: profile.upcoming.remarks }
        : null,
      financial: financial.current && financial.upcoming
        ? { version_id: financial.upcoming.id, effective_from: financial.upcoming.effective_from, remarks: financial.upcoming.remarks }
        : null,
    },
    ...sections,
    pending_approvals: await pendingApprovals(cfg, party.id),
    created_by: party.created_by,
    created_at: party.created_at,
    updated_at: party.updated_at,
    your_permissions: ctx.permissions,
  };
}

async function getVersions(ctx, id) {
  const { cfg } = ctx;
  ctx.assert('view');
  const party = await loadParty(pool, ctx, id);
  const versions = await partyVersions(pool, cfg, party.id);
  return {
    profile: versions.profile.map((v) => formatVersion(cfg.profile, v)).reverse(),
    financial: versions.financial.map((v) => formatVersion(cfg.financial, v)).reverse(),
  };
}

// ---------- profile / financial edits ----------

function editPayload(body, extra = {}) {
  return {
    effective_date: parseDate(body.effective_date, 'effective_date') || today(),
    reason: cleanText(body.reason) ?? null,
    acknowledge_duplicates: isTruthy(body.acknowledge_duplicates),
    ...extra,
  };
}

/** Map common frontend camelCase / alternate keys onto party profile + KYC fields. */
function normalizeEditBody(cfg, raw = {}) {
  const body = { ...raw };
  const aliases = {
    clientName: 'name', vendorName: 'name', name: 'name',
    legalName: 'legal_name',
    tradeName: 'trade_name', businessName: 'trade_name',
    clientCategory: cfg.categoryField, vendorType: cfg.categoryField, clientType: cfg.categoryField,
    phone: 'mobile', mobile: 'mobile',
    altPhone: 'alt_mobile', altMobile: 'alt_mobile',
    contactPerson: 'contact_person', primaryContactPerson: 'contact_person',
    gstin: 'gstin', pan: 'pan',
    registrationType: 'gst_registration_type', gstRegType: 'gst_registration_type',
    placeOfSupply: 'place_of_supply',
    stateCode: 'state_code',
    creditHold: cfg.holdField, paymentHold: cfg.holdField,
    internalRemarks: 'internal_remarks', remarks: 'internal_remarks',
    customerGroup: 'customer_group', priceList: 'price_list',
    salesperson: 'salesperson', customerTerms: 'customer_terms',
    defaultPurchaseLedger: 'default_purchase_ledger',
    purchasePriceList: 'purchase_price_list',
    kycStatus: 'kyc_status', kyc_status: 'kyc_status',
    kycRemarks: 'kyc_remarks', kyc_remarks: 'kyc_remarks',
  };
  for (const [from, to] of Object.entries(aliases)) {
    if (body[from] !== undefined && body[to] === undefined) body[to] = body[from];
  }
  return body;
}

async function updateProfile(ctx, id, body) {
  const { cfg } = ctx;
  body = normalizeEditBody(cfg, body);
  // Ignore identity fields from frontend payloads (clientCode / code / company_id are immutable)
  delete body.code;
  delete body.clientCode;
  delete body.vendorCode;
  delete body.company_id;
  delete body.companyId;

  // KYC via normal edit body — accept kyc_status, nested kyc.status, or status=PENDING|VERIFIED|REJECTED
  // (profile "status" is only ACTIVE/INACTIVE; KYC values must not go into profile versions)
  const bodyStatus = cleanText(body.status)?.toUpperCase();
  const nestedKyc = body.kyc && typeof body.kyc === 'object' ? body.kyc : null;
  let kycStatus = body.kyc_status ?? nestedKyc?.status ?? nestedKyc?.kyc_status;
  if (kycStatus === undefined && KYC_STATUSES.includes(bodyStatus)) {
    kycStatus = bodyStatus;
  }
  if (kycStatus !== undefined) kycStatus = cleanText(kycStatus)?.toUpperCase();

  const changes = Object.fromEntries(
    Object.keys(cfg.profile)
      .filter((f) => body[f] !== undefined)
      .filter((f) => !(f === 'status' && KYC_STATUSES.includes(bodyStatus)))
      .map((f) => [f, body[f]])
  );
  const hasProfileChanges = Object.keys(changes).length > 0;

  if (!hasProfileChanges && kycStatus === undefined) {
    throw httpError(400, 'No changes to save');
  }

  let result = null;
  if (hasProfileChanges) {
    result = await runChange(ctx, id, 'PROFILE_UPDATE', editPayload(body, { changes }));
  }
  if (kycStatus !== undefined) {
    result = await setKyc(ctx, id, {
      status: kycStatus,
      remarks: cleanText(body.kyc_remarks) ?? cleanText(nestedKyc?.remarks) ?? cleanText(body.reason),
    });
  }
  return result;
}

async function updateFinancial(ctx, id, body) {
  const { cfg } = ctx;
  const changes = Object.fromEntries(Object.keys(cfg.financial).filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));
  return runChange(ctx, id, 'FINANCIAL_UPDATE', editPayload(body, { changes }));
}

async function cancelScheduled(ctx, id, kind, versionId) {
  const { cfg } = ctx;
  ctx.assert('edit');
  const table = kind === 'PROFILE' ? cfg.versionTable : cfg.financialTable;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const party = await loadParty(conn, ctx, id, { forUpdate: true });
    assertNotMerged(cfg, party);
    const { cancelled, restored } = await cancelLatestScheduled(conn, { table, fk: cfg.fk, parentId: party.id, versionId });
    await writeAudit(conn, cfg, {
      companyId: party.company_id, partyId: party.id, entityType: kind, action: 'SCHEDULE_CANCELLED',
      effectiveDate: cancelled.effective_from, actor: ctx.actor, role: ctx.role,
      note: `Cancelled version ${cancelled.id} from ${cancelled.effective_from}; version ${restored.id} is open-ended again`,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getParty(ctx, id);
}

// ---------- children ----------

function childKeyFromSlug(slug) {
  const key = child.CHILD_SLUGS[slug];
  if (!key) throw httpError(404, `Unknown section ${slug}`);
  return key;
}

async function listChildren(ctx, id, key, query = {}) {
  const { cfg } = ctx;
  ctx.assert('view');
  const party = await loadParty(pool, ctx, id);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const byRoot = await child.loadChildVersions(pool, cfg, key, [party.id]);
  return child.resolveChildren(cfg, key, byRoot, asOf, {
    includeInactive: isTruthy(query.include_inactive),
    mask: !ctx.can('edit'),
  });
}

async function childHistory(ctx, id, key, rootId) {
  const { cfg } = ctx;
  ctx.assert('view');
  const party = await loadParty(pool, ctx, id);
  const childCfg = child.childConfig(cfg, key);
  const versions = await child.loadRoot(pool, cfg, key, party.id, rootId);
  const mask = !ctx.can('edit');
  let changes;
  if (childCfg.historyTable) {
    const [rows] = await pool.query(
      `SELECT * FROM ${childCfg.historyTable} WHERE ${cfg.fk} = ? AND root_id = ? ORDER BY id DESC`,
      [party.id, Number(rootId)]
    );
    changes = rows;
    if (mask && childCfg.masked) {
      const m = (vals) => (vals?.[childCfg.masked] ? { ...vals, [childCfg.masked]: `XXXX${String(vals[childCfg.masked]).slice(-4)}` } : vals);
      changes = rows.map((r) => ({ ...r, old_values: m(r.old_values), new_values: m(r.new_values) }));
    }
  } else {
    changes = (await listAudit(ctx, { entity_type: childCfg.entityType, entity_id: rootId, limit: 500 }, party.id)).data;
  }
  return {
    id: Number(rootId),
    versions: versions.map((v) => child.formatChild(cfg, key, v, { mask })).reverse(),
    changes,
  };
}

function childEdit(body) {
  const { effective_date: _e, reason: _r, acknowledge_duplicates: _a, ...data } = body || {};
  return data;
}

async function addChild(ctx, id, key, body, file = null) {
  if (key === 'documents' && !file) throw httpError(400, 'file is required (multipart/form-data field "file")');
  return runChange(ctx, id, 'CHILD_CREATE', editPayload(body, { child: key, data: childEdit(body), file }));
}

async function updateChild(ctx, id, key, rootId, body, file = null) {
  return runChange(ctx, id, 'CHILD_UPDATE', editPayload(body, { child: key, root_id: Number(rootId), changes: childEdit(body), file }));
}

async function setChildActive(ctx, id, key, rootId, body, active) {
  return runChange(ctx, id, 'CHILD_SET_ACTIVE', editPayload(body, { child: key, root_id: Number(rootId), is_active: active }));
}

async function setChildDefault(ctx, id, key, rootId, body) {
  return runChange(ctx, id, 'CHILD_SET_DEFAULT', editPayload(body, { child: key, root_id: Number(rootId) }));
}

async function directChildOp(ctx, id, permission, op, payload) {
  const { cfg } = ctx;
  ctx.assert(permission);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const party = await loadParty(conn, ctx, id, { forUpdate: true });
    assertNotMerged(cfg, party);
    await op(conn, cfg, party, payload, { actor: ctx.actor, role: ctx.role, reason: payload.reason || null });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function verifyChild(ctx, id, key, rootId, body) {
  await directChildOp(ctx, id, 'approve', child.execChildVerify, {
    child: key, root_id: Number(rootId), status: body.status, reason: cleanText(body.remarks ?? body.reason),
  });
  return listChildren(ctx, id, key, { include_inactive: true });
}

async function cancelChildScheduled(ctx, id, key, rootId, versionId) {
  await directChildOp(ctx, id, 'edit', child.execChildCancelScheduled, {
    child: key, root_id: Number(rootId), version_id: Number(versionId),
  });
  return childHistory(ctx, id, key, rootId);
}

async function getDocumentFile(ctx, id, rootId, versionId) {
  const { cfg } = ctx;
  ctx.assert('view');
  const party = await loadParty(pool, ctx, id);
  const versions = await child.loadRoot(pool, cfg, 'documents', party.id, rootId);
  const v = versionId ? versions.find((x) => x.id === Number(versionId)) : versions[versions.length - 1];
  if (!v || !v.file_path) throw httpError(404, 'File not found');
  const abs = path.join(PROJECT_ROOT, v.file_path);
  if (!fs.existsSync(abs)) throw httpError(404, 'File missing on server');
  return { path: abs, name: v.original_name, mime: v.mime_type };
}

// ---------- approvals ----------

async function listApprovals(ctx, query = {}) {
  const { cfg } = ctx;
  if (!ctx.can('approve') && !ctx.can('audit')) throw httpError(403, `Permission ${cfg.key}.approve or ${cfg.key}.audit required`);
  const scope = ctx.companyFilter('a.company_id');
  const where = [scope.sql];
  const params = [...scope.params];
  const status = cleanText(query.status)?.toUpperCase() ?? 'PENDING';
  if (status !== 'ALL') { where.push('a.status = ?'); params.push(status); }
  if (cleanText(query.company_id)) { where.push('a.company_id = ?'); params.push(Number(query.company_id)); }
  if (cleanText(query[cfg.fk])) { where.push(`a.${cfg.fk} = ?`); params.push(Number(query[cfg.fk])); }
  const [rows] = await pool.query(
    `SELECT a.*, p.code AS ${cfg.prefix}_code FROM ${cfg.approvalTable} a
     JOIN ${cfg.table} p ON p.id = a.${cfg.fk}
     WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 500`,
    params
  );
  return rows;
}

async function decideApproval(ctx, approvalId, body) {
  const { cfg } = ctx;
  ctx.assert('approve');
  const action = String(body.action || '').toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(action)) throw httpError(400, 'action must be APPROVE or REJECT');
  const remarks = cleanText(body.remarks) ?? null;
  if (action === 'REJECT' && !remarks) throw httpError(400, 'remarks are required when rejecting');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT * FROM ${cfg.approvalTable} WHERE id = ? FOR UPDATE`, [Number(approvalId) || 0]);
    const row = rows[0];
    if (!row || !ctx.canSeeCompany(row.company_id)) throw httpError(404, 'Approval not found');
    if (row.status !== 'PENDING') throw httpError(400, `Approval is already ${row.status}`);
    const party = await loadParty(conn, ctx, row[cfg.fk], { forUpdate: true });
    const now = new Date();
    const approval = { id: row.id, status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', approved_by: ctx.actor, approved_at: now };

    if (action === 'APPROVE' && row.operation !== 'RECORD_CREATE') {
      assertNotMerged(cfg, party);
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const result = await EXECUTORS[row.operation](conn, cfg, party, payload, {
        actor: row.requested_by, role: row.requested_by_role, reason: row.change_reason, approval,
      });
      if (result.noChange) throw httpError(409, 'The requested change no longer differs from current data — reject it instead');
    }
    if (row.operation === 'RECORD_CREATE') {
      await conn.query(
        `UPDATE ${cfg.table} SET approval_status = ?, approved_by = ?, approved_at = ?, approval_remarks = ? WHERE id = ?`,
        [approval.status, ctx.actor, now, remarks, party.id]
      );
    }
    await conn.query(
      `UPDATE ${cfg.approvalTable} SET status = ?, decided_by = ?, decided_at = ?, decision_remarks = ? WHERE id = ?`,
      [approval.status, ctx.actor, now, remarks, row.id]
    );
    await writeAudit(conn, cfg, {
      companyId: party.company_id, partyId: party.id, entityType: row.entity_type, entityId: row.entity_id,
      action: action === 'APPROVE' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
      effectiveDate: row.effective_date, reason: remarks, actor: ctx.actor, role: ctx.role, approval,
      note: row.summary,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  const [[updated]] = await pool.query(`SELECT * FROM ${cfg.approvalTable} WHERE id = ?`, [Number(approvalId)]);
  return updated;
}

async function cancelApproval(ctx, approvalId) {
  const { cfg } = ctx;
  const [rows] = await pool.query(`SELECT * FROM ${cfg.approvalTable} WHERE id = ?`, [Number(approvalId) || 0]);
  const row = rows[0];
  if (!row || !ctx.canSeeCompany(row.company_id)) throw httpError(404, 'Approval not found');
  if (row.status !== 'PENDING') throw httpError(400, `Approval is already ${row.status}`);
  if (row.operation === 'RECORD_CREATE') throw httpError(400, 'A new-record approval cannot be cancelled — ask an approver to reject it');
  if (row.requested_by !== ctx.actor && !ctx.can('approve')) throw httpError(403, 'Only the requester or an approver can cancel');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE ${cfg.approvalTable} SET status = 'CANCELLED', decided_by = ?, decided_at = NOW() WHERE id = ?`,
      [ctx.actor, row.id]
    );
    await writeAudit(conn, cfg, {
      companyId: row.company_id, partyId: row[cfg.fk], entityType: row.entity_type, entityId: row.entity_id,
      action: 'APPROVAL_CANCELLED', effectiveDate: row.effective_date, actor: ctx.actor, role: ctx.role,
      approval: { id: row.id, status: 'REJECTED' }, note: row.summary,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { id: row.id, status: 'CANCELLED' };
}

// ---------- record status: approval, KYC, merge ----------

async function setRecordApproval(ctx, id, body) {
  const { cfg } = ctx;
  ctx.assert('approve');
  const status = { APPROVE: 'APPROVED', REJECT: 'REJECTED' }[String(body.action || '').toUpperCase()];
  if (!status) throw httpError(400, 'action must be APPROVE or REJECT');
  const remarks = cleanText(body.remarks) ?? null;
  if (status === 'REJECTED' && !remarks) throw httpError(400, 'remarks are required when rejecting');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const party = await loadParty(conn, ctx, id, { forUpdate: true });
    if (party.approval_status === status) throw httpError(400, `${cfg.label} is already ${status}`);
    await conn.query(
      `UPDATE ${cfg.table} SET approval_status = ?, approved_by = ?, approved_at = NOW(), approval_remarks = ? WHERE id = ?`,
      [status, ctx.actor, remarks, party.id]
    );
    await conn.query(
      `UPDATE ${cfg.approvalTable} SET status = ?, decided_by = ?, decided_at = NOW(), decision_remarks = ?
       WHERE ${cfg.fk} = ? AND operation = 'RECORD_CREATE' AND status = 'PENDING'`,
      [status, ctx.actor, remarks, party.id]
    );
    await writeAudit(conn, cfg, {
      companyId: party.company_id, partyId: party.id, entityType: 'RECORD', action: `RECORD_${status}`,
      effectiveDate: today(), reason: remarks, actor: ctx.actor, role: ctx.role,
      approval: { status, approved_by: ctx.actor, approved_at: new Date() },
    }, [{ field: 'approval_status', old: party.approval_status, new: status }]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getParty(ctx, id);
}

async function setKyc(ctx, id, body) {
  const { cfg } = ctx;
  // approve preferred; edit also allowed so form save (PUT) works for admin/company users
  if (!ctx.can('approve') && !ctx.can('edit')) {
    throw httpError(403, `Permission ${cfg.key}.approve or ${cfg.key}.edit required`);
  }
  const status = cleanText(body.status ?? body.kyc_status)?.toUpperCase();
  if (!KYC_STATUSES.includes(status)) throw httpError(400, `status must be one of ${KYC_STATUSES.join(', ')}`);
  const remarks = cleanText(body.remarks ?? body.kyc_remarks) ?? null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const party = await loadParty(conn, ctx, id, { forUpdate: true });
    const statusChanged = party.kyc_status !== status;
    const remarksChanged = remarks !== (party.kyc_remarks ?? null);
    if (!statusChanged && !remarksChanged) {
      await conn.commit();
      return getParty(ctx, id);
    }
    await conn.query(
      `UPDATE ${cfg.table}
       SET kyc_status = ?, kyc_updated_by = ?, kyc_updated_at = NOW(), kyc_remarks = ?, updated_at = NOW()
       WHERE id = ?`,
      [status, ctx.actor, remarks, party.id]
    );
    const changes = [];
    if (statusChanged) changes.push({ field: 'kyc_status', old: party.kyc_status, new: status });
    if (remarksChanged) changes.push({ field: 'kyc_remarks', old: party.kyc_remarks, new: remarks });
    await writeAudit(conn, cfg, {
      companyId: party.company_id, partyId: party.id, entityType: 'RECORD', action: 'KYC',
      effectiveDate: today(), reason: remarks, actor: ctx.actor, role: ctx.role,
    }, changes);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getParty(ctx, id);
}

/**
 * Merges a duplicate (source) into a surviving record (target). The source is kept — marked
 * merged + inactive — so its versions, child records, audit log and transactions stay intact;
 * transaction history of the target includes merged sources.
 */
async function mergeParty(ctx, sourceId, body) {
  const { cfg } = ctx;
  ctx.assert('merge');
  const targetId = Number(body.into_id);
  const reason = cleanText(body.reason);
  if (!targetId) throw httpError(400, 'into_id is required');
  if (!reason) throw httpError(400, 'reason is required for a merge');
  if (targetId === Number(sourceId)) throw httpError(400, `A ${cfg.label.toLowerCase()} cannot be merged into itself`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const source = await loadParty(conn, ctx, sourceId, { forUpdate: true });
    const target = await loadParty(conn, ctx, targetId, { forUpdate: true });
    assertNotMerged(cfg, source);
    assertNotMerged(cfg, target);
    if (source.company_id !== target.company_id) throw httpError(400, 'Records belong to different companies');

    await conn.query(
      `UPDATE ${cfg.table} SET merged_into_id = ?, merged_at = NOW(), merged_by = ?, merge_reason = ? WHERE id = ?`,
      [target.id, ctx.actor, reason, source.id]
    );
    await conn.query(`UPDATE ${cfg.table} SET merged_into_id = ? WHERE merged_into_id = ?`, [target.id, source.id]);

    const versions = (await loadVersions(conn, cfg.versionTable, cfg.fk, [source.id])).get(source.id) || [];
    const latest = versions[versions.length - 1];
    const effectiveDate = latest.effective_from > today() ? latest.effective_from : today();
    if (latest.status !== 'INACTIVE') {
      await saveVersion(conn, {
        table: cfg.versionTable, fk: cfg.fk, parentId: source.id, latest, fields: Object.keys(cfg.profile),
        data: { ...dbRow(cfg.profile, pick(cfg.profile, latest)), status: 'INACTIVE' },
        effectiveDate, remarks: `Merged into ${target.code}: ${reason}`, actor: ctx.actor,
      });
    }
    const meta = { effectiveDate, reason, actor: ctx.actor, role: ctx.role, companyId: source.company_id, entityType: 'RECORD' };
    await writeAudit(conn, cfg, { ...meta, partyId: source.id, action: 'MERGED_INTO' }, [
      { field: 'merged_into_id', old: null, new: `${target.id} (${target.code})` },
      ...(latest.status !== 'INACTIVE' ? [{ field: 'status', old: latest.status, new: 'INACTIVE' }] : []),
    ]);
    await writeAudit(conn, cfg, { ...meta, partyId: target.id, action: 'MERGED_FROM' }, [
      { field: 'merged_from', old: null, new: `${source.id} (${source.code})` },
    ]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getParty(ctx, targetId);
}

// ---------- snapshot / transactions / duplicates ----------

function pickDefault(list, filter = () => true) {
  const candidates = list.filter(filter);
  return candidates.find((c) => c.is_default) || candidates[0] || null;
}

/**
 * Details as they were on `date` — store this JSON on invoices / vouchers so documents keep
 * their transaction-time address, GST, tax and party details.
 */
async function buildSnapshot(cfg, party, date) {
  const versions = await partyVersions(pool, cfg, party.id);
  const profile = resolveVersion(versions.profile, date).current;
  const financial = resolveVersion(versions.financial, date).current;
  if (!profile) throw httpError(400, `${cfg.label} ${party.code} is not effective on ${date}`);

  const sections = {};
  for (const key of Object.keys(cfg.children)) {
    if (key === 'documents') continue;
    const byRoot = await child.loadChildVersions(pool, cfg, key, [party.id]);
    sections[key] = child.resolveChildren(cfg, key, byRoot, date, { includeUpcoming: false });
  }
  const addressTypes = cfg.children.addresses.fields.address_type.values;
  const addresses = Object.fromEntries(
    addressTypes.map((t) => [t, pickDefault(sections.addresses, (a) => a.address_type === t)])
  );

  const reasons = [];
  if (party.merged_into_id) reasons.push(`merged into #${party.merged_into_id}`);
  if (party.approval_status !== 'APPROVED') reasons.push(`approval status ${party.approval_status}`);
  if (profile.status !== 'ACTIVE') reasons.push('inactive');
  const hold = !!profile[cfg.holdField];

  return {
    module: cfg.key,
    snapshot_date: date,
    [cfg.fk]: party.id,
    code: party.code,
    company_id: party.company_id,
    profile: formatVersion(cfg.profile, profile),
    financial: formatVersion(cfg.financial, financial),
    addresses,
    gst_registrations: sections.gst_registrations,
    default_bank_account: pickDefault(sections.bank_accounts),
    default_upi: pickDefault(sections.upi_ids),
    primary_contact: pickDefault(sections.contacts),
    state: { name: GST_STATE_CODES[profile.state_code] || null, code: profile.state_code },
    usable: { ok: reasons.length === 0, reasons, [cfg.holdField]: hold, hold_reason: profile.hold_reason },
    generated_at: new Date().toISOString(),
  };
}

async function getSnapshot(ctx, id, query = {}) {
  ctx.assert('view');
  const party = await loadParty(pool, ctx, id);
  return buildSnapshot(ctx.cfg, party, parseDate(query.date, 'date') || today());
}

async function getTransactions(ctx, id, query = {}) {
  const { cfg } = ctx;
  ctx.assert('view');
  const party = await loadParty(pool, ctx, id);
  const [merged] = await pool.query(`SELECT id, code FROM ${cfg.table} WHERE merged_into_id = ?`, [party.id]);
  const ids = [party.id, ...merged.map((m) => m.id)];
  return {
    [cfg.fk]: party.id,
    includes_merged: merged,
    balances: {
      outstanding_balance: Number(party.outstanding_balance),
      advance_balance: Number(party.advance_balance),
      labels: cfg.balanceLabels,
    },
    documents: await collectTransactions(cfg, ids, {
      from: parseDate(query.from, 'from'), to: parseDate(query.to, 'to'),
    }),
    note: 'Document types show available=false until the related sales / purchase module is installed',
  };
}

async function checkDuplicates(ctx, body) {
  const { cfg } = ctx;
  ctx.assert('view');
  await assertCompanyUsable(ctx, body.company_id);
  const data = readFields(cfg.profile, body, { partial: true });
  return findDuplicates(pool, cfg, Number(body.company_id), data, Number(body.exclude_id) || null);
}

async function listDuplicates(ctx, query) {
  ctx.assert('view');
  return scanDuplicates(ctx, query);
}

async function auditLogs(ctx, query, partyId = null) {
  ctx.assert('audit');
  if (partyId) await loadParty(pool, ctx, partyId);
  return listAudit(ctx, query, partyId);
}

function describeFields(specs) {
  return Object.fromEntries(Object.entries(specs).map(([name, s]) => [name, {
    type: s.type, required: !!s.required, ...(s.values ? { values: s.values } : {}),
    ...(s.default !== undefined ? { default: s.default } : {}), ...(s.max ? { max_length: s.max } : {}),
    ...(s.label ? { hint: s.label } : {}),
  }]));
}

function meta(ctx) {
  const { cfg } = ctx;
  return {
    module: cfg.key,
    label: cfg.label,
    category_field: cfg.categoryField,
    hold_field: cfg.holdField,
    code_format: `${cfg.codePrefix}-00001 (auto when blank)`,
    profile_fields: describeFields(cfg.profile),
    financial_fields: describeFields(cfg.financial),
    sections: Object.fromEntries(Object.entries(cfg.children).map(([key, c]) => [key, {
      path: Object.keys(child.CHILD_SLUGS).find((s) => child.CHILD_SLUGS[s] === key),
      label: c.label,
      fields: describeFields(c.fields),
      default_selection: c.defaultLabel || null,
      verification: !!c.verification,
      needs_approval: !!c.sensitive,
    }])),
    sensitive_profile_fields: cfg.sensitiveProfile,
    sensitive_financial_fields: cfg.sensitiveFinancial,
    gst_state_codes: GST_STATE_CODES,
    payment_modes: PAYMENT_MODES,
    transaction_types: cfg.transactionTypes,
    balance_labels: cfg.balanceLabels,
    your_permissions: ctx.permissions,
  };
}

module.exports = {
  createParty,
  listParties,
  getParty,
  getVersions,
  updateProfile,
  updateFinancial,
  cancelScheduled,
  childKeyFromSlug,
  listChildren,
  childHistory,
  addChild,
  updateChild,
  setChildActive,
  setChildDefault,
  verifyChild,
  cancelChildScheduled,
  getDocumentFile,
  listApprovals,
  decideApproval,
  cancelApproval,
  setRecordApproval,
  setKyc,
  mergeParty,
  getSnapshot,
  buildSnapshot,
  getTransactions,
  checkDuplicates,
  listDuplicates,
  auditLogs,
  meta,
};
