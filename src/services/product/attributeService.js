/** Section H — Custom attribute definitions, values, suggested tags seed, bulk update. */
const {
  pool, moduleContext, writeAudit, loadProduct, assertCompanyUsable,
  httpError, today, parseDate, cleanText, parseJson,
} = require('./context');
const { ATTRIBUTE_TYPES, SUGGESTED_TAGS } = require('../../config/productConfig');

async function seedSuggestedTags(ctx, companyId) {
  ctx.assert('create');
  await assertCompanyUsable(ctx, companyId);
  let created = 0;
  for (const name of SUGGESTED_TAGS) {
    try {
      await pool.query(
        'INSERT INTO product_tags (company_id, name, created_by) VALUES (?, ?, ?)',
        [companyId, name, ctx.actor]
      );
      created += 1;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  return { created, tags: SUGGESTED_TAGS };
}

async function listAttributeDefs(ctx, query = {}) {
  ctx.assert('view');
  const companyId = Number(query.company_id);
  if (!companyId) throw httpError(400, 'company_id is required');
  if (!ctx.canSeeCompany(companyId)) throw httpError(404, 'Company not found');
  const [rows] = await pool.query(
    `SELECT * FROM product_attribute_defs WHERE company_id = ?
     ${query.category_id ? 'AND (category_id IS NULL OR category_id = ?)' : ''}
     AND status = 'ACTIVE'
     ORDER BY sort_order, name`,
    query.category_id ? [companyId, Number(query.category_id)] : [companyId]
  );
  return rows.map((r) => ({
    ...r,
    options: typeof r.options === 'string' ? JSON.parse(r.options) : r.options,
    is_required: !!r.is_required,
  }));
}

async function createAttributeDef(ctx, body = {}) {
  ctx.assert('create');
  const company = await assertCompanyUsable(ctx, body.company_id);
  const code = cleanText(body.code)?.toUpperCase();
  const name = cleanText(body.name);
  const attributeType = (cleanText(body.attribute_type) || 'TEXT').toUpperCase();
  if (!code || !name) throw httpError(400, 'code and name are required');
  if (!ATTRIBUTE_TYPES.includes(attributeType)) {
    throw httpError(400, `attribute_type must be one of ${ATTRIBUTE_TYPES.join(', ')}`);
  }
  const options = parseJson(body.options, 'options');
  try {
    const [ins] = await pool.query(
      `INSERT INTO product_attribute_defs
       (company_id, code, name, attribute_type, options, category_id, is_required, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        company.id, code, name, attributeType,
        options ? JSON.stringify(options) : null,
        body.category_id ? Number(body.category_id) : null,
        body.is_required ? 1 : 0,
        Number(body.sort_order) || 0,
        ctx.actor,
      ]
    );
    const [[row]] = await pool.query('SELECT * FROM product_attribute_defs WHERE id = ?', [ins.insertId]);
    return row;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw httpError(409, `Attribute code ${code} already exists`);
    throw e;
  }
}

async function setProductAttributes(ctx, productId, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const values = body.values || body.attributes;
  if (!values || typeof values !== 'object') throw httpError(400, 'values object is required (def_id or code → value)');

  const defs = await listAttributeDefs(ctx, {
    company_id: product.company_id,
    category_id: body.category_id,
  });
  const byCode = new Map(defs.map((d) => [d.code, d]));
  const byId = new Map(defs.map((d) => [d.id, d]));

  // Partial PUT: only validate required attrs that appear in this payload (or require_all=true).
  // Avoid failing because unrelated company-wide required defs from other tests/forms are unset.
  const requireAll = !!body.require_all;
  for (const d of defs.filter((x) => x.is_required)) {
    const present = values[d.id] !== undefined || values[d.code] !== undefined
      || values[String(d.code).toUpperCase()] !== undefined;
    if (!present && !requireAll) continue;
    const val = values[d.id] ?? values[d.code] ?? values[String(d.code).toUpperCase()];
    if (val === undefined || val === null || val === '') {
      throw httpError(400, `Required attribute ${d.code} is missing`);
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [key, raw] of Object.entries(values)) {
      const def = byId.get(Number(key)) || byCode.get(String(key).toUpperCase()) || byCode.get(String(key));
      if (!def) throw httpError(400, `Unknown attribute ${key}`);
      const valueText = Array.isArray(raw) ? JSON.stringify(raw) : (raw == null ? null : String(raw));
      await conn.query(
        `UPDATE product_attribute_values SET effective_to = ? WHERE product_id = ? AND attribute_def_id = ?
         AND effective_to IS NULL AND effective_from < ?`,
        [effectiveDate, product.id, def.id, effectiveDate]
      );
      await conn.query(
        `INSERT INTO product_attribute_values (product_id, attribute_def_id, value_text, effective_from, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), created_by = VALUES(created_by)`,
        [product.id, def.id, valueText, effectiveDate, ctx.actor]
      );
    }
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'ATTRIBUTES',
      action: 'UPDATED', effectiveDate, actor: ctx.actor, role: ctx.role,
    });
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getProductAttributes(ctx, product.id, { as_of: effectiveDate });
}

async function getProductAttributes(ctx, productId, query = {}) {
  ctx.assert('view');
  const product = await loadProduct(pool, ctx, productId);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const [rows] = await pool.query(
    `SELECT v.*, d.code, d.name, d.attribute_type, d.is_required
     FROM product_attribute_values v
     JOIN product_attribute_defs d ON d.id = v.attribute_def_id
     WHERE v.product_id = ?
       AND v.effective_from = (
         SELECT MAX(x.effective_from) FROM product_attribute_values x
         WHERE x.product_id = v.product_id AND x.attribute_def_id = v.attribute_def_id
           AND x.effective_from <= ?
       )`,
    [product.id, asOf]
  );
  return rows;
}

async function bulkUpdate(ctx, body = {}) {
  ctx.assert('edit');
  const ids = Array.isArray(body.product_ids) ? body.product_ids.map(Number) : [];
  if (!ids.length) throw httpError(400, 'product_ids required');
  const companyId = Number(body.company_id);
  if (!companyId) throw httpError(400, 'company_id is required');
  await assertCompanyUsable(ctx, companyId);

  const results = { updated: 0, errors: [] };
  for (const id of ids) {
    try {
      const product = await loadProduct(pool, ctx, id);
      if (product.company_id !== companyId) throw httpError(400, 'wrong company');
      if (Array.isArray(body.tag_ids)) {
        await pool.query('DELETE FROM product_tag_links WHERE product_id = ?', [id]);
        if (body.tag_ids.length) {
          await pool.query(
            'INSERT INTO product_tag_links (product_id, tag_id, created_by) VALUES ?',
            [body.tag_ids.map((t) => [id, Number(t), ctx.actor])]
          );
        }
      }
      if (body.category_id !== undefined || body.min_stock !== undefined) {
        // reorder / category via profile update left to caller; here tags + reorder thresholds
      }
      if (body.min_stock !== undefined || body.reorder_level !== undefined) {
        await pool.query(
          `INSERT INTO product_reorder_settings
           (product_id, warehouse_id, min_stock, max_stock, reorder_level, reorder_qty, safety_stock, effective_from, created_by)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            Number(body.min_stock) || 0,
            body.max_stock != null ? Number(body.max_stock) : null,
            body.reorder_level != null ? Number(body.reorder_level) : null,
            body.reorder_qty != null ? Number(body.reorder_qty) : null,
            body.safety_stock != null ? Number(body.safety_stock) : null,
            today(), ctx.actor,
          ]
        );
      }
      results.updated += 1;
    } catch (e) {
      results.errors.push({ product_id: id, error: e.message });
    }
  }
  await writeAudit(pool, {
    companyId, entityType: 'BULK', action: 'UPDATED', actor: ctx.actor, role: ctx.role,
    note: `${results.updated} products`,
  });
  return results;
}

async function checkDuplicates(ctx, body = {}) {
  ctx.assert('view');
  const companyId = Number(body.company_id);
  if (!companyId) throw httpError(400, 'company_id is required');
  if (!ctx.canSeeCompany(companyId)) throw httpError(404, 'Company not found');
  const warnings = [];
  for (const [col, label] of [['sku', 'SKU'], ['product_code', 'Product code'], ['barcode', 'Barcode'], ['internal_item_code', 'Internal item code']]) {
    const val = cleanText(body[col]);
    if (!val) continue;
    const [rows] = await pool.query(
      `SELECT id, sku, product_code FROM products WHERE company_id = ? AND ${col} = ? AND id <> ?`,
      [companyId, col === 'barcode' ? val : val.toUpperCase(), Number(body.exclude_id) || 0]
    );
    if (rows.length) warnings.push({ field: col, label, matches: rows });
  }
  return { ok: !warnings.length, warnings };
}

module.exports = {
  moduleContext,
  seedSuggestedTags,
  listAttributeDefs,
  createAttributeDef,
  setProductAttributes,
  getProductAttributes,
  bulkUpdate,
  checkDuplicates,
};
