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
  PRODUCT_CLASSIFICATIONS, PRODUCT_STATUSES, MEDIA_TYPES, DEFAULT_CATEGORY_TREE,
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

async function createProduct(ctx, body = {}) {
  ctx.assert('create');
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
  const profile = readVersionFields(PRODUCT_VERSION_FIELDS, body);
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const tagIds = Array.isArray(body.tag_ids) ? body.tag_ids.map(Number) : [];

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

  if (body.gst) await gstPricing.setGst(ctx, productId, { ...body.gst, effective_date: effectiveDate });
  if (body.prices || body.pricing) {
    await gstPricing.setPrices(ctx, productId, { ...(body.prices || body.pricing), effective_date: effectiveDate });
  }
  if (Array.isArray(body.conversions)) {
    for (const c of body.conversions) {
      await uomService.upsertConversion(ctx, productId, { ...c, effective_date: effectiveDate });
    }
  }
  return getProduct(ctx, productId, { as_of: effectiveDate });
}

async function updateProduct(ctx, id, body = {}) {
  ctx.assert('edit');
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
  const tagsChanged = body.tag_ids !== undefined;

  if (!fieldChanged.length && !dateChanged && !idChanged && !tagsChanged && body.remarks === undefined) {
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
      await setProductTags(conn, product.id, product.company_id, body.tag_ids.map(Number), ctx.actor);
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
    suggested_tags: SUGGESTED_TAGS,
    version_fields: Object.keys(PRODUCT_VERSION_FIELDS),
    variant_fields: Object.keys(VARIANT_VERSION_FIELDS),
    default_category_tree: DEFAULT_CATEGORY_TREE.map((c) => ({ code: c.code, name: c.name, children: c.children })),
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
  getProduct,
  listProducts,
  createVariant,
  updateVariant,
  addMedia,
  deleteMedia,
  getMediaFile,
  auditLogs,
};
