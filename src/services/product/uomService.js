/**
 * Section B — Unit of Measurement: predefined/custom units, product UOMs, conversions.
 */
const {
  pool, moduleContext, writeAudit, loadProduct, assertCompanyUsable,
  httpError, today, parseDate, cleanText, resolveUom,
} = require('./context');
const { PREDEFINED_UOMS, UOM_CATEGORIES } = require('../../config/productConfig');
const { insertFirstVersion, updateLatestVersion, loadVersions } = require('../versioning');

async function seedSystemUoms() {
  for (const u of PREDEFINED_UOMS) {
    const [existing] = await pool.query(
      'SELECT id FROM units_of_measure WHERE company_id IS NULL AND code = ?',
      [u.code]
    );
    if (existing.length) continue;
    await pool.query(
      `INSERT INTO units_of_measure (company_id, code, name, category, decimal_precision, is_system, status, created_by)
       VALUES (NULL, ?, ?, ?, ?, 1, 'ACTIVE', 'system')`,
      [u.code, u.name, u.category, u.decimal_precision]
    );
  }
  const [rows] = await pool.query(
    `SELECT * FROM units_of_measure WHERE company_id IS NULL ORDER BY category, code`
  );
  return rows;
}

async function listUoms(ctx, query = {}) {
  ctx.assert('view');
  const companyId = query.company_id ? Number(query.company_id) : null;
  if (companyId && !ctx.canSeeCompany?.(companyId) && ctx.companyIds !== null) {
    // allow system list without company
  }
  let [rows] = await pool.query(
    `SELECT * FROM units_of_measure
     WHERE company_id IS NULL OR company_id = ?
     ORDER BY is_system DESC, category, code`,
    [companyId || 0]
  );
  // Auto-heal after truncate: ensure system UOMs always available for the form
  if (!rows.some((r) => r.company_id == null)) {
    await seedSystemUoms();
    [rows] = await pool.query(
      `SELECT * FROM units_of_measure
       WHERE company_id IS NULL OR company_id = ?
       ORDER BY is_system DESC, category, code`,
      [companyId || 0]
    );
  }
  return rows.filter((r) => !query.category || r.category === String(query.category).toUpperCase())
    .filter((r) => !query.status || r.status === String(query.status).toUpperCase());
}

async function createUom(ctx, body = {}) {
  ctx.assert('create');
  const company = await assertCompanyUsable(ctx, body.company_id);
  const code = cleanText(body.code)?.toUpperCase();
  const name = cleanText(body.name);
  const category = (cleanText(body.category) || 'OTHER').toUpperCase();
  if (!code || !name) throw httpError(400, 'code and name are required');
  if (!UOM_CATEGORIES.includes(category)) throw httpError(400, `category must be one of ${UOM_CATEGORIES.join(', ')}`);
  const precision = Number(body.decimal_precision);
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw httpError(400, 'decimal_precision must be 0–6');
  }
  try {
    const [ins] = await pool.query(
      `INSERT INTO units_of_measure (company_id, code, name, category, decimal_precision, is_system, status, created_by)
       VALUES (?, ?, ?, ?, ?, 0, 'ACTIVE', ?)`,
      [company.id, code, name, category, precision, ctx.actor]
    );
    await writeAudit(pool, {
      companyId: company.id, entityType: 'UOM', entityId: ins.insertId, action: 'CREATED',
      actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, [{ field: 'code', old: null, new: code }]);
    const [[row]] = await pool.query('SELECT * FROM units_of_measure WHERE id = ?', [ins.insertId]);
    return row;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw httpError(409, `Unit code ${code} already exists`);
    throw e;
  }
}

async function updateUom(ctx, id, body = {}) {
  ctx.assert('edit');
  const [[uom]] = await pool.query('SELECT * FROM units_of_measure WHERE id = ?', [Number(id) || 0]);
  if (!uom) throw httpError(404, 'Unit not found');
  if (uom.is_system) throw httpError(400, 'System predefined units cannot be edited (create a custom unit instead)');
  if (!ctx.canSeeCompany(uom.company_id)) throw httpError(404, 'Unit not found');
  const name = body.name !== undefined ? cleanText(body.name) : uom.name;
  const category = body.category !== undefined ? cleanText(body.category)?.toUpperCase() : uom.category;
  const precision = body.decimal_precision !== undefined ? Number(body.decimal_precision) : uom.decimal_precision;
  const status = body.status !== undefined ? cleanText(body.status)?.toUpperCase() : uom.status;
  if (!name) throw httpError(400, 'name is required');
  if (!UOM_CATEGORIES.includes(category)) throw httpError(400, `category must be one of ${UOM_CATEGORIES.join(', ')}`);
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) throw httpError(400, 'decimal_precision must be 0–6');
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw httpError(400, 'status must be ACTIVE or INACTIVE');
  await pool.query(
    'UPDATE units_of_measure SET name = ?, category = ?, decimal_precision = ?, status = ? WHERE id = ?',
    [name, category, precision, status, uom.id]
  );
  await writeAudit(pool, {
    companyId: uom.company_id, entityType: 'UOM', entityId: uom.id, action: 'UPDATED',
    actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
  });
  const [[row]] = await pool.query('SELECT * FROM units_of_measure WHERE id = ?', [uom.id]);
  return row;
}

/** Convert txn qty in fromUom → stock UOM using product-specific factor (section B.5–B.7). */
async function convertToStockQty(conn, productId, companyId, fromUomId, qty, stockUomId) {
  const amount = Number(qty);
  if (!Number.isFinite(amount)) throw httpError(400, 'qty must be a number');
  if (fromUomId === stockUomId) return amount;
  const from = await resolveUom(conn, fromUomId, companyId);
  const to = await resolveUom(conn, stockUomId, companyId);

  const [[direct]] = await conn.query(
    `SELECT factor FROM product_unit_conversions
     WHERE product_id = ? AND from_uom_id = ? AND to_uom_id = ?
       AND effective_from <= CURDATE() AND (effective_to IS NULL OR effective_to >= CURDATE())
     ORDER BY effective_from DESC LIMIT 1`,
    [productId, fromUomId, stockUomId]
  );
  if (direct) return amount * Number(direct.factor);

  const [[inverse]] = await conn.query(
    `SELECT factor FROM product_unit_conversions
     WHERE product_id = ? AND from_uom_id = ? AND to_uom_id = ?
       AND effective_from <= CURDATE() AND (effective_to IS NULL OR effective_to >= CURDATE())
     ORDER BY effective_from DESC LIMIT 1`,
    [productId, stockUomId, fromUomId]
  );
  if (inverse && Number(inverse.factor) !== 0) return amount / Number(inverse.factor);

  // Same category system ratios for weight/length/volume base pairs only
  const SYSTEM = {
    WEIGHT: { KG: 1, GM: 0.001 },
    LENGTH: { MTR: 1, CM: 0.01, MM: 0.001, FT: 0.3048 },
    VOLUME: { LTR: 1, ML: 0.001 },
  };
  const table = SYSTEM[from.category];
  if (table && from.category === to.category && table[from.code] != null && table[to.code] != null) {
    return (amount * table[from.code]) / table[to.code];
  }

  throw httpError(400,
    `No conversion defined for product #${productId}: ${from.code} → ${to.code}. Add a product-specific conversion.`);
}

async function listConversions(ctx, productId) {
  ctx.assert('view');
  const product = await loadProduct(pool, ctx, productId);
  const [rows] = await pool.query(
    `SELECT c.*, f.code AS from_code, t.code AS to_code
     FROM product_unit_conversions c
     JOIN units_of_measure f ON f.id = c.from_uom_id
     JOIN units_of_measure t ON t.id = c.to_uom_id
     WHERE c.product_id = ?
     ORDER BY c.from_uom_id, c.to_uom_id, c.effective_from DESC`,
    [product.id]
  );
  return rows;
}

async function upsertConversion(ctx, productId, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  const fromUom = await resolveUom(pool, body.from_uom_id, product.company_id);
  const toUom = await resolveUom(pool, body.to_uom_id, product.company_id);
  if (fromUom.id === toUom.id) throw httpError(400, 'from_uom_id and to_uom_id must differ');
  const factor = Number(body.factor);
  if (!(factor > 0)) throw httpError(400, 'factor must be a positive number');
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();

  // Incompatible categories require explicit product conversion (always allowed when posting here)
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[exact]] = await conn.query(
      `SELECT * FROM product_unit_conversions
       WHERE product_id = ? AND from_uom_id = ? AND to_uom_id = ? AND effective_from = ?`,
      [product.id, fromUom.id, toUom.id, effectiveDate]
    );
    if (exact) {
      await conn.query(
        'UPDATE product_unit_conversions SET factor = ?, remarks = ?, created_by = ? WHERE id = ?',
        [factor, cleanText(body.reason), ctx.actor, exact.id]
      );
    } else {
      const [[prev]] = await conn.query(
        `SELECT * FROM product_unit_conversions
         WHERE product_id = ? AND from_uom_id = ? AND to_uom_id = ?
           AND effective_from < ? AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC LIMIT 1`,
        [product.id, fromUom.id, toUom.id, effectiveDate, effectiveDate]
      );
      if (prev) {
        const d = new Date(`${effectiveDate}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        await conn.query('UPDATE product_unit_conversions SET effective_to = ? WHERE id = ?', [
          d.toISOString().slice(0, 10), prev.id,
        ]);
      }
      await conn.query(
        `INSERT INTO product_unit_conversions
         (product_id, from_uom_id, to_uom_id, factor, effective_from, remarks, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [product.id, fromUom.id, toUom.id, factor, effectiveDate, cleanText(body.reason), ctx.actor]
      );
    }
    await writeAudit(conn, {
      companyId: product.company_id, productId: product.id, entityType: 'UOM_CONVERSION',
      action: 'UPSERTED', effectiveDate, actor: ctx.actor, role: ctx.role, reason: cleanText(body.reason),
    }, [{ field: 'factor', old: null, new: `${fromUom.code}=${factor}${toUom.code}` }]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return listConversions(ctx, product.id);
}

module.exports = {
  moduleContext,
  seedSystemUoms,
  listUoms,
  createUom,
  updateUom,
  convertToStockQty,
  listConversions,
  upsertConversion,
};
