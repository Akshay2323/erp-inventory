/**
 * Product & Item Master (section A): identification, classification, categories,
 * tags, variants, images/documents, status — with effective-date versioning.
 */
const path = require('path');
const fs = require('fs');
const pool = require('../../config/db');
const {
  httpError, today, parseDate, cleanText, parseBool, isTruthy,
} = require('../common');
const {
  loadVersions, resolveVersion, changedFields, insertFirstVersion, updateLatestVersion,
} = require('../versioning');
const { buildPartyContext, assertCompanyUsable } = require('../party/access');
const {
  PRODUCT_CLASSIFICATIONS, ITEM_TYPES, PRODUCT_STATUSES, MEDIA_TYPES, DEFAULT_CATEGORY_TREE,
  PRODUCT_VERSION_FIELDS, VARIANT_VERSION_FIELDS,
  UOM_CATEGORIES, PREDEFINED_UOMS, GST_RATES, TAX_TYPES, HSN_SAC_TYPES,
  STOCK_STATUSES, STOCK_TXN_TYPES, VALUATION_METHODS, TRACKING_TYPES,
  ATTRIBUTE_TYPES, SUGGESTED_TAGS, PRICE_TYPES,
} = require('../../config/productConfig');
const uomService = require('./uomService');
const gstPricing = require('./gstPricingService');
const attrService = require('./attributeService');
const invService = require('./inventoryService');

const MODULE = { key: 'products', label: 'Product' };
const AUDIT = 'product_audit_logs';
const VERSION_FIELDS = Object.keys(PRODUCT_VERSION_FIELDS);
const VARIANT_FIELDS = Object.keys(VARIANT_VERSION_FIELDS);

async function moduleContext(user, authSource) {
  return buildPartyContext(MODULE, user, authSource);
}

async function writeAudit(conn, meta, changes = []) {
  const rows = changes.length ? changes : [{ field: null, old: null, new: null }];
  await conn.query(
    `INSERT INTO ${AUDIT}
     (company_id, product_id, entity_type, entity_id, action, field_name, old_value, new_value,
      effective_date, change_reason, changed_by, changed_by_role, note)
     VALUES ?`,
    [rows.map((c) => [
      meta.companyId, meta.productId || null, meta.entityType, meta.entityId || null, meta.action,
      c.field, c.old != null ? String(c.old).slice(0, 60000) : null,
      c.new != null ? String(c.new).slice(0, 60000) : null,
      meta.effectiveDate || null, meta.reason || null, meta.actor, meta.role || null, meta.note || null,
    ])]
  );
}

function parseJson(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { throw httpError(400, `${field} must be valid JSON`); }
}

function readVersionFields(specs, body, { partial = false } = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (body[name] === undefined) {
      if (!partial && spec.required) throw httpError(400, `${name} is required`);
      if (!partial && spec.default !== undefined) out[name] = spec.default;
      continue;
    }
    if (spec.type === 'bool') out[name] = parseBool(body[name], name) ? 1 : 0;
    else if (spec.type === 'enum') {
      const v = cleanText(body[name])?.toUpperCase();
      if (v && !spec.values.includes(v)) throw httpError(400, `${name} must be one of ${spec.values.join(', ')}`);
      out[name] = v ?? null;
    } else if (spec.type === 'int') {
      if (body[name] === null || body[name] === '') out[name] = null;
      else {
        const n = Number(body[name]);
        if (!Number.isInteger(n)) throw httpError(400, `${name} must be an integer`);
        out[name] = n;
      }
    } else if (spec.type === 'json') out[name] = parseJson(body[name], name);
    else {
      const t = cleanText(body[name]);
      if (t && spec.max && t.length > spec.max) throw httpError(400, `${name} must be at most ${spec.max} characters`);
      out[name] = t ?? null;
    }
  }
  return out;
}

function dbRow(fields, data) {
  return Object.fromEntries(fields.map((f) => {
    const v = data[f];
    if (v !== null && typeof v === 'object') return [f, JSON.stringify(v)];
    return [f, v ?? null];
  }));
}

function formatVersion(specs, row) {
  if (!row) return null;
  const out = { version_id: row.id, effective_from: row.effective_from, effective_to: row.effective_to, remarks: row.remarks, created_by: row.created_by };
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.type === 'bool') out[name] = !!row[name];
    else if (spec.type === 'json') {
      const v = row[name];
      out[name] = typeof v === 'string' ? JSON.parse(v) : v;
    } else out[name] = row[name] ?? null;
  }
  return out;
}

// ---------- categories ----------

async function seedDefaultCategories(ctx, companyId, body = {}) {
  ctx.assert('create');
  await assertCompanyUsable(ctx, companyId);
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const actor = ctx.actor;
  let created = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [i, node] of DEFAULT_CATEGORY_TREE.entries()) {
      const parentId = await upsertCategory(conn, companyId, null, node, i, effectiveDate, actor);
      created += 1;
      for (const [j, child] of (node.children || []).entries()) {
        await upsertCategory(conn, companyId, parentId, child, j, effectiveDate, actor);
        created += 1;
      }
    }
    await writeAudit(conn, {
      companyId, entityType: 'CATEGORY', action: 'SEEDED', effectiveDate, actor, role: ctx.role,
      reason: cleanText(body.reason) || 'Default electronics categories',
    }, [{ field: 'categories', old: null, new: `${created} categories` }]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return listCategories(ctx, { company_id: companyId, as_of: effectiveDate });
}

async function upsertCategory(conn, companyId, parentId, node, sortOrder, effectiveDate, actor) {
  const [[existing]] = await conn.query(
    'SELECT id FROM product_categories WHERE company_id = ? AND code = ?',
    [companyId, node.code]
  );
  if (existing) return existing.id;
  const [ins] = await conn.query(
    'INSERT INTO product_categories (company_id, parent_id, code, sort_order, created_by) VALUES (?, ?, ?, ?, ?)',
    [companyId, parentId, node.code, sortOrder, actor]
  );
  await insertFirstVersion(conn, {
    table: 'product_category_versions', fk: 'category_id', parentId: ins.insertId,
    fields: ['name', 'description', 'status'],
    data: { name: node.name, description: null, status: 'ACTIVE' },
    effectiveDate, remarks: 'Seeded', actor,
  });
  return ins.insertId;
}

async function listCategories(ctx, query = {}) {
  ctx.assert('view');
  const companyId = Number(query.company_id);
  if (!companyId) throw httpError(400, 'company_id is required');
  if (!ctx.canSeeCompany(companyId)) throw httpError(404, 'Company not found');
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const [rows] = await pool.query(
    'SELECT * FROM product_categories WHERE company_id = ? ORDER BY sort_order, code',
    [companyId]
  );
  const versions = await loadVersions(pool, 'product_category_versions', 'category_id', rows.map((r) => r.id));
  const items = rows.map((r) => {
    const { current, upcoming } = resolveVersion(versions.get(r.id) || [], asOf);
    const v = current || upcoming;
    return {
      id: r.id, company_id: r.company_id, parent_id: r.parent_id, code: r.code, sort_order: r.sort_order,
      name: v?.name || null, description: v?.description || null, status: v?.status || null,
      effective_from: v?.effective_from || null, effective_to: v?.effective_to || null,
    };
  }).filter((x) => !query.status || x.status === String(query.status).toUpperCase());

  const byParent = new Map();
  for (const item of items) {
    const key = item.parent_id || 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(item);
  }
  const tree = (byParent.get(0) || []).map((p) => ({ ...p, children: byParent.get(p.id) || [] }));
  return { company_id: companyId, as_of: asOf, tree, flat: items };
}

async function createCategory(ctx, body = {}) {
  ctx.assert('create');
  const companyId = await assertCompanyUsable(ctx, body.company_id).then((c) => c.id);
  const code = cleanText(body.code)?.toUpperCase();
  const name = cleanText(body.name);
  if (!code || !name) throw httpError(400, 'code and name are required');
  const parentId = body.parent_id ? Number(body.parent_id) : null;
  if (parentId) {
    const [[p]] = await pool.query('SELECT id FROM product_categories WHERE id = ? AND company_id = ?', [parentId, companyId]);
    if (!p) throw httpError(400, 'parent_id not found for this company');
  }
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      'INSERT INTO product_categories (company_id, parent_id, code, sort_order, created_by) VALUES (?, ?, ?, ?, ?)',
      [companyId, parentId, code, Number(body.sort_order) || 0, ctx.actor]
    );
    await insertFirstVersion(conn, {
      table: 'product_category_versions', fk: 'category_id', parentId: ins.insertId,
      fields: ['name', 'description', 'status'],
      data: { name, description: cleanText(body.description), status: 'ACTIVE' },
      effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
    });
    await writeAudit(conn, {
      companyId, entityType: 'CATEGORY', entityId: ins.insertId, action: 'CREATED',
      effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, [{ field: 'code', old: null, new: code }, { field: 'name', old: null, new: name }]);
    await conn.commit();
    return { id: ins.insertId, code, name, parent_id: parentId };
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw httpError(409, `Category code ${code} already exists`);
    throw e;
  } finally {
    conn.release();
  }
}

async function updateCategory(ctx, id, body = {}) {
  ctx.assert('edit');
  const [[cat]] = await pool.query('SELECT * FROM product_categories WHERE id = ?', [Number(id) || 0]);
  if (!cat || !ctx.canSeeCompany(cat.company_id)) throw httpError(404, 'Category not found');
  const effectiveDate = parseDate(body.effective_date ?? body.effective_from, 'effective_date') || today();
  const versions = (await loadVersions(pool, 'product_category_versions', 'category_id', [cat.id])).get(cat.id) || [];
  const latest = versions[versions.length - 1];
  if (!latest) throw httpError(500, 'Category has no versions');
  const data = {
    name: cleanText(body.name) ?? latest.name,
    description: body.description !== undefined ? cleanText(body.description) : latest.description,
    status: (cleanText(body.status) || latest.status || 'ACTIVE').toUpperCase(),
  };
  if (!['ACTIVE', 'INACTIVE'].includes(data.status)) throw httpError(400, 'status must be ACTIVE or INACTIVE');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (body.sort_order !== undefined) {
      await conn.query('UPDATE product_categories SET sort_order = ? WHERE id = ?', [Number(body.sort_order) || 0, cat.id]);
    }
    await updateLatestVersion(conn, {
      table: 'product_category_versions', fk: 'category_id', parentId: cat.id,
      fields: ['name', 'description', 'status'], data, effectiveDate,
      remarks: cleanText(body.reason), actor: ctx.actor,
    });
    await writeAudit(conn, {
      companyId: cat.company_id, entityType: 'CATEGORY', entityId: cat.id, action: 'UPDATED',
      effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, changedFields(data, latest).map((f) => ({ field: f, old: latest[f], new: data[f] })));
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return listCategories(ctx, { company_id: cat.company_id, as_of: effectiveDate });
}

// ---------- tags ----------

async function listTags(ctx, query = {}) {
  ctx.assert('view');
  const companyId = Number(query.company_id);
  if (!companyId) throw httpError(400, 'company_id is required');
  if (!ctx.canSeeCompany(companyId)) throw httpError(404, 'Company not found');
  const [rows] = await pool.query(
    'SELECT * FROM product_tags WHERE company_id = ? ORDER BY name',
    [companyId]
  );
  return rows;
}

async function createTag(ctx, body = {}) {
  ctx.assert('create');
  const companyId = await assertCompanyUsable(ctx, body.company_id).then((c) => c.id);
  const name = cleanText(body.name);
  if (!name) throw httpError(400, 'name is required');
  try {
    const [ins] = await pool.query(
      'INSERT INTO product_tags (company_id, name, color, created_by) VALUES (?, ?, ?, ?)',
      [companyId, name, cleanText(body.color), ctx.actor]
    );
    await writeAudit(pool, {
      companyId, entityType: 'TAG', entityId: ins.insertId, action: 'CREATED',
      actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, [{ field: 'name', old: null, new: name }]);
    const [[row]] = await pool.query('SELECT * FROM product_tags WHERE id = ?', [ins.insertId]);
    return row;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw httpError(409, `Tag "${name}" already exists`);
    throw e;
  }
}

async function deleteTag(ctx, id) {
  ctx.assert('edit');
  const [[tag]] = await pool.query('SELECT * FROM product_tags WHERE id = ?', [Number(id) || 0]);
  if (!tag || !ctx.canSeeCompany(tag.company_id)) throw httpError(404, 'Tag not found');
  await pool.query('DELETE FROM product_tags WHERE id = ?', [tag.id]);
  await writeAudit(pool, {
    companyId: tag.company_id, entityType: 'TAG', entityId: tag.id, action: 'DELETED',
    actor: ctx.actor, role: ctx.role,
  }, [{ field: 'name', old: tag.name, new: null }]);
  return { deleted: true, id: tag.id };
}

async function setProductTags(conn, productId, companyId, tagIds, actor) {
  await conn.query('DELETE FROM product_tag_links WHERE product_id = ?', [productId]);
  if (!tagIds?.length) return;
  const [tags] = await conn.query(
    'SELECT id FROM product_tags WHERE company_id = ? AND id IN (?)',
    [companyId, tagIds]
  );
  if (tags.length !== tagIds.length) throw httpError(400, 'One or more tag_ids are invalid for this company');
  await conn.query(
    'INSERT INTO product_tag_links (product_id, tag_id, created_by) VALUES ?',
    [tags.map((t) => [productId, t.id, actor])]
  );
}

// ---------- products ----------

async function assertUniqueIds(conn, companyId, fields, excludeId = 0) {
  for (const [col, label] of [['sku', 'SKU'], ['product_code', 'Product code'], ['internal_item_code', 'Internal item code'], ['barcode', 'Barcode']]) {
    if (!fields[col]) continue;
    const [dup] = await conn.query(
      `SELECT id, sku FROM products WHERE company_id = ? AND ${col} = ? AND id <> ?`,
      [companyId, fields[col], excludeId]
    );
    if (dup.length) throw httpError(409, `${label} "${fields[col]}" already exists (product #${dup[0].id})`);
  }
}

async function loadProduct(conn, ctx, id) {
  const [[row]] = await conn.query('SELECT * FROM products WHERE id = ?', [Number(id) || 0]);
  if (!row || !ctx.canSeeCompany(row.company_id)) throw httpError(404, 'Product not found');
  return row;
}

async function getProductTags(conn, productId) {
  const [rows] = await conn.query(
    `SELECT t.* FROM product_tags t JOIN product_tag_links l ON l.tag_id = t.id WHERE l.product_id = ? ORDER BY t.name`,
    [productId]
  );
  return rows;
}

async function shapeProduct(product, versions, asOf, { tags = [], variants = [], media = [] } = {}) {
  const { current, upcoming } = resolveVersion(versions, asOf);
  const shown = current || upcoming || versions[versions.length - 1];
  return {
    id: product.id,
    company_id: product.company_id,
    sku: product.sku,
    product_code: product.product_code,
    internal_item_code: product.internal_item_code,
    barcode: product.barcode,
    qr_code: product.qr_code,
    as_of: asOf,
    effective_status: current ? 'EFFECTIVE' : (shown ? 'NOT_YET_EFFECTIVE' : null),
    profile: formatVersion(PRODUCT_VERSION_FIELDS, shown),
    upcoming_change: current && upcoming
      ? { version_id: upcoming.id, effective_from: upcoming.effective_from } : null,
    tags,
    variants,
    media,
    created_by: product.created_by,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };
}

function pickDefined(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function resolveItemType(body, { partial = false } = {}) {
  const raw = cleanText(body.item_type ?? body.itemType ?? body.type)?.toUpperCase();
  const codeTypeHint = cleanText(body.code_type ?? body.gst?.code_type)?.toUpperCase();
  if (raw) {
    if (['SERVICE', 'SERVICES', 'SAC'].includes(raw)) return 'SERVICE';
    if (['PRODUCT', 'GOODS', 'ITEM', 'HSN'].includes(raw)) return 'PRODUCT';
    throw httpError(400, 'item_type must be PRODUCT or SERVICE');
  }
  if (codeTypeHint === 'SAC' || body.sac != null || body.sac_code != null) return 'SERVICE';
  const cls = cleanText(body.classification)?.toUpperCase();
  if (cls === 'SERVICES' || cls === 'SERVICE') return 'SERVICE';
  if (partial) return null;
  return 'PRODUCT';
}

function statusFromFrontend(body) {
  const raw = cleanText(body.status ?? body.operational_status ?? body.operationalStatus ?? body.product_operational_status ?? body.productOperationalStatus)?.toUpperCase();
  if (!raw) return undefined;
  if (['SELLABLE', 'ACTIVE', 'AVAILABLE', 'ACTIVE/SELLABLE', 'ACTIVE / SELLABLE'].includes(raw)) return 'ACTIVE';
  if (['INACTIVE', 'DISABLED'].includes(raw)) return 'INACTIVE';
  if (['DISCONTINUED'].includes(raw)) return 'DISCONTINUED';
  if (['UNDER_DEVELOPMENT', 'DEVELOPMENT'].includes(raw)) return 'UNDER_DEVELOPMENT';
  return raw;
}

const UOM_ALIASES = {
  METERS: 'MTR', METER: 'MTR',
  HOURS: 'HR', HOUR: 'HR',
  PIECES: 'PCS', PIECE: 'PCS',
  UNITS: 'UNIT', UNIT: 'UNIT',
  NUMBERS: 'NOS', NUMBER: 'NOS',
  KILOGRAMS: 'KG', KILOGRAM: 'KG',
  LITERS: 'LTR', LITER: 'LTR',
  BOXES: 'BOX', BOX: 'BOX',
  PACKS: 'PACK', PACK: 'PACK',
  ROLLS: 'ROLL', ROLL: 'ROLL',
};

async function lookupUomId(companyId, value) {
  const str = String(value).trim();
  const code = str.toUpperCase();
  const aliasCode = UOM_ALIASES[code] || code;
  // Match code, alias, exact name, or name without trailing "s" (Meter/Meters)
  const nameExact = code;
  const nameSingular = code.endsWith('S') && code.length > 3 ? code.slice(0, -1) : code;
  const [[row]] = await pool.query(
    `SELECT id FROM units_of_measure
     WHERE (company_id IS NULL OR company_id = ?) AND status = 'ACTIVE'
       AND (
         UPPER(code) IN (?, ?)
         OR UPPER(name) IN (?, ?, ?)
         OR UPPER(REPLACE(name, ' ', '')) IN (?, ?)
       )
     ORDER BY company_id IS NULL ASC, id LIMIT 1`,
    [
      companyId || 0,
      code, aliasCode,
      nameExact, nameSingular, aliasCode,
      code.replace(/\s+/g, ''), aliasCode,
    ]
  );
  return row?.id || null;
}

async function resolveUomId(companyId, value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') {
    if (value.id) return Number(value.id);
    value = value.code || value.name;
  }
  const n = Number(value);
  if (Number.isInteger(n) && n > 0 && String(value).trim() === String(n)) return n;

  let id = await lookupUomId(companyId, value);
  if (!id) {
    // After truncate, system UOMs may be missing — seed then retry
    await uomService.seedSystemUoms();
    id = await lookupUomId(companyId, value);
  }
  if (!id) throw httpError(400, `Unknown UOM "${value}" — use GET /api/products/uoms`);
  return id;
}

/** Frontend often sends "Fans (FANS)" or "House Wires (FR/FRLS/ZHFR)". */
function parseCategoryLabel(raw) {
  const str = String(raw).trim();
  const m = str.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    return {
      raw: str,
      name: m[1].trim(),
      paren: m[2].trim(),
      candidates: [str, m[1].trim(), m[2].trim()].filter(Boolean),
    };
  }
  return { raw: str, name: str, paren: null, candidates: [str] };
}

function slugCategoryCode(label, parentCode = null) {
  const base = String(label).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  const prefix = parentCode ? String(parentCode).toUpperCase().slice(0, 12) : null;
  const code = prefix ? `${prefix}-${base || 'SUB'}` : (base || `CAT${Date.now().toString().slice(-6)}`);
  return code.slice(0, 50);
}

async function findCategoryByLabels(conn, companyId, candidates, parentId = null) {
  const uppers = [...new Set(candidates.map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
  for (const upper of uppers) {
    const params = [companyId, upper, upper, upper];
    let sql = `
      SELECT c.id, c.parent_id, c.code
      FROM product_categories c
      LEFT JOIN product_category_versions v ON v.category_id = c.id
      WHERE c.company_id = ?
        AND (UPPER(c.code) = ? OR UPPER(v.name) = ? OR UPPER(v.name) LIKE CONCAT(?, '%'))
    `;
    if (parentId) {
      sql += ' AND c.parent_id = ?';
      params.push(parentId);
    }
    sql += ' ORDER BY (UPPER(c.code) = ? OR UPPER(v.name) = ?) DESC, v.effective_from DESC, c.id DESC LIMIT 1';
    params.push(upper, upper);
    const [rows] = await conn.query(sql, params);
    if (rows.length) return rows[0];
  }
  return null;
}

function matchDefaultTreeNode(candidates) {
  const uppers = candidates.map((c) => String(c).trim().toUpperCase());
  for (const [i, node] of DEFAULT_CATEGORY_TREE.entries()) {
    if (uppers.some((u) => u === node.code.toUpperCase() || u === node.name.toUpperCase()
      || node.name.toUpperCase().startsWith(u) || u.startsWith(node.name.toUpperCase()))) {
      return { parent: null, node, parentIndex: i, childIndex: null };
    }
    for (const [j, child] of (node.children || []).entries()) {
      if (uppers.some((u) => u === child.code.toUpperCase() || u === child.name.toUpperCase()
        || child.name.toUpperCase().startsWith(u) || u.startsWith(child.name.toUpperCase().split(' (')[0]))) {
        return { parent: node, node: child, parentIndex: i, childIndex: j };
      }
    }
  }
  return null;
}

async function resolveCategoryId(conn, companyId, value, parentId = null, actor = 'system') {
  if (value == null || value === '') return null;
  if (typeof value === 'object') {
    if (value.id) return Number(value.id);
    value = value.code || value.name;
  }
  const n = Number(value);
  if (Number.isInteger(n) && n > 0 && String(value).trim() === String(n)) {
    const [[c]] = await conn.query(
      'SELECT id, parent_id FROM product_categories WHERE id = ? AND company_id = ?',
      [n, companyId]
    );
    if (!c) throw httpError(400, `Category id ${n} not found`);
    return c.id;
  }

  const parsed = parseCategoryLabel(value);
  const candidates = parsed.candidates;

  // 1) Exact / prefix match in DB (prefer under parent, then global)
  let hit = await findCategoryByLabels(conn, companyId, candidates, parentId);
  if (!hit && parentId) hit = await findCategoryByLabels(conn, companyId, candidates, null);
  if (hit) return hit.id;

  // 2) Seed from DEFAULT_CATEGORY_TREE
  const treeHit = matchDefaultTreeNode(candidates);
  if (treeHit) {
    if (!treeHit.parent) {
      return await upsertCategory(conn, companyId, null, treeHit.node, treeHit.parentIndex, today(), actor);
    }
    const pId = parentId || await upsertCategory(conn, companyId, null, treeHit.parent, treeHit.parentIndex, today(), actor);
    return await upsertCategory(conn, companyId, pId, treeHit.node, treeHit.childIndex, today(), actor);
  }

  // 3) Auto-create custom label from frontend (so Save never blocks on missing seed)
  let parentCode = null;
  if (parentId) {
    const [[p]] = await conn.query('SELECT code FROM product_categories WHERE id = ? AND company_id = ?', [parentId, companyId]);
    parentCode = p?.code || null;
  }
  const displayName = parsed.name || parsed.raw;
  const code = slugCategoryCode(parsed.paren && !/[\/]/.test(parsed.paren) ? parsed.paren : displayName, parentCode);
  const createdId = await upsertCategory(
    conn,
    companyId,
    parentId || null,
    { code, name: parsed.raw },
    99,
    today(),
    actor
  );
  return createdId;
}

async function ensureTagIds(conn, companyId, body, actor) {
  const ids = [];
  if (Array.isArray(body.tag_ids)) ids.push(...body.tag_ids.map(Number).filter(Boolean));
  if (Array.isArray(body.tagIds)) ids.push(...body.tagIds.map(Number).filter(Boolean));
  const names = [];
  for (const src of [body.tags, body.tag_names, body.tagNames, body.custom_tags, body.customTags]) {
    if (!Array.isArray(src)) continue;
    for (const t of src) {
      if (t == null) continue;
      if (typeof t === 'number' || (/^\d+$/.test(String(t)))) ids.push(Number(t));
      else if (typeof t === 'object' && t.id) ids.push(Number(t.id));
      else names.push(cleanText(typeof t === 'object' ? t.name : t));
    }
  }
  const uniqueNames = [...new Set(names.filter(Boolean))];
  for (const name of uniqueNames) {
    const [[existing]] = await conn.query(
      'SELECT id FROM product_tags WHERE company_id = ? AND name = ?',
      [companyId, name]
    );
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const [ins] = await conn.query(
      'INSERT INTO product_tags (company_id, name, created_by) VALUES (?, ?, ?)',
      [companyId, name, actor]
    );
    ids.push(ins.insertId);
  }
  return [...new Set(ids.filter(Boolean))];
}

/**
 * Map the 6-step frontend form onto the product API body.
 * Product/Goods → HSN; Service → SAC. Inventory fields ignored for services.
 */
async function normalizeProductPayload(body = {}, { partial = false } = {}) {
  const out = { ...body };
  const itemType = resolveItemType(out);
  out.item_type = itemType;

  if (out.company_id == null) out.company_id = out.companyId;
  if (out.sku == null) out.sku = out.sku_code ?? out.skuCode ?? out.unique_sku ?? out.uniqueSku ?? out.product_sku ?? out.productSku;
  if (out.name == null) out.name = out.product_name ?? out.productName ?? out.item_name ?? out.itemName;
  if (out.barcode == null) out.barcode = out.ean ?? out.ean_13 ?? out.ean13;
  if (out.product_code == null) out.product_code = out.item_code ?? out.itemCode ?? out.productCode;
  if (out.internal_item_code == null) out.internal_item_code = out.internalItemCode;
  if (out.brand == null) out.brand = out.brand_name ?? out.brandName;
  if (out.manufacturer == null) out.manufacturer = out.manufacturer_legal_entity ?? out.manufacturerLegalEntity ?? out.manufacturer_name ?? out.manufacturerName;
  const childType = out.child_type ?? out.childType ?? out.child_specification ?? out.childSpecification ?? out.type_name ?? out.typeName;
  if (out.model == null && childType) out.model = childType;
  if (out.description == null) {
    out.description = out.full_description ?? out.fullDescription ?? out.marketing_description ?? out.marketingDescription ?? out.warehouse_description ?? out.warehouseDescription;
  }

  // Classification: UI “Product Classification” may be category name (e.g. Wires) — do not require FINISHED_GOODS from that field.
  // Real classification: Product → default FINISHED_GOODS; Service → SERVICES.
  const rawClass = cleanText(out.classification ?? out.product_classification ?? out.productClassification);
  if (itemType === 'SERVICE') {
    out.classification = 'SERVICES';
  } else {
    const upperClass = rawClass?.toUpperCase();
    if (upperClass && PRODUCT_CLASSIFICATIONS.includes(upperClass) && upperClass !== 'SERVICES') {
      out.classification = upperClass;
    } else {
      out.classification = 'FINISHED_GOODS';
      if (!out.category_id && !out.category && rawClass) {
        out.category = rawClass;
      }
    }
  }

  // Resolve category & subcategory if company_id is provided
  const companyId = Number(out.company_id) || 0;
  const rawCat = out.category_id ?? out.categoryId ?? out.category ?? out.primary_category_id ?? out.primaryCategoryId ?? out.primary_category ?? out.primaryCategory;
  if (companyId && rawCat != null && rawCat !== '') {
    out.category_id = await resolveCategoryId(pool, companyId, rawCat, null);
  } else if (rawCat != null && rawCat !== '') {
    out.category_id = rawCat;
  }
  const rawSub = out.subcategory_id ?? out.subcategoryId ?? out.subcategory ?? out.sub_category_id ?? out.subCategoryId ?? out.sub_category ?? out.subCategory;
  if (companyId && rawSub != null && rawSub !== '') {
    const parentIdParam = Number.isInteger(Number(out.category_id)) ? Number(out.category_id) : null;
    out.subcategory_id = await resolveCategoryId(pool, companyId, rawSub, parentIdParam);
  } else if (rawSub != null && rawSub !== '') {
    out.subcategory_id = rawSub;
  }

  // Specifications
  const specSummary = out.spec_summary ?? out.specSummary ?? out.specifications_summary ?? out.specificationsSummary ?? out.engineering_specifications ?? out.engineeringSpecifications;
  let specs = (typeof out.specifications === 'object' && out.specifications) ? { ...out.specifications } : {};
  if (specSummary) {
    specs.summary = specs.summary || specSummary;
  }
  if (childType) {
    specs.child_type = specs.child_type || childType;
  }
  if (out.has_family_variants != null || out.hasFamilyVariants != null) {
    specs.has_family_variants = !!(out.has_family_variants ?? out.hasFamilyVariants);
  }
  const internalRemarks = out.internal_remarks ?? out.internalRemarks ?? out.lifecycle_description ?? out.lifecycleDescription ?? out.qc_remarks ?? out.qcRemarks;
  // Dynamic Branch Resolution (maps code, name or id; null for company-wide / all branches)
  const rawBranch = out.branch ?? out.branch_code ?? out.branchCode ?? out.branch_name ?? out.branchName ?? out.branch_id ?? out.branchId;
  if (rawBranch != null && rawBranch !== '') {
    if (typeof rawBranch === 'number' || /^\d+$/.test(String(rawBranch))) {
      out.branch_id = Number(rawBranch);
    } else {
      const cleanBranch = cleanText(rawBranch);
      const lower = cleanBranch?.toLowerCase();
      if (lower === 'all' || lower === 'all branches' || lower === 'company-wide' || lower === 'company_wide') {
        out.branch_id = null;
        out.branch = null;
      } else {
        out.branch = cleanBranch;
        if (companyId) {
          const [[bRow]] = await pool.query(
            `SELECT b.id, b.code, bv.name FROM branches b 
             JOIN branch_versions bv ON bv.branch_id = b.id AND bv.effective_to IS NULL
             WHERE b.company_id = ? AND (b.code = ? OR bv.name = ?) LIMIT 1`,
            [companyId, cleanBranch.toUpperCase(), cleanBranch]
          );
          if (bRow) {
            out.branch_id = bRow.id;
            out.branch_code = bRow.code;
          }
        }
      }
    }
    specs.branch_id = out.branch_id ?? null;
    specs.branch = out.branch ?? null;
  }

  if (Object.keys(specs).length > 0) {
    out.specifications = specs;
  }

  // Technical attributes (attributes JSON)
  const techAttrs = out.attributes ?? out.technical_attributes ?? out.technicalAttributes ?? out.technical;
  if (techAttrs != null) {
    if (typeof techAttrs === 'string') {
      try { out.technical_attributes = JSON.parse(techAttrs); } catch { out.technical_attributes = { raw: techAttrs }; }
    } else {
      out.technical_attributes = techAttrs;
    }
  }

  const mappedStatus = statusFromFrontend(out);
  if (mappedStatus) out.status = mappedStatus;

  const sellableRaw = out.sellable ?? out.allowed_use_sale ?? out.allowedUseSale;
  if (sellableRaw !== undefined) {
    const sellable = parseBool(sellableRaw, 'sellable');
    out.block_sales = sellable ? 0 : 1;
  }
  if (out.block_sales === undefined && out.blockSales !== undefined) {
    out.block_sales = parseBool(out.blockSales, 'blockSales') ? 1 : 0;
  }

  // GST
  const gstIn = (out.gst && typeof out.gst === 'object') ? { ...out.gst } : {};
  const hsn = out.hsn ?? out.hsn_code ?? out.hsnCode ?? out.hsn_sac ?? out.hsnSac ?? gstIn.hsn_sac ?? gstIn.hsn;
  const sac = out.sac ?? out.sac_code ?? out.sacCode ?? gstIn.sac;
  const rawGstRate = out.gst_rate ?? out.gstRate ?? out.gst_tax_rate ?? out.gstTaxRate ?? gstIn.gst_rate;
  const gstRate = gstPricing.parseGstRate(rawGstRate);
  const taxType = (cleanText(out.tax_type ?? out.taxType ?? gstIn.tax_type) || 'TAXABLE').toUpperCase();

  // Default 18% when HSN/SAC is sent without rate (6-step form step 1 often has HSN only)
  const resolvedRate = (gstRate != null && !Number.isNaN(gstRate) && GST_RATES.includes(gstRate))
    ? gstRate
    : 18;

  if (itemType === 'SERVICE') {
    if (sac || hsn || (gstRate != null && !Number.isNaN(gstRate)) || gstIn.hsn_sac) {
      out.gst = {
        ...gstIn,
        code_type: 'SAC',
        hsn_sac: sac ?? hsn ?? gstIn.hsn_sac,
        gst_rate: resolvedRate,
        ...(taxType ? { tax_type: taxType } : {}),
      };
    }
  } else if (hsn || (gstRate != null && !Number.isNaN(gstRate)) || gstIn.hsn_sac) {
    out.gst = {
      ...gstIn,
      code_type: 'HSN',
      hsn_sac: hsn ?? gstIn.hsn_sac,
      gst_rate: resolvedRate,
      ...(taxType ? { tax_type: taxType } : {}),
    };
  }

  if (!partial && itemType === 'SERVICE') {
    if (!out.gst?.hsn_sac) {
      throw httpError(400, 'sac is required for SERVICE items');
    }
    gstPricing.validateHsnSac('SAC', out.gst.hsn_sac);
  }
  if (!partial && itemType === 'PRODUCT') {
    if (out.gst && !out.gst.hsn_sac) {
      throw httpError(400, 'hsn_sac (HSN) is required when gst is sent');
    }
    if (out.gst?.hsn_sac) {
      gstPricing.validateHsnSac('HSN', out.gst.hsn_sac);
    }
  }

  // Prices
  const pricesIn = (out.prices && typeof out.prices === 'object') ? { ...out.prices } : {};
  const purchase = out.purchase_cost ?? out.purchaseCost ?? out.purchase_price ?? out.purchasePrice ?? pricesIn.purchase_price;
  const mrp = out.mrp ?? out.mrp_price ?? out.mrpPrice ?? out.maximum_retail_price ?? out.maximumRetailPrice ?? pricesIn.retail_price;
  const sale = out.sale_price ?? out.salePrice ?? out.selling_price ?? out.sellingPrice ?? pricesIn.wholesale_price ?? pricesIn.sale_price;
  const maxDiscPct = out.max_discount_percent ?? out.maxDiscountPercent ?? out.max_discount ?? out.maxDiscount ?? pricesIn.discount_percent;
  const maxPriceDisc = out.max_price_discount ?? out.maxPriceDiscount ?? pricesIn.max_price_discount;
  const stdCost = out.standard_cost ?? out.standardCost ?? pricesIn.standard_cost ?? purchase;
  if ([purchase, mrp, sale, maxDiscPct, maxPriceDisc, stdCost].some((v) => v != null && v !== '')) {
    out.prices = {
      ...pricesIn,
      ...(purchase != null && purchase !== '' ? { purchase_price: purchase } : {}),
      ...(mrp != null && mrp !== '' ? { retail_price: mrp } : {}),
      ...(sale != null && sale !== '' ? { wholesale_price: sale } : {}),
      ...(stdCost != null && stdCost !== '' ? { standard_cost: stdCost } : {}),
      ...(maxDiscPct != null && maxDiscPct !== '' ? { discount_percent: maxDiscPct } : {}),
      ...(maxPriceDisc != null && maxPriceDisc !== '' ? { max_price_discount: maxPriceDisc } : {}),
    };
  }

  // UOM: Product = stock/purchase/sales; Service = billing unit only (sales_uom), no stock.
  const uomRaw = out.stock_uom_id ?? out.stockUomId ?? out.stock_uom ?? out.stockUom
    ?? out.uom_id ?? out.uomId ?? out.base_uom_id ?? out.baseUomId
    ?? out.base_stock_uom ?? out.baseStockUom ?? out.uom ?? out.unit ?? out.billing_uom ?? out.billingUom;
  if (uomRaw != null && uomRaw !== '') {
    const uomId = await resolveUomId(companyId, uomRaw);
    if (itemType === 'SERVICE') {
      out.sales_uom_id = out.sales_uom_id ?? uomId;
      // Services are not inventoried — ignore stock/opening/reorder from the 6-step form.
      delete out.stock_uom_id;
      delete out.purchase_uom_id;
      delete out.opening_qty;
      delete out.opening_stock;
      delete out.initial_opening_stock;
      delete out.reorder_level;
      delete out.min_stock;
      delete out.warehouse_id;
    } else {
      out.stock_uom_id = uomId;
      if (out.purchase_uom_id == null) out.purchase_uom_id = uomId;
      if (out.sales_uom_id == null) out.sales_uom_id = uomId;
    }
  } else if (itemType === 'SERVICE') {
    delete out.opening_qty;
    delete out.opening_stock;
    delete out.initial_opening_stock;
    delete out.reorder_level;
    delete out.min_stock;
    delete out.warehouse_id;
    delete out.stock_uom_id;
    delete out.purchase_uom_id;
  }

  if (itemType !== 'SERVICE') {
    const openQty = out.opening_qty ?? out.openingQty ?? out.opening_stock ?? out.openingStock
      ?? out.initial_opening_stock ?? out.initialOpeningStock ?? out.opening_stock_qty ?? out.openingStockQty;
    if (openQty != null && openQty !== '') out.opening_qty = Number(openQty);
    const reorder = out.reorder_level ?? out.reorderLevel ?? out.minimum_low_stock ?? out.minimumLowStock
      ?? out.min_stock ?? out.minStock ?? out.reorder_qty ?? out.reorderQty;
    if (reorder != null && reorder !== '') out.reorder_level = Number(reorder);
  }

  return out;
}

async function firstWarehouseId(companyId, ctx = null, effectiveDate = null) {
  const [[row]] = await pool.query(
    'SELECT id FROM warehouses WHERE company_id = ? ORDER BY id LIMIT 1',
    [companyId]
  );
  if (row?.id) return row.id;
  if (!ctx) return null;
  // Auto-create Main Store so 6-step product create with opening_qty works on a fresh company
  const created = await invService.createWarehouse(ctx, {
    company_id: companyId,
    code: 'MAIN',
    name: 'Main Store',
    warehouse_type: 'STORE',
    effective_date: effectiveDate || today(),
    reason: 'Auto-created for opening stock',
  });
  return created?.id || null;
}

async function applyNestedProductExtras(ctx, productId, body, effectiveDate) {
  if (body.gst && body.gst.hsn_sac) {
    await gstPricing.setGst(ctx, productId, { ...body.gst, effective_date: effectiveDate, reason: body.reason });
  }
  if (body.prices) {
    await gstPricing.setPrices(ctx, productId, { ...body.prices, effective_date: effectiveDate, reason: body.reason });
  }
  if (Array.isArray(body.conversions)) {
    for (const c of body.conversions) {
      await uomService.upsertConversion(ctx, productId, { ...c, effective_date: effectiveDate });
    }
  }
  if (body.item_type !== 'SERVICE' && body.reorder_level != null) {
    await invService.setReorder(ctx, productId, {
      reorder_level: body.reorder_level,
      min_stock: body.min_stock ?? body.reorder_level,
      warehouse_id: body.warehouse_id,
      effective_date: effectiveDate,
    });
  }
  if (body.item_type !== 'SERVICE' && body.opening_qty != null && Number(body.opening_qty) > 0) {
    const productForWh = await loadProduct(pool, ctx, productId);
    let warehouseId = body.warehouse_id
      ? Number(body.warehouse_id)
      : await firstWarehouseId(productForWh.company_id, ctx, effectiveDate);
    if (!warehouseId) {
      throw httpError(400, 'warehouse_id is required for opening stock (create a warehouse first)');
    }
    const product = await loadProduct(pool, ctx, productId);
    const [[ver]] = await pool.query(
      'SELECT stock_uom_id FROM product_versions WHERE product_id = ? ORDER BY effective_from DESC LIMIT 1',
      [product.id]
    );
    const uomId = body.uom_id || body.stock_uom_id || ver?.stock_uom_id;
    if (!uomId) throw httpError(400, 'stock_uom_id is required when opening_qty is sent');
    await invService.openingStock(ctx, {
      product_id: productId,
      warehouse_id: warehouseId,
      qty: body.opening_qty,
      uom_id: uomId,
      unit_cost: body.opening_unit_cost ?? body.prices?.purchase_price ?? body.purchase_cost,
      txn_date: effectiveDate,
      reason: body.reason || 'Opening from item master',
    });
  }
}

async function createProduct(ctx, rawBody = {}) {
  ctx.assert('create');
  const body = await normalizeProductPayload(rawBody, { partial: false });
  const company = await assertCompanyUsable(ctx, body.company_id);
  const sku = cleanText(body.sku)?.toUpperCase();
  const productCode = cleanText(body.product_code)?.toUpperCase() || sku;
  if (!sku) throw httpError(400, 'sku is required');
  const ids = {
    sku,
    product_code: productCode,
    internal_item_code: cleanText(body.internal_item_code)?.toUpperCase() || null,
    barcode: cleanText(body.barcode) || null,
    qr_code: cleanText(body.qr_code) || null,
  };
  if (body.category_id != null && !Number.isInteger(Number(body.category_id))) {
    body.category_id = await resolveCategoryId(pool, company.id, body.category_id, null, ctx.actor);
  }
  if (body.subcategory_id != null && !Number.isInteger(Number(body.subcategory_id))) {
    const parentId = Number.isInteger(Number(body.category_id)) ? Number(body.category_id) : null;
    body.subcategory_id = await resolveCategoryId(pool, company.id, body.subcategory_id, parentId, ctx.actor);
  }
  const profile = readVersionFields(PRODUCT_VERSION_FIELDS, body);
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();

  let productId;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await assertUniqueIds(conn, company.id, ids);
    if (profile.category_id) {
      const [[c]] = await conn.query('SELECT id FROM product_categories WHERE id = ? AND company_id = ?', [profile.category_id, company.id]);
      if (!c) throw httpError(400, 'category_id not found');
    }
    if (profile.subcategory_id) {
      const [[c]] = await conn.query('SELECT id, parent_id FROM product_categories WHERE id = ? AND company_id = ?', [profile.subcategory_id, company.id]);
      if (!c) throw httpError(400, 'subcategory_id not found');
      if (profile.category_id && c.parent_id && c.parent_id !== profile.category_id) {
        throw httpError(400, 'subcategory_id does not belong to category_id');
      }
    }
    const [ins] = await conn.query(
      `INSERT INTO products (company_id, sku, product_code, internal_item_code, barcode, qr_code, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [company.id, ids.sku, ids.product_code, ids.internal_item_code, ids.barcode, ids.qr_code, ctx.actor]
    );
    productId = ins.insertId;
    await insertFirstVersion(conn, {
      table: 'product_versions', fk: 'product_id', parentId: productId,
      fields: VERSION_FIELDS, data: dbRow(VERSION_FIELDS, profile),
      effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
    });
    const tagIds = await ensureTagIds(conn, company.id, body, ctx.actor);
    await setProductTags(conn, productId, company.id, tagIds, ctx.actor);
    await writeAudit(conn, {
      companyId: company.id, productId, entityType: 'PRODUCT', entityId: productId,
      action: 'CREATED', effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, [
      { field: 'sku', old: null, new: ids.sku },
      { field: 'name', old: null, new: profile.name },
      { field: 'classification', old: null, new: profile.classification },
    ]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  await applyNestedProductExtras(ctx, productId, body, effectiveDate);
  return getProduct(ctx, productId, { as_of: effectiveDate });
}

async function updateProduct(ctx, id, rawBody = {}) {
  ctx.assert('edit');
  const body = await normalizeProductPayload(rawBody, { partial: true });
  const product = await loadProduct(pool, ctx, id);
  const effectiveDate = parseDate(body.effective_date ?? body.effective_from, 'effective_date') || today();
  const versions = (await loadVersions(pool, 'product_versions', 'product_id', [product.id])).get(product.id) || [];
  const latest = versions[versions.length - 1];
  if (!latest) throw httpError(500, 'Product has no versions');

  const idChanges = {};
  for (const f of ['sku', 'product_code', 'internal_item_code', 'barcode', 'qr_code']) {
    if (body[f] !== undefined) {
      idChanges[f] = f === 'qr_code' ? cleanText(body[f]) : (cleanText(body[f])?.toUpperCase() || null);
    }
  }
  const profileChanges = readVersionFields(PRODUCT_VERSION_FIELDS, body, { partial: true });
  const baseProfile = Object.fromEntries(VERSION_FIELDS.map((f) => [f, latest[f]]));
  if (typeof baseProfile.specifications === 'string') baseProfile.specifications = JSON.parse(baseProfile.specifications || 'null');
  if (typeof baseProfile.technical_attributes === 'string') baseProfile.technical_attributes = JSON.parse(baseProfile.technical_attributes || 'null');
  const merged = { ...baseProfile, ...profileChanges };
  if (merged.classification && !PRODUCT_CLASSIFICATIONS.includes(merged.classification)) {
    throw httpError(400, `classification must be one of ${PRODUCT_CLASSIFICATIONS.join(', ')}`);
  }
  if (merged.status && !PRODUCT_STATUSES.includes(merged.status)) {
    throw httpError(400, `status must be one of ${PRODUCT_STATUSES.join(', ')}`);
  }

  const fieldChanged = changedFields(
    Object.fromEntries(Object.keys(profileChanges).map((k) => [k, typeof merged[k] === 'object' ? JSON.stringify(merged[k]) : merged[k]])),
    Object.fromEntries(Object.keys(profileChanges).map((k) => [k, typeof latest[k] === 'object' ? JSON.stringify(latest[k]) : latest[k]]))
  );
  const dateChanged = effectiveDate !== String(latest.effective_from).slice(0, 10);
  const idChanged = Object.keys(idChanges).some((k) => String(idChanges[k] ?? '') !== String(product[k] ?? ''));
  const tagsChanged = body.tag_ids !== undefined || body.tags !== undefined || body.tag_names !== undefined
    || body.custom_tags !== undefined;
  const extrasChanged = !!(body.gst || body.prices || body.opening_qty || body.reorder_level
    || (Array.isArray(body.conversions) && body.conversions.length));

  if (!fieldChanged.length && !dateChanged && !idChanged && !tagsChanged && body.remarks === undefined && !extrasChanged) {
    throw httpError(400, 'No changes to save');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (idChanged) {
      await assertUniqueIds(conn, product.company_id, { ...product, ...idChanges }, product.id);
      const sets = Object.keys(idChanges).map((k) => `${k} = ?`);
      await conn.query(`UPDATE products SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, [
        ...Object.values(idChanges), product.id,
      ]);
    }
    if (fieldChanged.length || dateChanged || body.remarks !== undefined) {
      await updateLatestVersion(conn, {
        table: 'product_versions', fk: 'product_id', parentId: product.id,
        fields: VERSION_FIELDS, data: dbRow(VERSION_FIELDS, merged),
        effectiveDate, remarks: cleanText(body.reason) ?? cleanText(body.remarks), actor: ctx.actor,
      });
    }
    if (tagsChanged) {
      const tagIds = await ensureTagIds(conn, product.company_id, body, ctx.actor);
      await setProductTags(conn, product.id, product.company_id, tagIds, ctx.actor);
    }
    await conn.query('UPDATE products SET updated_at = NOW() WHERE id = ?', [product.id]);
    const changes = [
      ...Object.keys(idChanges).filter((k) => String(idChanges[k] ?? '') !== String(product[k] ?? ''))
        .map((k) => ({ field: k, old: product[k], new: idChanges[k] })),
      ...fieldChanged.map((f) => ({ field: f, old: latest[f], new: merged[f] })),
      ...(dateChanged ? [{ field: 'effective_from', old: latest.effective_from, new: effectiveDate }] : []),
    ];
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'PRODUCT', entityId: product.id,
      action: 'UPDATED', effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, changes.length ? changes : [{ field: 'product', old: null, new: 'updated' }]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getProduct(ctx, product.id);
}

/**
 * Delete product.
 * - Default: soft delete → status INACTIVE, block purchase/sales (effective-dated).
 * - hard=true: physical remove when no stock qty and no inventory transactions.
 */
async function deleteProduct(ctx, id, body = {}, query = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, id);
  const hard = isTruthy(body.hard ?? body.force ?? query.hard ?? query.force);
  const reason = cleanText(body.reason) || cleanText(query.reason) || 'Deleted from product master';
  const effectiveDate = parseDate(body.effective_date ?? body.effective_from ?? query.effective_date, 'effective_date') || today();

  if (hard) {
    const [[{ txns }]] = await pool.query(
      'SELECT COUNT(*) AS txns FROM inventory_transactions WHERE product_id = ?',
      [product.id]
    );
    const [[{ stockQty }]] = await pool.query(
      'SELECT COALESCE(SUM(ABS(qty)), 0) AS stockQty FROM inventory_stock WHERE product_id = ?',
      [product.id]
    );
    const [[{ bomRefs }]] = await pool.query(
      `SELECT COUNT(*) AS bomRefs FROM bom_components bc
       JOIN bills_of_materials b ON b.id = bc.bom_id
       WHERE bc.component_product_id = ? OR b.product_id = ?`,
      [product.id, product.id]
    ).catch(() => [[{ bomRefs: 0 }]]);
    if (Number(txns) > 0 || Number(stockQty) > 0 || Number(bomRefs) > 0) {
      throw httpError(409, 'Cannot hard-delete: product has stock, inventory history, or BOM links — use soft delete (omit hard=true)');
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Child tables that reference product_id
      const childDeletes = [
        'product_attribute_values', 'product_vendor_mappings', 'product_price_versions',
        'product_gst_versions', 'product_unit_conversions', 'product_media',
        'product_tag_links', 'product_reorder_settings', 'product_warranty_records',
        'inventory_stock', 'inventory_batches', 'inventory_serial_numbers',
      ];
      for (const t of childDeletes) {
        await conn.query(`DELETE FROM ${t} WHERE product_id = ?`, [product.id]).catch(() => {});
      }
      const [variants] = await conn.query('SELECT id FROM product_variants WHERE product_id = ?', [product.id]);
      if (variants.length) {
        const ids = variants.map((v) => v.id);
        await conn.query('DELETE FROM product_variant_versions WHERE variant_id IN (?)', [ids]);
        await conn.query('DELETE FROM product_variants WHERE product_id = ?', [product.id]);
      }
      await conn.query('DELETE FROM product_versions WHERE product_id = ?', [product.id]);
      await writeAudit(conn, {
        companyId: product.company_id, productId: product.id, entityType: 'PRODUCT', entityId: product.id,
        action: 'DELETED', effectiveDate, actor: ctx.actor, role: ctx.role, reason,
      }, [{ field: 'sku', old: product.sku, new: null }]);
      await conn.query('DELETE FROM products WHERE id = ?', [product.id]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    return { deleted: true, hard: true, id: product.id, sku: product.sku };
  }

  // Soft delete
  const versions = (await loadVersions(pool, 'product_versions', 'product_id', [product.id])).get(product.id) || [];
  const latest = versions[versions.length - 1];
  if (!latest) throw httpError(500, 'Product has no versions');
  if (String(latest.status).toUpperCase() === 'INACTIVE') {
    return { deleted: true, hard: false, id: product.id, sku: product.sku, status: 'INACTIVE', already: true };
  }

  const base = Object.fromEntries(VERSION_FIELDS.map((f) => [f, latest[f]]));
  if (typeof base.specifications === 'string') base.specifications = JSON.parse(base.specifications || 'null');
  if (typeof base.technical_attributes === 'string') base.technical_attributes = JSON.parse(base.technical_attributes || 'null');
  const merged = {
    ...base,
    status: 'INACTIVE',
    block_purchase: 1,
    block_sales: 1,
  };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await updateLatestVersion(conn, {
      table: 'product_versions', fk: 'product_id', parentId: product.id,
      fields: VERSION_FIELDS, data: dbRow(VERSION_FIELDS, merged),
      effectiveDate, remarks: reason, actor: ctx.actor,
    });
    await conn.query('UPDATE products SET updated_at = NOW() WHERE id = ?', [product.id]);
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'PRODUCT', entityId: product.id,
      action: 'DELETED', effectiveDate, actor: ctx.actor, role: ctx.role, reason,
    }, [
      { field: 'status', old: latest.status, new: 'INACTIVE' },
      { field: 'block_purchase', old: latest.block_purchase, new: 1 },
      { field: 'block_sales', old: latest.block_sales, new: 1 },
    ]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return {
    deleted: true,
    hard: false,
    id: product.id,
    sku: product.sku,
    status: 'INACTIVE',
    message: 'Product soft-deleted (INACTIVE). Pass hard=true to permanently remove if unused.',
  };
}

async function getProduct(ctx, id, query = {}) {
  ctx.assert('view');
  const product = await loadProduct(pool, ctx, id);
  const versions = (await loadVersions(pool, 'product_versions', 'product_id', [product.id])).get(product.id) || [];
  const asOf = parseDate(query.as_of, 'as_of')
    || (versions.length ? String(versions[versions.length - 1].effective_from).slice(0, 10) : today());
  const tags = await getProductTags(pool, product.id);
  const variants = await listVariantsInternal(pool, product.id, asOf);
  const [media] = await pool.query(
    'SELECT id, product_id, variant_id, media_type, title, file_path, original_name, mime_type, file_size, sort_order, is_primary, created_at FROM product_media WHERE product_id = ? ORDER BY is_primary DESC, sort_order, id',
    [product.id]
  );
  const gst = await gstPricing.getGst(ctx, product.id, { as_of: asOf }).catch(() => null);
  const prices = await gstPricing.getPrices(ctx, product.id, { as_of: asOf }).catch(() => null);
  const conversions = await uomService.listConversions(ctx, product.id).catch(() => []);
  const attributes = await attrService.getProductAttributes(ctx, product.id, { as_of: asOf }).catch(() => []);
  const stock = await invService.getStock(ctx, { product_id: product.id }).catch(() => []);
  return {
    ...await shapeProduct(product, versions, asOf, { tags, variants, media }),
    gst: gst?.current || null,
    prices: prices?.current || null,
    conversions,
    attributes,
    stock,
    versions: versions.map((v) => formatVersion(PRODUCT_VERSION_FIELDS, v)).reverse(),
  };
}

async function listProducts(ctx, query = {}) {
  ctx.assert('view');
  const scope = ctx.companyFilter('p.company_id');
  const asOfExplicit = parseDate(query.as_of, 'as_of');
  const where = [scope.sql];
  const params = [...scope.params];
  const add = (sql, ...vals) => { where.push(sql); params.push(...vals); };
  if (cleanText(query.company_id)) add('p.company_id = ?', Number(query.company_id));
  if (cleanText(query.classification)) add('v.classification = ?', String(query.classification).toUpperCase());
  if (cleanText(query.item_type)) add('v.item_type = ?', String(query.item_type).toUpperCase() === 'SERVICE' ? 'SERVICE' : 'PRODUCT');
  if (cleanText(query.status)) add('v.status = ?', String(query.status).toUpperCase());
  if (cleanText(query.category_id)) add('v.category_id = ?', Number(query.category_id));
  if (cleanText(query.brand)) add('v.brand LIKE ?', `%${query.brand}%`);
  if (isTruthy(query.block_purchase)) add('v.block_purchase = 1');
  if (isTruthy(query.block_sales)) add('v.block_sales = 1');
  if (cleanText(query.tag_id)) {
    add('EXISTS (SELECT 1 FROM product_tag_links tl WHERE tl.product_id = p.id AND tl.tag_id = ?)', Number(query.tag_id));
  }
  if (cleanText(query.search)) {
    const like = `%${query.search}%`;
    add('(p.sku LIKE ? OR p.product_code LIKE ? OR p.barcode LIKE ? OR v.name LIKE ? OR v.model_number LIKE ?)', like, like, like, like, like);
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  // Default: latest version (matches company / product detail form edit). Optional as_of = point-in-time.
  const versionPick = asOfExplicit
    ? `v.effective_from = (
        SELECT MAX(x.effective_from) FROM product_versions x
        WHERE x.product_id = p.id AND x.effective_from <= ?
      )`
    : `v.effective_from = (
        SELECT MAX(x.effective_from) FROM product_versions x WHERE x.product_id = p.id
      )`;
  const versionParams = asOfExplicit ? [asOfExplicit] : [];
  const fromSql = `
    FROM products p
    JOIN product_versions v ON v.product_id = p.id AND ${versionPick}
    WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${fromSql}`, [...versionParams, ...params]);
  const [rows] = await pool.query(
    `SELECT p.*, v.name, v.classification, v.brand, v.status, v.block_purchase, v.block_sales,
            v.category_id, v.subcategory_id, v.model_number, v.effective_from, v.effective_to
     ${fromSql}
     ORDER BY v.name, p.sku
     LIMIT ? OFFSET ?`,
    [...versionParams, ...params, limit, (page - 1) * limit]
  );

  const productIds = rows.map((r) => r.id);
  let tagMap = new Map();
  if (productIds.length) {
    const [tagRows] = await pool.query(
      `SELECT l.product_id, t.id, t.name, t.color FROM product_tag_links l
       JOIN product_tags t ON t.id = l.tag_id WHERE l.product_id IN (?)`,
      [productIds]
    );
    for (const t of tagRows) {
      if (!tagMap.has(t.product_id)) tagMap.set(t.product_id, []);
      tagMap.get(t.product_id).push({ id: t.id, name: t.name, color: t.color });
    }
  }

  return {
    as_of: asOfExplicit || 'latest',
    data: rows.map((r) => ({
      id: r.id, company_id: r.company_id, sku: r.sku, product_code: r.product_code,
      internal_item_code: r.internal_item_code, barcode: r.barcode, qr_code: r.qr_code,
      name: r.name, classification: r.classification, brand: r.brand, model_number: r.model_number,
      category_id: r.category_id, subcategory_id: r.subcategory_id,
      status: r.status, block_purchase: !!r.block_purchase, block_sales: !!r.block_sales,
      effective_from: r.effective_from, effective_to: r.effective_to,
      tags: tagMap.get(r.id) || [],
    })),
    page, limit, total: Number(total),
  };
}

// ---------- variants ----------

async function listVariantsInternal(conn, productId, asOf) {
  const [rows] = await conn.query('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', [productId]);
  if (!rows.length) return [];
  const versions = await loadVersions(conn, 'product_variant_versions', 'variant_id', rows.map((r) => r.id));
  return rows.map((r) => {
    const list = versions.get(r.id) || [];
    const { current, upcoming } = resolveVersion(list, asOf);
    const shown = current || upcoming || list[list.length - 1];
    return {
      id: r.id, product_id: r.product_id, variant_sku: r.variant_sku, variant_code: r.variant_code,
      profile: formatVersion(VARIANT_VERSION_FIELDS, shown),
    };
  });
}

async function createVariant(ctx, productId, body = {}) {
  ctx.assert('create');
  const product = await loadProduct(pool, ctx, productId);
  const variantSku = cleanText(body.variant_sku)?.toUpperCase();
  if (!variantSku) throw httpError(400, 'variant_sku is required');
  const profile = readVersionFields(VARIANT_VERSION_FIELDS, body);
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      'INSERT INTO product_variants (product_id, variant_sku, variant_code, created_by) VALUES (?, ?, ?, ?)',
      [product.id, variantSku, cleanText(body.variant_code)?.toUpperCase() || null, ctx.actor]
    );
    await insertFirstVersion(conn, {
      table: 'product_variant_versions', fk: 'variant_id', parentId: ins.insertId,
      fields: VARIANT_FIELDS, data: dbRow(VARIANT_FIELDS, profile),
      effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
    });
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'VARIANT', entityId: ins.insertId,
      action: 'CREATED', effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, [{ field: 'variant_sku', old: null, new: variantSku }]);
    await conn.commit();
    return getProduct(ctx, product.id, { as_of: effectiveDate });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw httpError(409, `Variant SKU ${variantSku} already exists on this product`);
    throw e;
  } finally {
    conn.release();
  }
}

async function updateVariant(ctx, productId, variantId, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  const [[variant]] = await pool.query(
    'SELECT * FROM product_variants WHERE id = ? AND product_id = ?',
    [Number(variantId) || 0, product.id]
  );
  if (!variant) throw httpError(404, 'Variant not found');
  const effectiveDate = parseDate(body.effective_date ?? body.effective_from, 'effective_date') || today();
  const versions = (await loadVersions(pool, 'product_variant_versions', 'variant_id', [variant.id])).get(variant.id) || [];
  const latest = versions[versions.length - 1];
  if (!latest) throw httpError(500, 'Variant has no versions');
  const changes = readVersionFields(VARIANT_VERSION_FIELDS, body, { partial: true });
  const base = Object.fromEntries(VARIANT_FIELDS.map((f) => [f, latest[f]]));
  if (typeof base.specifications === 'string') base.specifications = JSON.parse(base.specifications || 'null');
  const merged = { ...base, ...changes };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (body.variant_code !== undefined) {
      await conn.query('UPDATE product_variants SET variant_code = ? WHERE id = ?', [
        cleanText(body.variant_code)?.toUpperCase() || null, variant.id,
      ]);
    }
    await updateLatestVersion(conn, {
      table: 'product_variant_versions', fk: 'variant_id', parentId: variant.id,
      fields: VARIANT_FIELDS, data: dbRow(VARIANT_FIELDS, merged),
      effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
    });
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'VARIANT', entityId: variant.id,
      action: 'UPDATED', effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    });
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getProduct(ctx, product.id);
}

// ---------- media ----------

async function addMedia(ctx, productId, body = {}, file = null) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  if (!file?.file_path) throw httpError(400, 'file is required');
  const mediaType = (cleanText(body.media_type) || 'IMAGE').toUpperCase();
  if (!MEDIA_TYPES.includes(mediaType)) throw httpError(400, `media_type must be one of ${MEDIA_TYPES.join(', ')}`);
  let variantId = body.variant_id ? Number(body.variant_id) : null;
  if (variantId) {
    const [[v]] = await pool.query('SELECT id FROM product_variants WHERE id = ? AND product_id = ?', [variantId, product.id]);
    if (!v) throw httpError(400, 'variant_id does not belong to this product');
  }
  const isPrimary = mediaType === 'IMAGE' && isTruthy(body.is_primary);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (isPrimary) {
      await conn.query('UPDATE product_media SET is_primary = 0 WHERE product_id = ? AND media_type = ?', [product.id, 'IMAGE']);
    }
    const [ins] = await conn.query(
      `INSERT INTO product_media
       (product_id, variant_id, media_type, title, file_path, original_name, mime_type, file_size, sort_order, is_primary, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        product.id, variantId, mediaType, cleanText(body.title), file.file_path, file.original_name,
        file.mime_type, file.file_size, Number(body.sort_order) || 0, isPrimary ? 1 : 0, ctx.actor,
      ]
    );
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'MEDIA', entityId: ins.insertId,
      action: 'UPLOADED', actor: ctx.actor, role: ctx.role,
    }, [{ field: 'media_type', old: null, new: mediaType }, { field: 'file', old: null, new: file.original_name }]);
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM product_media WHERE id = ?', [ins.insertId]);
    return row;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function deleteMedia(ctx, productId, mediaId) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  const [[media]] = await pool.query(
    'SELECT * FROM product_media WHERE id = ? AND product_id = ?',
    [Number(mediaId) || 0, product.id]
  );
  if (!media) throw httpError(404, 'Media not found');
  await pool.query('DELETE FROM product_media WHERE id = ?', [media.id]);
  const full = path.join(__dirname, '..', '..', '..', media.file_path);
  fs.promises.unlink(full).catch(() => {});
  await writeAudit(pool, {
    companyId: product.company_id, productId: product.id, entityType: 'MEDIA', entityId: media.id,
    action: 'DELETED', actor: ctx.actor, role: ctx.role,
  }, [{ field: 'file', old: media.original_name, new: null }]);
  return { deleted: true, id: media.id };
}

async function getMediaFile(ctx, productId, mediaId) {
  ctx.assert('view');
  const product = await loadProduct(pool, ctx, productId);
  const [[media]] = await pool.query(
    'SELECT * FROM product_media WHERE id = ? AND product_id = ?',
    [Number(mediaId) || 0, product.id]
  );
  if (!media) throw httpError(404, 'Media not found');
  const full = path.join(__dirname, '..', '..', '..', media.file_path);
  if (!fs.existsSync(full)) throw httpError(404, 'File missing on disk');
  return { media, fullPath: full };
}

// ---------- audit / meta ----------

async function auditLogs(ctx, query = {}, productId = null) {
  ctx.assert('audit');
  const scope = ctx.companyFilter('a.company_id');
  const where = [scope.sql];
  const params = [...scope.params];
  if (productId) { where.push('a.product_id = ?'); params.push(Number(productId)); }
  if (cleanText(query.company_id)) { where.push('a.company_id = ?'); params.push(Number(query.company_id)); }
  if (cleanText(query.action)) { where.push('a.action = ?'); params.push(String(query.action).toUpperCase()); }
  if (cleanText(query.entity_type)) { where.push('a.entity_type = ?'); params.push(String(query.entity_type).toUpperCase()); }
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${AUDIT} a WHERE ${where.join(' AND ')}`, params);
  const [rows] = await pool.query(
    `SELECT * FROM ${AUDIT} a WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]
  );
  return { data: rows, page, limit, total: Number(total) };
}

async function meta(ctx) {
  await uomService.seedSystemUoms().catch(() => {});
  return {
    item_types: ITEM_TYPES,
    item_type_tax: {
      PRODUCT: { code_type: 'HSN', hsn_pattern: '4, 6 or 8 digits', inventory: true },
      SERVICE: { code_type: 'SAC', sac_pattern: '6 digits', inventory: false },
    },
    form_steps: [
      '1_item_details', '2_price_details', '3_classification', '4_inventory_variants',
      '5_technical_media', '6_controls_status',
    ],
    classifications: PRODUCT_CLASSIFICATIONS,
    statuses: PRODUCT_STATUSES,
    media_types: MEDIA_TYPES,
    uom_categories: UOM_CATEGORIES,
    predefined_uoms: PREDEFINED_UOMS,
    gst_rates: GST_RATES,
    tax_types: TAX_TYPES,
    hsn_sac_types: HSN_SAC_TYPES,
    stock_statuses: STOCK_STATUSES,
    stock_txn_types: STOCK_TXN_TYPES,
    valuation_methods: VALUATION_METHODS,
    tracking_types: TRACKING_TYPES,
    price_types: PRICE_TYPES,
    attribute_types: ATTRIBUTE_TYPES,
    // suggested_tags / default_category_tree intentionally omitted — UI must use DB categories only
    version_fields: Object.keys(PRODUCT_VERSION_FIELDS),
    variant_fields: Object.keys(VARIANT_VERSION_FIELDS),
    your_permissions: ctx.permissions,
    sections: ['A_MASTER', 'B_UOM', 'C_GST', 'D_INVENTORY', 'E_PRICING', 'F_TRACKING', 'G_BOM', 'H_ATTRIBUTES', 'I_HISTORY', 'J_TABLES', 'K_RULES'],
  };
}

module.exports = {
  moduleContext,
  meta,
  seedDefaultCategories,
  listCategories,
  createCategory,
  updateCategory,
  listTags,
  createTag,
  deleteTag,
  createProduct,
  updateProduct,
  deleteProduct,
  getProduct,
  listProducts,
  createVariant,
  updateVariant,
  addMedia,
  deleteMedia,
  getMediaFile,
  auditLogs,
};
