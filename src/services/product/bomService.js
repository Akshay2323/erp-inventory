/** Section G — BOM + production orders (issue / return / complete / scrap). */
const {
  pool, moduleContext, writeAudit, loadProduct, assertCompanyUsable,
  httpError, today, parseDate, cleanText, resolveUom,
} = require('./context');
const { insertFirstVersion, loadVersions, resolveVersion } = require('../versioning');
const { postTransaction } = require('./inventoryService');

async function listBoms(ctx, query = {}) {
  ctx.assert('view');
  const companyId = Number(query.company_id);
  if (!companyId) throw httpError(400, 'company_id is required');
  if (!ctx.canSeeCompany(companyId)) throw httpError(404, 'Company not found');
  const [rows] = await pool.query(
    `SELECT b.*, p.sku, p.product_code FROM bills_of_materials b
     JOIN products p ON p.id = b.product_id
     WHERE b.company_id = ? ${query.product_id ? 'AND b.product_id = ?' : ''}
     ORDER BY b.code`,
    query.product_id ? [companyId, Number(query.product_id)] : [companyId]
  );
  return rows;
}

async function getBom(ctx, id, query = {}) {
  ctx.assert('view');
  const [[bom]] = await pool.query('SELECT * FROM bills_of_materials WHERE id = ?', [Number(id) || 0]);
  if (!bom || !ctx.canSeeCompany(bom.company_id)) throw httpError(404, 'BOM not found');
  const versions = (await loadVersions(pool, 'bom_versions', 'bom_id', [bom.id])).get(bom.id) || [];
  const asOf = parseDate(query.as_of, 'as_of')
    || (versions.length ? String(versions[versions.length - 1].effective_from).slice(0, 10) : today());
  const { current, upcoming } = resolveVersion(versions, asOf);
  const shown = current || upcoming || versions[versions.length - 1];
  let components = [];
  if (shown) {
    const [comps] = await pool.query(
      `SELECT c.*, p.sku, p.product_code, u.code AS uom_code
       FROM bom_components c
       JOIN products p ON p.id = c.component_product_id
       JOIN units_of_measure u ON u.id = c.uom_id
       WHERE c.bom_version_id = ?
       ORDER BY c.sort_order, c.id`,
      [shown.id]
    );
    components = comps;
  }
  return {
    ...bom,
    as_of: asOf,
    version: shown,
    components,
    versions: versions.map((v) => ({
      id: v.id, version_no: v.version_no, name: v.name, status: v.status,
      output_qty: Number(v.output_qty), effective_from: v.effective_from, effective_to: v.effective_to,
    })).reverse(),
  };
}

async function createBom(ctx, body = {}) {
  ctx.assert('create');
  const company = await assertCompanyUsable(ctx, body.company_id);
  const product = await loadProduct(pool, ctx, body.product_id);
  if (product.company_id !== company.id) throw httpError(400, 'product_id must belong to company');
  const code = cleanText(body.code)?.toUpperCase();
  const name = cleanText(body.name) || code;
  if (!code) throw httpError(400, 'code is required');
  const outputUom = await resolveUom(pool, body.output_uom_id, company.id);
  const outputQty = Number(body.output_qty) || 1;
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const components = Array.isArray(body.components) ? body.components : [];
  if (!components.length) throw httpError(400, 'components array is required');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      'INSERT INTO bills_of_materials (company_id, product_id, code, created_by) VALUES (?, ?, ?, ?)',
      [company.id, product.id, code, ctx.actor]
    );
    const [ver] = await conn.query(
      `INSERT INTO bom_versions
       (bom_id, version_no, name, output_qty, output_uom_id, status, approval_status, effective_from, remarks, created_by)
       VALUES (?, 1, ?, ?, ?, 'ACTIVE', 'APPROVED', ?, ?, ?)`,
      [ins.insertId, name, outputQty, outputUom.id, effectiveDate, cleanText(body.reason), ctx.actor]
    );
    for (const [i, c] of components.entries()) {
      const comp = await loadProduct(conn, ctx, c.product_id || c.component_product_id);
      const uom = await resolveUom(conn, c.uom_id, company.id);
      const qty = Number(c.qty);
      if (!(qty > 0)) throw httpError(400, `components[${i}].qty must be positive`);
      await conn.query(
        `INSERT INTO bom_components
         (bom_version_id, component_product_id, qty, uom_id, scrap_percent, is_alternative, alt_group, sort_order, remarks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ver.insertId, comp.id, qty, uom.id, Number(c.scrap_percent) || 0,
          c.is_alternative ? 1 : 0, cleanText(c.alt_group), i, cleanText(c.remarks),
        ]
      );
    }
    await writeAudit(conn, {
      companyId: company.id, productId: product.id, entityType: 'BOM', entityId: ins.insertId,
      action: 'CREATED', effectiveDate, actor: ctx.actor, role: ctx.role,
    });
    await conn.commit();
    return getBom(ctx, ins.insertId);
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw httpError(409, `BOM code ${code} already exists`);
    throw e;
  } finally {
    conn.release();
  }
}

async function createProductionOrder(ctx, body = {}) {
  ctx.assert('create');
  const company = await assertCompanyUsable(ctx, body.company_id);
  const [[bom]] = await pool.query('SELECT * FROM bills_of_materials WHERE id = ? AND company_id = ?', [
    Number(body.bom_id) || 0, company.id,
  ]);
  if (!bom) throw httpError(404, 'BOM not found');
  const detail = await getBom(ctx, bom.id, { as_of: body.as_of });
  if (!detail.version) throw httpError(400, 'BOM has no effective version');
  const warehouseId = Number(body.warehouse_id);
  const [[wh]] = await pool.query('SELECT id FROM warehouses WHERE id = ? AND company_id = ?', [warehouseId, company.id]);
  if (!wh) throw httpError(400, 'warehouse_id not found');
  const qty = Number(body.qty);
  if (!(qty > 0)) throw httpError(400, 'qty must be positive');
  const orderNo = cleanText(body.order_no)?.toUpperCase() || `PO-${Date.now().toString().slice(-8)}`;
  const [ins] = await pool.query(
    `INSERT INTO production_orders
     (company_id, bom_id, bom_version_id, product_id, warehouse_id, order_no, qty, uom_id, status, planned_date, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RELEASED', ?, ?, ?)`,
    [
      company.id, bom.id, detail.version.id, bom.product_id, warehouseId, orderNo, qty,
      detail.version.output_uom_id, parseDate(body.planned_date, 'planned_date'), cleanText(body.remarks), ctx.actor,
    ]
  );
  return getProductionOrder(ctx, ins.insertId);
}

async function getProductionOrder(ctx, id) {
  ctx.assert('view');
  const [[order]] = await pool.query('SELECT * FROM production_orders WHERE id = ?', [Number(id) || 0]);
  if (!order || !ctx.canSeeCompany(order.company_id)) throw httpError(404, 'Production order not found');
  const [materials] = await pool.query(
    'SELECT * FROM production_material_transactions WHERE production_order_id = ? ORDER BY id',
    [order.id]
  );
  const [outputs] = await pool.query(
    'SELECT * FROM production_output_transactions WHERE production_order_id = ? ORDER BY id',
    [order.id]
  );
  const bom = await getBom(ctx, order.bom_id);
  const scale = Number(order.qty) / Number(bom.version?.output_qty || 1);
  const requirements = (bom.components || []).map((c) => ({
    ...c,
    required_qty: Number(c.qty) * scale * (1 + Number(c.scrap_percent || 0) / 100),
  }));
  return { ...order, requirements, materials, outputs };
}

async function issueMaterials(ctx, orderId, body = {}) {
  ctx.assert('edit');
  const order = await getProductionOrder(ctx, orderId);
  if (!['RELEASED', 'IN_PROGRESS'].includes(order.status)) {
    throw httpError(400, 'Order must be RELEASED or IN_PROGRESS to issue materials');
  }
  const product = await loadProduct(pool, ctx, body.product_id);
  const qty = Number(body.qty);
  if (!(qty > 0)) throw httpError(400, 'qty must be positive');
  const uomId = Number(body.uom_id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const txnId = await postTransaction(conn, ctx, {
      product, warehouseId: order.warehouse_id, txnType: 'PRODUCTION_ISSUE',
      txnDate: parseDate(body.txn_date, 'txn_date') || today(),
      txnQty: qty, txnUomId: uomId, referenceType: 'production_orders', referenceId: order.id,
      referenceNo: order.order_no, remarks: cleanText(body.remarks), sign: -1,
    });
    await conn.query(
      `INSERT INTO production_material_transactions
       (production_order_id, product_id, warehouse_id, txn_type, qty, uom_id, inventory_txn_id, remarks, created_by)
       VALUES (?, ?, ?, 'ISSUE', ?, ?, ?, ?, ?)`,
      [order.id, product.id, order.warehouse_id, qty, uomId, txnId, cleanText(body.remarks), ctx.actor]
    );
    await conn.query(`UPDATE production_orders SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'RELEASED'`, [order.id]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getProductionOrder(ctx, order.id);
}

async function returnMaterials(ctx, orderId, body = {}) {
  ctx.assert('edit');
  const order = await getProductionOrder(ctx, orderId);
  const product = await loadProduct(pool, ctx, body.product_id);
  const qty = Number(body.qty);
  if (!(qty > 0)) throw httpError(400, 'qty must be positive');
  const uomId = Number(body.uom_id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const txnId = await postTransaction(conn, ctx, {
      product, warehouseId: order.warehouse_id, txnType: 'PRODUCTION_RETURN',
      txnDate: parseDate(body.txn_date, 'txn_date') || today(),
      txnQty: qty, txnUomId: uomId, referenceType: 'production_orders', referenceId: order.id,
      referenceNo: order.order_no, sign: 1,
    });
    await conn.query(
      `INSERT INTO production_material_transactions
       (production_order_id, product_id, warehouse_id, txn_type, qty, uom_id, inventory_txn_id, remarks, created_by)
       VALUES (?, ?, ?, 'RETURN', ?, ?, ?, ?, ?)`,
      [order.id, product.id, order.warehouse_id, qty, uomId, txnId, cleanText(body.remarks), ctx.actor]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getProductionOrder(ctx, order.id);
}

async function completeProduction(ctx, orderId, body = {}) {
  ctx.assert('edit');
  const order = await getProductionOrder(ctx, orderId);
  if (order.status === 'COMPLETED') throw httpError(400, 'Order already completed');
  const fg = await loadProduct(pool, ctx, order.product_id);
  const qty = Number(body.qty != null ? body.qty : order.qty);
  if (!(qty > 0)) throw httpError(400, 'qty must be positive');
  const unitCost = body.unit_cost != null ? Number(body.unit_cost) : null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const txnId = await postTransaction(conn, ctx, {
      product: fg, warehouseId: order.warehouse_id, txnType: 'PRODUCTION_RECEIPT',
      txnDate: parseDate(body.txn_date, 'txn_date') || today(),
      txnQty: qty, txnUomId: order.uom_id, unitCost,
      referenceType: 'production_orders', referenceId: order.id, referenceNo: order.order_no, sign: 1,
    });
    await conn.query(
      `INSERT INTO production_output_transactions
       (production_order_id, product_id, warehouse_id, qty, uom_id, unit_cost, inventory_txn_id, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [order.id, fg.id, order.warehouse_id, qty, order.uom_id, unitCost, txnId, cleanText(body.remarks), ctx.actor]
    );
    if (body.scrap_qty && Number(body.scrap_qty) > 0 && body.scrap_product_id) {
      if (!body.scrap_uom_id) throw httpError(400, 'scrap_uom_id is required with scrap_qty');
      const scrap = await loadProduct(conn, ctx, body.scrap_product_id);
      const scrapUomId = Number(body.scrap_uom_id);
      const scrapTxn = await postTransaction(conn, ctx, {
        product: scrap, warehouseId: order.warehouse_id, txnType: 'SCRAP',
        txnDate: today(), txnQty: Number(body.scrap_qty), txnUomId: scrapUomId,
        referenceType: 'production_orders', referenceId: order.id, sign: -1,
      });
      await conn.query(
        `INSERT INTO production_material_transactions
         (production_order_id, product_id, warehouse_id, txn_type, qty, uom_id, inventory_txn_id, remarks, created_by)
         VALUES (?, ?, ?, 'SCRAP', ?, ?, ?, ?, ?)`,
        [order.id, scrap.id, order.warehouse_id, body.scrap_qty, scrapUomId, scrapTxn, cleanText(body.remarks), ctx.actor]
      );
    }
    await conn.query(
      `UPDATE production_orders SET status = 'COMPLETED', completed_date = ? WHERE id = ?`,
      [today(), order.id]
    );
    await writeAudit(conn, {
      companyId: order.company_id, productId: order.product_id, entityType: 'PRODUCTION', entityId: order.id,
      action: 'COMPLETED', actor: ctx.actor, role: ctx.role,
    });
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getProductionOrder(ctx, order.id);
}

module.exports = {
  moduleContext,
  listBoms,
  getBom,
  createBom,
  createProductionOrder,
  getProductionOrder,
  issueMaterials,
  returnMaterials,
  completeProduction,
};
