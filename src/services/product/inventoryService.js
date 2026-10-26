/**
 * Section D — Warehouses, stock balances, ledger, opening, adjustments, reorder.
 * Balances in inventory_stock; immutable movements in inventory_transactions.
 */
const {
  pool, moduleContext, writeAudit, loadProduct, assertCompanyUsable,
  httpError, today, parseDate, cleanText, resolveUom,
} = require('./context');
const {
  STOCK_STATUSES, STOCK_TXN_TYPES, VALUATION_METHODS,
} = require('../../config/productConfig');
const { insertFirstVersion, updateLatestVersion, loadVersions, resolveVersion } = require('../versioning');
const { convertToStockQty } = require('./uomService');

async function writeInvAudit(conn, meta) {
  await conn.query(
    `INSERT INTO inventory_audit_logs
     (company_id, product_id, warehouse_id, action, field_name, old_value, new_value,
      reference_type, reference_id, changed_by, changed_by_role, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.companyId, meta.productId || null, meta.warehouseId || null, meta.action,
      meta.field || null, meta.old != null ? String(meta.old) : null, meta.new != null ? String(meta.new) : null,
      meta.refType || null, meta.refId || null, meta.actor, meta.role || null, meta.note || null,
    ]
  );
}

// ---- warehouses ----

async function listWarehouses(ctx, query = {}) {
  ctx.assert('view');
  const companyId = Number(query.company_id);
  if (!companyId) throw httpError(400, 'company_id is required');
  if (!ctx.canSeeCompany(companyId)) throw httpError(404, 'Company not found');
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const [rows] = await pool.query('SELECT * FROM warehouses WHERE company_id = ? ORDER BY code', [companyId]);
  const versions = await loadVersions(pool, 'warehouse_versions', 'warehouse_id', rows.map((r) => r.id));
  return rows.map((r) => {
    const list = versions.get(r.id) || [];
    const { current, upcoming } = resolveVersion(list, asOf);
    const v = current || upcoming || list[list.length - 1];
    return {
      id: r.id, company_id: r.company_id, code: r.code, warehouse_type: r.warehouse_type,
      name: v?.name, address: v?.address, city: v?.city, state: v?.state, pincode: v?.pincode,
      rack_bin: v?.rack_bin, status: v?.status, effective_from: v?.effective_from,
    };
  });
}

async function createWarehouse(ctx, body = {}) {
  ctx.assert('create');
  const company = await assertCompanyUsable(ctx, body.company_id);
  const code = cleanText(body.code)?.toUpperCase();
  const name = cleanText(body.name);
  if (!code || !name) throw httpError(400, 'code and name are required');
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      'INSERT INTO warehouses (company_id, code, warehouse_type, created_by) VALUES (?, ?, ?, ?)',
      [company.id, code, (cleanText(body.warehouse_type) || 'STORE').toUpperCase(), ctx.actor]
    );
    await insertFirstVersion(conn, {
      table: 'warehouse_versions', fk: 'warehouse_id', parentId: ins.insertId,
      fields: ['name', 'address', 'city', 'state', 'pincode', 'parent_warehouse_id', 'rack_bin', 'status'],
      data: {
        name, address: cleanText(body.address), city: cleanText(body.city),
        state: cleanText(body.state), pincode: cleanText(body.pincode),
        parent_warehouse_id: body.parent_warehouse_id ? Number(body.parent_warehouse_id) : null,
        rack_bin: cleanText(body.rack_bin), status: 'ACTIVE',
      },
      effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
    });
    await writeInvAudit(conn, {
      companyId: company.id, warehouseId: ins.insertId, action: 'WAREHOUSE_CREATED',
      new: code, actor: ctx.actor, role: ctx.role,
    });
    await conn.commit();
    return { id: ins.insertId, code, name };
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw httpError(409, `Warehouse code ${code} already exists`);
    throw e;
  } finally {
    conn.release();
  }
}

async function updateWarehouse(ctx, id, body = {}) {
  ctx.assert('edit');
  const [[wh]] = await pool.query('SELECT * FROM warehouses WHERE id = ?', [Number(id) || 0]);
  if (!wh || !ctx.canSeeCompany(wh.company_id)) throw httpError(404, 'Warehouse not found');
  const effectiveDate = parseDate(body.effective_date ?? body.effective_from, 'effective_date') || today();
  const versions = (await loadVersions(pool, 'warehouse_versions', 'warehouse_id', [wh.id])).get(wh.id) || [];
  const latest = versions[versions.length - 1];
  if (!latest) throw httpError(500, 'Warehouse has no versions');
  const data = {
    name: cleanText(body.name) ?? latest.name,
    address: body.address !== undefined ? cleanText(body.address) : latest.address,
    city: body.city !== undefined ? cleanText(body.city) : latest.city,
    state: body.state !== undefined ? cleanText(body.state) : latest.state,
    pincode: body.pincode !== undefined ? cleanText(body.pincode) : latest.pincode,
    parent_warehouse_id: body.parent_warehouse_id !== undefined
      ? (body.parent_warehouse_id ? Number(body.parent_warehouse_id) : null) : latest.parent_warehouse_id,
    rack_bin: body.rack_bin !== undefined ? cleanText(body.rack_bin) : latest.rack_bin,
    status: (cleanText(body.status) || latest.status || 'ACTIVE').toUpperCase(),
  };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await updateLatestVersion(conn, {
      table: 'warehouse_versions', fk: 'warehouse_id', parentId: wh.id,
      fields: ['name', 'address', 'city', 'state', 'pincode', 'parent_warehouse_id', 'rack_bin', 'status'],
      data, effectiveDate, remarks: cleanText(body.reason), actor: ctx.actor,
    });
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return listWarehouses(ctx, { company_id: wh.company_id, as_of: effectiveDate });
}

// ---- stock core ----

async function applyStockDelta(conn, {
  companyId, productId, variantId = 0, warehouseId, stockStatus = 'AVAILABLE',
  stockUomId, deltaQty, unitCost = null,
}) {
  if (!STOCK_STATUSES.includes(stockStatus)) throw httpError(400, `Invalid stock_status`);
  const vid = variantId || 0;
  const [[row]] = await conn.query(
    `SELECT * FROM inventory_stock
     WHERE product_id = ? AND warehouse_id = ? AND stock_status = ? AND IFNULL(variant_id, 0) = ?`,
    [productId, warehouseId, stockStatus, vid]
  );
  const newQty = Number(row?.qty || 0) + Number(deltaQty);
  if (newQty < -0.000001) throw httpError(400, 'Insufficient stock for this movement');
  let avgCost = row?.avg_cost != null ? Number(row.avg_cost) : null;
  if (deltaQty > 0 && unitCost != null) {
    const oldQty = Number(row?.qty || 0);
    const oldVal = (avgCost || 0) * oldQty;
    avgCost = newQty === 0 ? unitCost : (oldVal + Number(unitCost) * deltaQty) / newQty;
  }
  if (row) {
    await conn.query('UPDATE inventory_stock SET qty = ?, avg_cost = COALESCE(?, avg_cost), stock_uom_id = ? WHERE id = ?', [
      newQty, avgCost, stockUomId, row.id,
    ]);
  } else {
    await conn.query(
      `INSERT INTO inventory_stock
       (company_id, product_id, variant_id, warehouse_id, stock_status, qty, stock_uom_id, avg_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, productId, vid || null, warehouseId, stockStatus, newQty, stockUomId, avgCost]
    );
  }
  return newQty;
}

async function postTransaction(conn, ctx, payload) {
  const {
    product, warehouseId, toWarehouseId = null, txnType, txnDate, stockStatus = 'AVAILABLE',
    txnQty, txnUomId, unitCost = null, referenceType = null, referenceId = null,
    referenceNo = null, reasonCode = null, remarks = null, variantId = null,
    sign, // +1 inward, -1 outward
  } = payload;
  if (!STOCK_TXN_TYPES.includes(txnType)) throw httpError(400, `txn_type must be one of ${STOCK_TXN_TYPES.join(', ')}`);

  const [[ver]] = await conn.query(
    `SELECT * FROM product_versions WHERE product_id = ? ORDER BY effective_from DESC LIMIT 1`,
    [product.id]
  );
  if (!ver?.stock_uom_id) throw httpError(400, 'Product has no stock_uom_id — set units on the product first');
  const stockQtyAbs = await convertToStockQty(
    conn, product.id, product.company_id, txnUomId, Math.abs(Number(txnQty)), ver.stock_uom_id
  );
  const stockQty = sign * stockQtyAbs;

  await applyStockDelta(conn, {
    companyId: product.company_id, productId: product.id, variantId: variantId || 0,
    warehouseId, stockStatus, stockUomId: ver.stock_uom_id, deltaQty: stockQty, unitCost,
  });

  if (txnType === 'TRANSFER_OUT' && toWarehouseId) {
    await applyStockDelta(conn, {
      companyId: product.company_id, productId: product.id, variantId: variantId || 0,
      warehouseId: toWarehouseId, stockStatus, stockUomId: ver.stock_uom_id,
      deltaQty: stockQtyAbs, unitCost,
    });
  }

  const [ins] = await conn.query(
    `INSERT INTO inventory_transactions
     (company_id, product_id, variant_id, warehouse_id, to_warehouse_id, txn_type, txn_date, stock_status,
      txn_qty, txn_uom_id, stock_qty, stock_uom_id, unit_cost, reference_type, reference_id, reference_no,
      reason_code, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      product.company_id, product.id, variantId, warehouseId, toWarehouseId, txnType, txnDate, stockStatus,
      Math.abs(Number(txnQty)), txnUomId, stockQty, ver.stock_uom_id, unitCost,
      referenceType, referenceId, referenceNo, reasonCode, remarks, ctx.actor,
    ]
  );
  return ins.insertId;
}

async function getStock(ctx, query = {}) {
  ctx.assert('view');
  const where = [ctx.companyFilter('s.company_id').sql];
  const params = [...ctx.companyFilter('s.company_id').params];
  if (query.company_id) { where.push('s.company_id = ?'); params.push(Number(query.company_id)); }
  if (query.product_id) { where.push('s.product_id = ?'); params.push(Number(query.product_id)); }
  if (query.warehouse_id) { where.push('s.warehouse_id = ?'); params.push(Number(query.warehouse_id)); }
  if (query.stock_status) { where.push('s.stock_status = ?'); params.push(String(query.stock_status).toUpperCase()); }
  const [rows] = await pool.query(
    `SELECT s.*, p.sku, p.product_code, u.code AS stock_uom_code, w.code AS warehouse_code
     FROM inventory_stock s
     JOIN products p ON p.id = s.product_id
     JOIN units_of_measure u ON u.id = s.stock_uom_id
     JOIN warehouses w ON w.id = s.warehouse_id
     WHERE ${where.join(' AND ')} AND s.qty <> 0
     ORDER BY p.sku, w.code, s.stock_status`,
    params
  );
  return rows;
}

async function stockLedger(ctx, query = {}) {
  ctx.assert('view');
  const productId = Number(query.product_id);
  if (!productId) throw httpError(400, 'product_id is required');
  await loadProduct(pool, ctx, productId);
  const where = ['t.product_id = ?'];
  const params = [productId];
  if (query.warehouse_id) { where.push('t.warehouse_id = ?'); params.push(Number(query.warehouse_id)); }
  if (query.from) { where.push('t.txn_date >= ?'); params.push(parseDate(query.from, 'from')); }
  if (query.to) { where.push('t.txn_date <= ?'); params.push(parseDate(query.to, 'to')); }
  const [rows] = await pool.query(
    `SELECT t.*, w.code AS warehouse_code, u.code AS txn_uom_code, su.code AS stock_uom_code
     FROM inventory_transactions t
     JOIN warehouses w ON w.id = t.warehouse_id
     JOIN units_of_measure u ON u.id = t.txn_uom_id
     JOIN units_of_measure su ON su.id = t.stock_uom_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.txn_date, t.id`,
    params
  );
  let balance = 0;
  const ledger = rows.map((r) => {
    balance += Number(r.stock_qty);
    return { ...r, running_balance: balance };
  });
  return { product_id: productId, opening: 0, movements: ledger, closing: balance };
}

async function openingStock(ctx, body = {}) {
  ctx.assert('create');
  const product = await loadProduct(pool, ctx, body.product_id);
  const warehouseId = Number(body.warehouse_id);
  if (!warehouseId) throw httpError(400, 'warehouse_id is required');
  const [[wh]] = await pool.query('SELECT id FROM warehouses WHERE id = ? AND company_id = ?', [warehouseId, product.company_id]);
  if (!wh) throw httpError(400, 'warehouse_id not found');
  const qty = Number(body.qty);
  if (!(qty >= 0)) throw httpError(400, 'qty must be >= 0');
  const txnDate = parseDate(body.txn_date || body.effective_date, 'txn_date') || today();
  const txnUomId = Number(body.uom_id || body.stock_uom_id);
  if (!txnUomId) throw httpError(400, 'uom_id is required');
  const stockStatus = (cleanText(body.stock_status) || 'AVAILABLE').toUpperCase();
  const unitCost = body.unit_cost != null ? Number(body.unit_cost) : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const txnId = await postTransaction(conn, ctx, {
      product, warehouseId, txnType: 'OPENING', txnDate, stockStatus,
      txnQty: qty, txnUomId, unitCost, remarks: cleanText(body.reason),
      reasonCode: cleanText(body.reason_code) || 'OPENING', sign: 1,
      variantId: body.variant_id ? Number(body.variant_id) : null,
    });
    if (body.batch_no) {
      await conn.query(
        `INSERT INTO inventory_batches
         (company_id, product_id, warehouse_id, batch_no, lot_no, supplier_batch_ref, mfg_date, expiry_date, qty, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          product.company_id, product.id, warehouseId, cleanText(body.batch_no), cleanText(body.lot_no),
          cleanText(body.supplier_batch_ref), parseDate(body.mfg_date, 'mfg_date'),
          parseDate(body.expiry_date, 'expiry_date'), qty, stockStatus, ctx.actor,
        ]
      );
    }
    if (Array.isArray(body.serial_nos)) {
      for (const sn of body.serial_nos) {
        const serial = cleanText(sn);
        if (!serial) continue;
        await conn.query(
          `INSERT INTO inventory_serial_numbers
           (company_id, product_id, variant_id, serial_no, warehouse_id, status, created_by)
           VALUES (?, ?, ?, ?, ?, 'IN_STOCK', ?)`,
          [product.company_id, product.id, body.variant_id || null, serial, warehouseId, ctx.actor]
        );
      }
    }
    await writeInvAudit(conn, {
      companyId: product.company_id, productId: product.id, warehouseId, action: 'OPENING',
      new: qty, refType: 'inventory_transactions', refId: txnId, actor: ctx.actor, role: ctx.role,
    });
    await conn.commit();
    return { transaction_id: txnId, ...(await getStock(ctx, { product_id: product.id, warehouse_id: warehouseId })) };
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw httpError(409, 'Duplicate batch or serial number');
    throw e;
  } finally {
    conn.release();
  }
}

async function adjustStock(ctx, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, body.product_id);
  const warehouseId = Number(body.warehouse_id);
  const qty = Number(body.qty);
  if (!warehouseId || !Number.isFinite(qty) || qty === 0) throw httpError(400, 'warehouse_id and non-zero qty required');
  const direction = qty > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
  const txnDate = parseDate(body.txn_date, 'txn_date') || today();
  const txnUomId = Number(body.uom_id);
  if (!txnUomId) throw httpError(400, 'uom_id is required');
  if (!cleanText(body.reason_code) && !cleanText(body.reason)) {
    throw httpError(400, 'reason_code or reason is required for adjustments');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const txnId = await postTransaction(conn, ctx, {
      product, warehouseId, txnType: direction, txnDate,
      stockStatus: (cleanText(body.stock_status) || 'AVAILABLE').toUpperCase(),
      txnQty: Math.abs(qty), txnUomId, unitCost: body.unit_cost != null ? Number(body.unit_cost) : null,
      reasonCode: cleanText(body.reason_code), remarks: cleanText(body.reason),
      sign: qty > 0 ? 1 : -1,
    });
    await writeInvAudit(conn, {
      companyId: product.company_id, productId: product.id, warehouseId, action: direction,
      new: qty, refType: 'inventory_transactions', refId: txnId, actor: ctx.actor, role: ctx.role,
      note: cleanText(body.reason),
    });
    await conn.commit();
    return { transaction_id: txnId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function transferStock(ctx, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, body.product_id);
  const fromId = Number(body.from_warehouse_id);
  const toId = Number(body.to_warehouse_id);
  const qty = Number(body.qty);
  if (!fromId || !toId || fromId === toId) throw httpError(400, 'from_warehouse_id and to_warehouse_id required and must differ');
  if (!(qty > 0)) throw httpError(400, 'qty must be positive');
  const txnUomId = Number(body.uom_id);
  const txnDate = parseDate(body.txn_date, 'txn_date') || today();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const txnId = await postTransaction(conn, ctx, {
      product, warehouseId: fromId, toWarehouseId: toId, txnType: 'TRANSFER_OUT', txnDate,
      txnQty: qty, txnUomId, remarks: cleanText(body.reason), sign: -1,
    });
    // Transfer_in leg recorded via to_warehouse on same txn + applyStockDelta already credited to
    await conn.query(
      `INSERT INTO inventory_transactions
       (company_id, product_id, warehouse_id, to_warehouse_id, txn_type, txn_date, stock_status,
        txn_qty, txn_uom_id, stock_qty, stock_uom_id, reference_type, reference_id, remarks, created_by)
       SELECT company_id, product_id, ?, warehouse_id, 'TRANSFER_IN', txn_date, stock_status,
              txn_qty, txn_uom_id, ABS(stock_qty), stock_uom_id, 'inventory_transactions', id, remarks, created_by
       FROM inventory_transactions WHERE id = ?`,
      [toId, txnId]
    );
    await conn.commit();
    return { transaction_id: txnId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function setReorder(ctx, productId, body = {}) {
  ctx.assert('edit');
  const product = await loadProduct(pool, ctx, productId);
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const warehouseId = body.warehouse_id ? Number(body.warehouse_id) : null;
  const [ins] = await pool.query(
    `INSERT INTO product_reorder_settings
     (product_id, warehouse_id, min_stock, max_stock, reorder_level, reorder_qty, safety_stock, effective_from, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      product.id, warehouseId,
      Number(body.min_stock) || 0,
      body.max_stock != null ? Number(body.max_stock) : null,
      body.reorder_level != null ? Number(body.reorder_level) : null,
      body.reorder_qty != null ? Number(body.reorder_qty) : null,
      body.safety_stock != null ? Number(body.safety_stock) : null,
      effectiveDate, ctx.actor,
    ]
  );
  await writeAudit(pool, {
    companyId: product.company_id, productId: product.id, entityType: 'REORDER', entityId: ins.insertId,
    action: 'UPDATED', effectiveDate, actor: ctx.actor, role: ctx.role,
  });
  const [rows] = await pool.query(
    'SELECT * FROM product_reorder_settings WHERE product_id = ? ORDER BY effective_from DESC',
    [product.id]
  );
  return rows;
}

module.exports = {
  moduleContext,
  listWarehouses,
  createWarehouse,
  updateWarehouse,
  getStock,
  stockLedger,
  openingStock,
  adjustStock,
  transferStock,
  setReorder,
  postTransaction,
  VALUATION_METHODS,
};
