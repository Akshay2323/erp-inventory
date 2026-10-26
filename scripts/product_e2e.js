/**
 * Product & Item Master (section A) smoke test against a running API.
 * Usage: node scripts/product_e2e.js [baseUrl]
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

function request(method, urlPath, { token, body, form } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    let payload = null;
    if (form) {
      const boundary = `----e2e${Date.now()}`;
      const chunks = [];
      for (const [k, v] of Object.entries(form.fields || {})) {
        chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
      }
      if (form.file) {
        const buf = form.file.buffer;
        chunks.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${form.file.name}"\r\n`
          + `Content-Type: ${form.file.type}\r\n\r\n`
        );
        payload = Buffer.concat([
          Buffer.from(chunks.join('')),
          buf,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
      } else {
        payload = Buffer.from(`${chunks.join('')}--${boundary}--\r\n`);
      }
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      headers['Content-Length'] = payload.length;
    } else if (body !== undefined) {
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
        const raw = Buffer.concat(parts);
        let data = null;
        const ct = res.headers['content-type'] || '';
        if (ct.includes('json')) {
          try { data = JSON.parse(raw.toString('utf8')); } catch { data = raw.toString('utf8'); }
        } else data = raw;
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log(`Product e2e → ${BASE}`);

  const login = await request('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  assert(login.status === 200 && login.data?.token, `login failed: ${login.status}`);
  const token = login.data.token;

  const companies = await request('GET', '/api/companies?include_inactive=1', { token });
  assert(companies.status === 200 && Array.isArray(companies.data), 'list companies');
  const list = companies.data;
  let companyId = list?.[0]?.id;
  if (!companyId) {
    const created = await request('POST', '/api/companies', {
      token,
      body: {
        company_name: 'Product E2E Co',
        email: `prod-e2e-${Date.now()}@example.com`,
        admin_name: 'Product Admin',
        admin_email: `prod-admin-${Date.now()}@example.com`,
        admin_password: 'admin123',
        confirm_password: 'admin123',
        effective_date: '2026-01-01',
      },
    });
    assert(created.status === 201 || created.status === 200, `create company: ${created.status} ${JSON.stringify(created.data)}`);
    companyId = created.data?.id || created.data?.company?.id;
  }
  assert(!!companyId, 'company_id available');

  await request('PUT', `/api/companies/${companyId}`, {
    token, body: { is_active: true, effective_date: '2026-01-01' },
  });

  const meta = await request('GET', '/api/products/meta', { token });
  assert(meta.status === 200 && meta.data?.classifications?.includes('FINISHED_GOODS'), 'meta classifications');
  assert(meta.data?.your_permissions?.includes('products.create'), 'meta permissions');

  const seed = await request('POST', '/api/products/categories/seed', {
    token, body: { company_id: companyId, effective_date: '2026-01-01' },
  });
  assert(seed.status === 201 && seed.data?.tree?.length >= 8, `seed categories: ${seed.status}`);
  const fans = (seed.data.tree || []).find((c) => c.code === 'FANS');
  const ceil = (fans?.children || []).find((c) => c.code === 'FANS-CEIL');
  assert(!!fans && !!ceil, 'Fans / Ceiling Fans present');

  const cats = await request('GET', `/api/products/categories?company_id=${companyId}`, { token });
  assert(cats.status === 200 && cats.data?.flat?.length >= 8, 'list categories');

  const tag = await request('POST', '/api/products/tags', {
    token, body: { company_id: companyId, name: `e2e-${Date.now()}`, color: '#0ea5e9' },
  });
  assert(tag.status === 201 && tag.data?.id, `create tag: ${tag.status}`);
  const tagId = tag.data.id;

  const sku = `E2E-FAN-${Date.now().toString().slice(-8)}`;
  const product = await request('POST', '/api/products', {
    token,
    body: {
      company_id: companyId,
      sku,
      product_code: `PC-${sku}`,
      barcode: `89${Date.now().toString().slice(-11)}`,
      qr_code: `QR-${sku}`,
      name: 'E2E Ceiling Fan 48"',
      classification: 'FINISHED_GOODS',
      brand: 'Orient',
      category_id: fans.id,
      subcategory_id: ceil.id,
      manufacturer: 'Orient Electric',
      model_number: 'OR-CF-48',
      model: 'CF48',
      specifications: { sweep: '1200mm' },
      technical_attributes: { voltage: '230V' },
      description: 'E2E test product',
      status: 'ACTIVE',
      tag_ids: [tagId],
      effective_date: '2026-04-01',
    },
  });
  assert(product.status === 201 && product.data?.id, `create product: ${product.status} ${JSON.stringify(product.data)}`);
  const productId = product.data.id;
  assert(product.data.profile?.classification === 'FINISHED_GOODS', 'classification stored');
  assert(product.data.tags?.some((t) => t.id === tagId), 'tag linked');

  const listP = await request('GET', `/api/products?company_id=${companyId}&search=${sku}`, { token });
  assert(listP.status === 200 && listP.data?.data?.some((p) => p.id === productId), 'list finds product');

  const upd = await request('PUT', `/api/products/${productId}`, {
    token,
    body: {
      status: 'UNDER_DEVELOPMENT',
      block_purchase: true,
      effective_date: '2026-05-01',
      reason: 'Hold purchase while tooling',
    },
  });
  assert(upd.status === 200 && upd.data?.profile?.status === 'UNDER_DEVELOPMENT', 'update status');
  assert(upd.data?.profile?.block_purchase === true, 'block_purchase');

  const variant = await request('POST', `/api/products/${productId}/variants`, {
    token,
    body: {
      variant_sku: `${sku}-WHT`,
      name: 'White 48"',
      color: 'White',
      size: '48"',
      rating: '5 star',
      capacity: '1200mm',
      effective_date: '2026-04-01',
    },
  });
  assert(variant.status === 201 && variant.data?.variants?.length >= 1, `create variant: ${variant.status}`);
  const variantId = variant.data.variants[0].id;

  const vUpd = await request('PUT', `/api/products/${productId}/variants/${variantId}`, {
    token,
    body: { color: 'Ivory', effective_date: '2026-06-01', reason: 'Color rename' },
  });
  assert(vUpd.status === 200, `update variant: ${vUpd.status}`);
  const v = (vUpd.data.variants || []).find((x) => x.id === variantId);
  assert(v?.profile?.color === 'Ivory', 'variant color updated');

  // Minimal 1x1 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const media = await request('POST', `/api/products/${productId}/media`, {
    token,
    form: {
      fields: { media_type: 'IMAGE', title: 'Primary', is_primary: 'true' },
      file: { name: 'dot.png', type: 'image/png', buffer: png },
    },
  });
  assert(media.status === 201 && media.data?.id, `upload media: ${media.status} ${JSON.stringify(media.data)}`);
  const mediaId = media.data.id;

  const file = await request('GET', `/api/products/${productId}/media/${mediaId}/file`, { token });
  assert(file.status === 200 && Buffer.isBuffer(file.data) && file.data.length > 10, 'download media');

  const detail = await request('GET', `/api/products/${productId}`, { token });
  assert(detail.status === 200 && detail.data?.media?.length >= 1, 'detail has media');
  assert(detail.data?.versions?.length >= 1, 'version history');

  const audit = await request('GET', `/api/products/${productId}/audit-logs`, { token });
  assert(audit.status === 200 && audit.data?.total >= 1, 'audit logs');

  const delMedia = await request('DELETE', `/api/products/${productId}/media/${mediaId}`, { token });
  assert(delMedia.status === 200 && delMedia.data?.deleted, 'delete media');

  const filterTag = await request('GET', `/api/products?company_id=${companyId}&tag_id=${tagId}`, { token });
  assert(filterTag.status === 200 && filterTag.data?.data?.some((p) => p.id === productId), 'filter by tag');

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
