/** Sections C & E — GST config and product pricing (effective-dated). */
const {
  pool, moduleContext, writeAudit, loadProduct,
  httpError, today, parseDate, cleanText, readVersionFields, formatVersion,
} = require('./context');
const {
  GST_RATES, TAX_TYPES, HSN_SAC_TYPES, GST_VERSION_FIELDS, PRICE_VERSION_FIELDS,
} = require('../../config/productConfig');
const {
  loadVersions, resolveVersion, insertFirstVersion, updateLatestVersion, changedFields,
} = require('../versioning');

const GST_FIELDS = ['code_type', 'hsn_sac', 'gst_rate', 'tax_type', 'cess_rate'];
const PRICE_FIELDS = Object.keys(PRICE_VERSION_FIELDS);

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, 'Invalid number');
  return n;
}

async function getGst(ctx, productId, query = {}) {
  ctx.assert('view');
  const product = await loadProduct(pool, ctx, productId);
  const versions = (await loadVersions(pool, 'product_gst_versions', 'product_id', [product.id])).get(product.id) || [];
  const asOf = parseDate(query.as_of, 'as_of')
    || (versions.length ? String(versions[versions.length - 1].effective_from).slice(0, 10) : today());
  const { current, upcoming } = resolveVersion(versions, asOf);
  const shown = current || upcoming || versions[versions.length - 1] || null;
  return {
    product_id: product.id,
    as_of: asOf,
    current: shown ? {
      version_id: shown.id,
      code_type: shown.code_type,
      hsn_sac: shown.hsn_sac,
      gst_rate: Number(shown.gst_rate),
      tax_type: shown.tax_type,
      cess_rate: shown.cess_rate != null ? Number(shown.cess_rate) : 0,
      effective_from: shown.effective_from,
      effective_to: shown.effective_to,
    } : null,
    history: versions.map((v) => ({
      version_id: v.id, code_type: v.code_type, hsn_sac: v.hsn_sac,
      gst_rate: Number(v.gst_rate), tax_type: v.tax_type,
      cess_rate: v.cess_rate != null ? Number(v.cess_rate) : 0,
      effective_from: v.effective_from, effective_to: v.effective_to,
      created_by: v.created_by,
    })).reverse(),
  };
}

function parseGstRate(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const str = String(raw).trim();
  const m = str.match(/^(\d+(?:\.\d+)?)/);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : NaN;
  }
  const n = Number(str.replace(/%/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}

function validateHsnSac(codeType, raw) {
  const code = String(raw || '').replace(/\s/g, '');
  if (codeType === 'SAC') {
    if (!/^\d{6}$/.test(code)) throw httpError(400, 'SAC must be 6 digits (e.g. 998313)');
    return code;
  }
  if (!/^(\d{4}|\d{6}|\d{8})$/.test(code)) throw httpError(400, 'HSN must be 4, 6 or 8 digits');
  return code;
}

async function setGst(ctx, productId, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  const codeType = (cleanText(body.code_type) || (cleanText(body.sac || body.sac_code) ? 'SAC' : 'HSN')).toUpperCase();
  const hsnSacRaw = body.hsn_sac ?? body.hsn ?? body.hsn_code ?? body.sac ?? body.sac_code;
  if (!HSN_SAC_TYPES.includes(codeType)) throw httpError(400, `code_type must be HSN or SAC`);
  if (hsnSacRaw == null || hsnSacRaw === '') throw httpError(400, codeType === 'SAC' ? 'sac is required for SERVICE items' : 'hsn_sac is required');
  const hsnSac = validateHsnSac(codeType, hsnSacRaw);
  const gstRate = parseGstRate(body.gst_rate);
  if (!GST_RATES.includes(gstRate)) throw httpError(400, `gst_rate must be one of ${GST_RATES.join(', ')}`);
  const taxType = (cleanText(body.tax_type) || 'TAXABLE').toUpperCase();
  if (!TAX_TYPES.includes(taxType)) throw httpError(400, `tax_type must be one of ${TAX_TYPES.join(', ')}`);
  const cessRate = numOrNull(body.cess_rate) ?? 0;
  const effectiveDate = parseDate(body.effective_date ?? body.effective_from, 'effective_date') || today();
  const data = {
    code_type: codeType, hsn_sac: hsnSac, gst_rate: gstRate, tax_type: taxType, cess_rate: cessRate,
  };

  const versions = (await loadVersions(pool, 'product_gst_versions', 'product_id', [product.id])).get(product.id) || [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (!versions.length) {
      await insertFirstVersion(conn, {
        table: 'product_gst_versions', fk: 'product_id', parentId: product.id,
        fields: GST_FIELDS, data, effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
      });
    } else {
      await updateLatestVersion(conn, {
        table: 'product_gst_versions', fk: 'product_id', parentId: product.id,
        fields: GST_FIELDS, data, effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
      });
    }
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'GST', entityId: product.id,
      action: 'UPDATED', effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, [
      { field: 'hsn_sac', old: versions[versions.length - 1]?.hsn_sac, new: hsnSac },
      { field: 'gst_rate', old: versions[versions.length - 1]?.gst_rate, new: gstRate },
    ]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getGst(ctx, product.id);
}

async function getPrices(ctx, productId, query = {}) {
  ctx.assert('view');
  const product = await loadProduct(pool, ctx, productId);
  const versions = (await loadVersions(pool, 'product_price_versions', 'product_id', [product.id])).get(product.id) || [];
  const asOf = parseDate(query.as_of, 'as_of')
    || (versions.length ? String(versions[versions.length - 1].effective_from).slice(0, 10) : today());
  const { current, upcoming } = resolveVersion(versions, asOf);
  const shown = current || upcoming || versions[versions.length - 1] || null;
  const shape = (v) => (v ? {
    version_id: v.id,
    purchase_price: v.purchase_price != null ? Number(v.purchase_price) : null,
    retail_price: v.retail_price != null ? Number(v.retail_price) : null,
    wholesale_price: v.wholesale_price != null ? Number(v.wholesale_price) : null,
    commercial_price: v.commercial_price != null ? Number(v.commercial_price) : null,
    standard_cost: v.standard_cost != null ? Number(v.standard_cost) : null,
    currency: v.currency,
    min_margin_percent: v.min_margin_percent != null ? Number(v.min_margin_percent) : null,
    discount_percent: v.discount_percent != null ? Number(v.discount_percent) : null,
    max_price_discount: v.max_price_discount != null ? Number(v.max_price_discount) : null,
    effective_from: v.effective_from,
    effective_to: v.effective_to,
    created_by: v.created_by,
  } : null);
  return { product_id: product.id, as_of: asOf, current: shape(shown), history: versions.map(shape).reverse() };
}

async function setPrices(ctx, productId, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  const effectiveDate = parseDate(body.effective_date ?? body.effective_from, 'effective_date') || today();
  const data = {
    purchase_price: numOrNull(body.purchase_price),
    retail_price: numOrNull(body.retail_price),
    wholesale_price: numOrNull(body.wholesale_price),
    commercial_price: numOrNull(body.commercial_price),
    standard_cost: numOrNull(body.standard_cost),
    currency: cleanText(body.currency) || 'INR',
    min_margin_percent: numOrNull(body.min_margin_percent),
    discount_percent: numOrNull(body.discount_percent ?? body.max_discount_percent ?? body.max_discount),
    max_price_discount: numOrNull(body.max_price_discount),
  };
  if (Object.values(data).every((v, i) => i >= 5 || v == null) && data.purchase_price == null && data.retail_price == null) {
    // allow if at least one price field sent
  }
  const hasPrice = ['purchase_price', 'retail_price', 'wholesale_price', 'commercial_price', 'standard_cost',
    'max_price_discount', 'mrp', 'sale_price', 'purchase_cost']
    .some((k) => body[k] !== undefined);
  if (!hasPrice && body.min_margin_percent === undefined && body.discount_percent === undefined
    && body.max_discount_percent === undefined && body.max_discount === undefined) {
    throw httpError(400, 'Provide at least one price field');
  }
  if (body.purchase_price == null && body.purchase_cost != null) data.purchase_price = numOrNull(body.purchase_cost);
  if (body.retail_price == null && body.mrp != null) data.retail_price = numOrNull(body.mrp);
  if (body.wholesale_price == null && (body.sale_price != null || body.selling_price != null)) {
    data.wholesale_price = numOrNull(body.sale_price ?? body.selling_price);
  }

  const versions = (await loadVersions(pool, 'product_price_versions', 'product_id', [product.id])).get(product.id) || [];
  const latest = versions[versions.length - 1];
  if (latest) {
    for (const f of PRICE_FIELDS) {
      if (body[f] === undefined && f !== 'currency') data[f] = latest[f];
    }
    if (body.currency === undefined) data.currency = latest.currency;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (!versions.length) {
      await insertFirstVersion(conn, {
        table: 'product_price_versions', fk: 'product_id', parentId: product.id,
        fields: PRICE_FIELDS, data, effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
      });
    } else {
      await updateLatestVersion(conn, {
        table: 'product_price_versions', fk: 'product_id', parentId: product.id,
        fields: PRICE_FIELDS, data, effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
      });
    }
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'PRICE', entityId: product.id,
      action: 'UPDATED', effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    });
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getPrices(ctx, product.id);
}

async function listVendorMappings(ctx, productId) {
  ctx.assert('view');
  const product = await loadProduct(pool, ctx, productId);
  const [rows] = await pool.query(
    `SELECT * FROM product_vendor_mappings WHERE product_id = ? ORDER BY is_preferred DESC, id`,
    [product.id]
  );
  return rows;
}

async function upsertVendorMapping(ctx, productId, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  const vendorId = Number(body.vendor_id);
  if (!vendorId) throw httpError(400, 'vendor_id is required');
  const [[vendor]] = await pool.query('SELECT id FROM vendors WHERE id = ? AND company_id = ?', [vendorId, product.company_id]);
  if (!vendor) throw httpError(400, 'vendor_id not found for this company');
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const [ins] = await pool.query(
    `INSERT INTO product_vendor_mappings
     (product_id, vendor_id, vendor_item_code, purchase_price, lead_time_days, min_order_qty,
      is_preferred, purchase_uom_id, status, effective_from, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [
      product.id, vendorId, cleanText(body.vendor_item_code), numOrNull(body.purchase_price),
      body.lead_time_days != null ? Number(body.lead_time_days) : null,
      numOrNull(body.min_order_qty), body.is_preferred ? 1 : 0,
      body.purchase_uom_id ? Number(body.purchase_uom_id) : null,
      effectiveDate, cleanText(body.reason), ctx.actor,
    ]
  );
  if (body.is_preferred) {
    await pool.query(
      'UPDATE product_vendor_mappings SET is_preferred = 0 WHERE product_id = ? AND id <> ?',
      [product.id, ins.insertId]
    );
  }
  await writeAudit(pool, {
    companyId: product.company_id, productId: product.id, entityType: 'VENDOR_MAP', entityId: ins.insertId,
    action: 'CREATED', effectiveDate, actor: ctx.actor, role: ctx.role,
  });
  return listVendorMappings(ctx, product.id);
}

module.exports = {
  moduleContext,
  getGst,
  setGst,
  getPrices,
  setPrices,
  listVendorMappings,
  upsertVendorMapping,
  parseGstRate,
  validateHsnSac,
};
