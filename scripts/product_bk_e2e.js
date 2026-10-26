/** Product sections B–G smoke test. Usage: node scripts/product_bk_e2e.js [baseUrl] */
require('dotenv').config();
const http = require('http');

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 4001}`;
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed += 1; process.stdout.write('.'); }
  else { failed += 1; failures.push(msg); process.stdout.write('F'); }
}

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log(`Product B–K e2e → ${BASE}`);
  const login = await request('POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' });
  assert(login.status === 200, 'login');
  const token = login.data.token;

  const companies = await request('GET', '/api/companies?include_inactive=1', token);
  const companyId = companies.data?.[0]?.id;
  assert(!!companyId, 'company');
  await request('PUT', `/api/companies/${companyId}`, token, { is_active: true, effective_date: '2026-01-01' });

  const meta = await request('GET', '/api/products/meta', token);
  assert(meta.status === 200 && meta.data.sections?.includes('B_UOM'), 'meta sections');

  const uoms = await request('GET', `/api/products/uoms?company_id=${companyId}`, token);
  assert(uoms.status === 200 && uoms.data?.length >= 17, `uoms seeded (${uoms.data?.length})`);
  const byCode = Object.fromEntries(uoms.data.map((u) => [u.code, u]));
  assert(byCode.PCS && byCode.MTR && byCode.ROLL, 'PCS/MTR/ROLL');

  const wh = await request('POST', '/api/products/warehouses', token, {
    company_id: companyId, code: `WH${Date.now().toString().slice(-6)}`, name: 'Main Store',
    effective_date: '2026-01-01',
  });
  assert(wh.status === 201 && wh.data?.id, `warehouse ${wh.status} ${JSON.stringify(wh.data)}`);
  const warehouseId = wh.data.id;

  const sku = `BK-${Date.now().toString().slice(-8)}`;
  const wireSku = `RM-${Date.now().toString().slice(-8)}`;
  const rm = await request('POST', '/api/products', token, {
    company_id: companyId, sku: wireSku, name: 'Copper Wire RM', classification: 'RAW_MATERIAL',
    stock_uom_id: byCode.MTR.id, purchase_uom_id: byCode.ROLL.id, sales_uom_id: byCode.MTR.id,
    tracking_type: 'BATCH', valuation_method: 'FIFO',
    gst: { code_type: 'HSN', hsn_sac: '7408', gst_rate: 18, tax_type: 'TAXABLE' },
    prices: { purchase_price: 50, standard_cost: 45 },
    conversions: [{ from_uom_id: byCode.ROLL.id, to_uom_id: byCode.MTR.id, factor: 100 }],
    effective_date: '2026-04-01',
  });
  assert(rm.status === 201 && rm.data?.gst?.hsn_sac === '7408', `RM product ${rm.status} ${JSON.stringify(rm.data?.error || rm.data?.gst)}`);
  const rmId = rm.data.id;
  assert(rm.data.conversions?.length >= 1, 'conversion stored');

  const fg = await request('POST', '/api/products', token, {
    company_id: companyId, sku, name: 'Finished Coil Pack', classification: 'FINISHED_GOODS',
    stock_uom_id: byCode.PCS.id, purchase_uom_id: byCode.PCS.id, sales_uom_id: byCode.PCS.id,
    gst: { hsn_sac: '8544', gst_rate: 18, code_type: 'HSN' },
    prices: { retail_price: 500, wholesale_price: 450, standard_cost: 300 },
    effective_date: '2026-04-01',
  });
  assert(fg.status === 201, `FG ${fg.status}`);
  const fgId = fg.data.id;

  const open = await request('POST', '/api/products/stock/opening', token, {
    product_id: rmId, warehouse_id: warehouseId, qty: 2, uom_id: byCode.ROLL.id,
    unit_cost: 4000, batch_no: `B${Date.now().toString().slice(-6)}`, txn_date: '2026-04-01',
  });
  assert(open.status === 201, `opening ${open.status} ${JSON.stringify(open.data)}`);

  const stock = await request('GET', `/api/products/stock?product_id=${rmId}`, token);
  const bal = stock.data?.find((s) => s.warehouse_id === warehouseId);
  assert(stock.status === 200 && bal && Number(bal.qty) === 200, `stock 200 MTR got ${bal?.qty}`);

  const ledger = await request('GET', `/api/products/stock/ledger?product_id=${rmId}`, token);
  assert(ledger.status === 200 && ledger.data?.closing === 200, 'ledger closing');

  const bom = await request('POST', '/api/products/boms', token, {
    company_id: companyId, product_id: fgId, code: `BOM-${sku}`, name: 'Pack BOM',
    output_qty: 1, output_uom_id: byCode.PCS.id,
    components: [{ product_id: rmId, qty: 10, uom_id: byCode.MTR.id, scrap_percent: 5 }],
    effective_date: '2026-04-01',
  });
  assert(bom.status === 201 && bom.data?.components?.length === 1, `bom ${bom.status}`);

  const po = await request('POST', '/api/products/production-orders', token, {
    company_id: companyId, bom_id: bom.data.id, warehouse_id: warehouseId, qty: 2,
  });
  assert(po.status === 201 && po.data?.requirements?.[0]?.required_qty === 21, `PO req ${po.data?.requirements?.[0]?.required_qty}`);

  const issue = await request('POST', `/api/products/production-orders/${po.data.id}/issue`, token, {
    product_id: rmId, qty: 21, uom_id: byCode.MTR.id,
  });
  assert(issue.status === 200, `issue ${issue.status} ${JSON.stringify(issue.data?.error || '')}`);

  const complete = await request('POST', `/api/products/production-orders/${po.data.id}/complete`, token, {
    qty: 2, unit_cost: 300,
  });
  assert(complete.status === 200 && complete.data?.status === 'COMPLETED', `complete ${complete.status}`);

  const fgStock = await request('GET', `/api/products/stock?product_id=${fgId}`, token);
  assert(fgStock.data?.some((s) => Number(s.qty) === 2), 'FG stock 2');

  const attr = await request('POST', '/api/products/attribute-defs', token, {
    company_id: companyId, code: `VOLT${Date.now().toString().slice(-4)}`, name: 'Voltage',
    attribute_type: 'DROPDOWN', options: ['230V', '110V'], is_required: true,
  });
  assert(attr.status === 201, 'attr def');
  const setAttr = await request('PUT', `/api/products/${fgId}/attributes`, token, {
    values: { [attr.data.code]: '230V' }, effective_date: '2026-04-01',
  });
  assert(setAttr.status === 200 && setAttr.data?.length >= 1, 'attr value');

  const dup = await request('POST', '/api/products/check-duplicates', token, {
    company_id: companyId, sku,
  });
  assert(dup.status === 200 && dup.data?.ok === false, 'duplicate detected');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log(' -', f));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
