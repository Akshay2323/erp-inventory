/**
 * Vendor + Sales + Purchases e2e against a running API.
 * Usage: node scripts/vendor_sales_purchase_e2e.js [baseUrl]
 */
require('dotenv').config();
const http = require('http');
const https = require('https');

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 4001}`;
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed += 1; process.stdout.write('.'); }
  else { failed += 1; failures.push(msg); process.stdout.write('F'); }
}

function request(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers,
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8');
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

function stamp() { return Date.now().toString().slice(-8); }

async function main() {
  console.log(`Vendor / Sales / Purchases e2e → ${BASE}`);
  const login = await request('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  assert(login.status === 200 && login.data?.token, `login ${login.status}`);
  const token = login.data.token;
  const t = token;

  const companies = await request('GET', '/api/companies?include_inactive=1', { token: t });
  assert(companies.status === 200 && Array.isArray(companies.data), 'list companies');
  let companyId = companies.data?.[0]?.id;
  if (!companyId) {
    const created = await request('POST', '/api/companies', {
      token: t,
      body: {
        company_name: 'VSP E2E Co',
        email: `vsp-${stamp()}@example.com`,
        admin_name: 'VSP Admin',
        admin_email: `vsp-admin-${stamp()}@example.com`,
        admin_password: 'admin123',
        confirm_password: 'admin123',
        effective_date: '2026-04-01',
      },
    });
    assert(created.status === 201 || created.status === 200, `create company ${created.status}`);
    companyId = created.data?.id;
  }
  assert(!!companyId, 'company_id');
  await request('PUT', `/api/companies/${companyId}`, {
    token: t, body: { is_active: true, effective_date: '2026-04-01' },
  });

  // ---- Accounting setup ----
  let setup = await request('POST', `/api/accounting/companies/${companyId}/setup`, {
    token: t,
    body: {
      books_start_date: '2026-04-01',
      fy_start_month: 4,
      state_code: '27',
      gstin: '27AAPFU0939F1ZV',
      trade_name: 'VSP E2E Co',
      city: 'Mumbai',
      pincode: '400001',
      reason: 'e2e setup',
    },
  });
  if (setup.status === 409) {
    setup = { status: 200, data: { already: true } };
  }
  assert(setup.status === 201 || setup.status === 200, `books setup ${setup.status} ${JSON.stringify(setup.data?.error || '')}`);

  const addr = {
    address_type: 'REGISTERED',
    line1: '12 Test Road',
    city: 'Mumbai',
    state: 'Maharashtra',
    state_code: '27',
    pincode: '400001',
    country: 'India',
    is_default: true,
    effective_date: '2026-04-01',
  };

  // ---- Vendor ----
  const vCode = `VN-E2E-${stamp()}`;
  const vendorBody = {
    company_id: companyId,
    code: vCode,
    vendor_type: 'MANUFACTURER',
    name: `E2E Vendor ${stamp()}`,
    legal_name: 'E2E Vendor Pvt Ltd',
    mobile: '9876501234',
    email: `vendor.e2e.${stamp()}@test.local`,
    gstin: '27AABCV9999A1ZU',
    pan: 'AABCV9999A',
    gst_registration_type: 'REGULAR',
    state_code: '27',
    place_of_supply: '27',
    tax_treatment: 'TAXABLE',
    status: 'ACTIVE',
    acknowledge_duplicates: true,
    effective_date: '2026-04-01',
    addresses: [{ ...addr, address_type: 'REGISTERED' }, { ...addr, address_type: 'BILLING', is_default: true }],
    financial: {
      credit_period_days: 30,
      opening_balance: 0,
      opening_balance_type: 'CR',
      effective_date: '2026-04-01',
    },
  };
  let vendor = await request('POST', '/api/vendors', { token: t, body: vendorBody });
  if (vendor.status === 409) {
    // GSTIN clash — reuse list match
    const list = await request('GET', `/api/vendors?company_id=${companyId}&search=AABCV9999A`, { token: t });
    const existing = list.data?.data?.[0];
    assert(!!existing, `vendor create conflict, no reuse ${vendor.status} ${JSON.stringify(vendor.data)}`);
    vendor = { status: 200, data: existing };
  } else {
    assert(vendor.status === 201 || vendor.status === 202, `create vendor ${vendor.status} ${JSON.stringify(vendor.data?.error || vendor.data)}`);
  }
  const vendorId = vendor.data.id;

  const vList = await request('GET', `/api/vendors?company_id=${companyId}`, { token: t });
  assert(vList.status === 200 && vList.data?.data?.some((v) => v.id === vendorId), 'vendor in list');

  const kyc = await request('PUT', `/api/vendors/${vendorId}`, {
    token: t,
    body: { kyc_status: 'VERIFIED', kyc_remarks: 'e2e ok', reason: 'e2e' },
  });
  assert(kyc.status === 200 && kyc.data?.kyc_status === 'VERIFIED', `vendor kyc ${kyc.status} ${kyc.data?.error || kyc.data?.kyc_status}`);

  const kycReject = await request('PUT', `/api/vendors/${vendorId}`, {
    token: t,
    body: { kycStatus: 'REJECTED', kycRemarks: 'temp reject' },
  });
  assert(kycReject.status === 200 && kycReject.data?.kyc_status === 'REJECTED', 'vendor kyc camelCase REJECTED');

  await request('PUT', `/api/vendors/${vendorId}`, {
    token: t, body: { kyc_status: 'VERIFIED', reason: 'restore' },
  });

  const vGet = await request('GET', `/api/vendors/${vendorId}`, { token: t });
  assert(vGet.status === 200 && vGet.data?.kyc_status === 'VERIFIED', 'vendor detail kyc');

  // ---- Client (for sales) ----
  const clientBody = {
    company_id: companyId,
    code: `CL-E2E-${stamp()}`,
    category: 'COMMERCIAL',
    name: `E2E Client ${stamp()}`,
    legal_name: 'E2E Client Pvt Ltd',
    mobile: '9876509876',
    email: `client.e2e.${stamp()}@test.local`,
    gstin: '27AAPFU0939F1ZV',
    pan: 'AAPFU0939F',
    gst_registration_type: 'REGULAR',
    state_code: '27',
    place_of_supply: '27',
    tax_treatment: 'TAXABLE',
    status: 'ACTIVE',
    acknowledge_duplicates: true,
    effective_date: '2026-04-01',
    addresses: [
      { ...addr, address_type: 'BILLING', is_default: true },
      { ...addr, address_type: 'SHIPPING', is_default: true },
    ],
    financial: {
      credit_limit: 500000,
      credit_period_days: 30,
      opening_balance: 0,
      opening_balance_type: 'DR',
      effective_date: '2026-04-01',
    },
  };
  let client = await request('POST', '/api/clients', { token: t, body: clientBody });
  if (client.status === 409) {
    const list = await request('GET', `/api/clients?company_id=${companyId}&search=AAPFU0939F`, { token: t });
    const existing = list.data?.data?.[0];
    assert(!!existing, `client create conflict ${client.status}`);
    client = { status: 200, data: existing };
  } else {
    assert(client.status === 201 || client.status === 202, `create client ${client.status} ${JSON.stringify(client.data?.error || '')}`);
  }
  const clientId = client.data.id;

  // Ensure client/vendor approved if pending
  if (client.data.approval_status === 'PENDING') {
    await request('POST', `/api/clients/${clientId}/approval`, {
      token: t, body: { action: 'APPROVE', remarks: 'e2e' },
    });
  }
  if (vendor.data.approval_status === 'PENDING' || vGet.data?.approval_status === 'PENDING') {
    await request('POST', `/api/vendors/${vendorId}/approval`, {
      token: t, body: { action: 'APPROVE', remarks: 'e2e' },
    });
  }

  // ---- Sales invoice ----
  const salesInv = await request('POST', '/api/sales/vouchers', {
    token: t,
    body: {
      company_id: companyId,
      voucher_type: 'SALES_INVOICE',
      client_id: clientId,
      voucher_date: '2026-10-15',
      place_of_supply: '27',
      lines: [
        {
          description: 'E2E Copper Wire 1.5sqmm',
          hsn_sac: '8544',
          qty: 10,
          unit: 'MTR',
          rate: 100,
          gst_rate: 18,
        },
      ],
    },
  });
  assert(salesInv.status === 201, `sales invoice ${salesInv.status} ${JSON.stringify(salesInv.data?.error || salesInv.data)}`);
  const salesId = salesInv.data?.id || salesInv.data?.voucher?.id;
  assert(!!salesId, 'sales invoice id');
  assert(Number(salesInv.data?.total_amount || salesInv.data?.voucher?.total_amount) > 0, 'sales total > 0');

  const salesList = await request('GET', `/api/sales/vouchers?company_id=${companyId}`, { token: t });
  assert(salesList.status === 200, `sales list ${salesList.status} ${JSON.stringify(salesList.data?.error || '')}`);
  const salesRows = salesList.data?.data || salesList.data?.vouchers || [];
  assert(Array.isArray(salesRows) && salesRows.some((v) => v.id === salesId), 'sales invoice in list');

  const salesGet = await request('GET', `/api/sales/vouchers/${salesId}`, { token: t });
  assert(salesGet.status === 200, 'sales get');

  // Receipt against invoice
  const receipt = await request('POST', '/api/sales/vouchers', {
    token: t,
    body: {
      company_id: companyId,
      voucher_type: 'RECEIPT',
      client_id: clientId,
      voucher_date: '2026-10-16',
      amount: 500,
      payment_mode: 'NEFT',
      instrument_no: `UTR${stamp()}`,
      auto_allocate: true,
    },
  });
  assert(receipt.status === 201, `receipt ${receipt.status} ${JSON.stringify(receipt.data?.error || '')}`);

  // ---- Purchase invoice ----
  const purInv = await request('POST', '/api/purchases/vouchers', {
    token: t,
    body: {
      company_id: companyId,
      voucher_type: 'PURCHASE_INVOICE',
      vendor_id: vendorId,
      voucher_date: '2026-10-15',
      reference_no: `SUP/${stamp()}`,
      reference_date: '2026-10-14',
      place_of_supply: '27',
      lines: [
        {
          description: 'E2E Raw Copper',
          hsn_sac: '7408',
          qty: 50,
          unit: 'KG',
          rate: 800,
          gst_rate: 18,
          itc_eligible: true,
        },
      ],
    },
  });
  assert(purInv.status === 201, `purchase invoice ${purInv.status} ${JSON.stringify(purInv.data?.error || '')}`);
  const purId = purInv.data?.id || purInv.data?.voucher?.id;
  assert(!!purId, 'purchase invoice id');

  const purList = await request('GET', `/api/purchases/vouchers?company_id=${companyId}`, { token: t });
  assert(purList.status === 200, `purchase list ${purList.status} ${JSON.stringify(purList.data?.error || '')}`);
  const purRows = purList.data?.data || purList.data?.vouchers || [];
  assert(Array.isArray(purRows) && purRows.some((v) => v.id === purId), 'purchase invoice in list');

  const payment = await request('POST', '/api/purchases/vouchers', {
    token: t,
    body: {
      company_id: companyId,
      voucher_type: 'PAYMENT',
      vendor_id: vendorId,
      voucher_date: '2026-10-16',
      amount: 1000,
      payment_mode: 'NEFT',
      instrument_no: `PAY${stamp()}`,
      auto_allocate: true,
    },
  });
  assert(payment.status === 201, `payment ${payment.status} ${JSON.stringify(payment.data?.error || '')}`);

  // Reports smoke
  const outstanding = await request('GET', `/api/sales/outstanding?company_id=${companyId}`, { token: t });
  assert(outstanding.status === 200, `sales outstanding ${outstanding.status}`);
  const payables = await request('GET', `/api/purchases/payables?company_id=${companyId}`, { token: t });
  assert(payables.status === 200, `purchase payables ${payables.status}`);

  const vMeta = await request('GET', '/api/vendors/meta', { token: t });
  assert(vMeta.status === 200 && vMeta.data?.your_permissions?.includes('vendors.view'), 'vendor meta');
  const sMeta = await request('GET', '/api/sales/meta', { token: t });
  assert(sMeta.status === 200, 'sales meta');
  const pMeta = await request('GET', '/api/purchases/meta', { token: t });
  assert(pMeta.status === 200, 'purchases meta');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(' -', f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
