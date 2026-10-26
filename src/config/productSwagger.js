/** OpenAPI paths for Product & Item Master (`/api/products`). */
const {
  PRODUCT_CLASSIFICATIONS, PRODUCT_STATUSES, MEDIA_TYPES,
} = require('./productConfig');

const p = (name, where = 'path', schema = { type: 'integer' }, description) => ({
  name, in: where, required: where === 'path', schema, ...(description ? { description } : {}),
});
const q = (name, schema = { type: 'string' }, description) => p(name, 'query', schema, description);
const date = { type: 'string', format: 'date' };
const ok = (d = 'OK') => ({ 200: { description: d } });
const body = (schema, examples) => ({
  required: true,
  content: { 'application/json': { schema, ...(examples ? { examples } : {}) } },
});
const obj = (properties, required) => ({ type: 'object', ...(required ? { required } : {}), properties });
const EFFECTIVE = {
  effective_date: { ...date, description: 'Applies from this date (default today). Form edit updates the latest version.' },
  reason: { type: 'string' },
};

const TAG = '06 Products';
const op = (summary, rest = {}) => ({ tags: [TAG], summary, ...rest });

const SAMPLE_CREATE = {
  company_id: 1,
  sku: 'SKU-ITEM-1590',
  product_code: 'ITM-2026-1590',
  name: 'Havells 2.5 sq mm FR Flame Retardant Wire Red 90m',
  barcode: '890751698910',
  qr_code: 'QR-ITM-1590',
  model_number: 'WHFFDNRA2X50',
  internal_item_code: 'INT-ITM-1590',
  classification: 'FINISHED_GOODS',
  category_id: 1,
  subcategory_id: 2,
  brand: 'Havells',
  manufacturer: 'Havells India Ltd.',
  model: 'Single Core Copper',
  specifications: {
    child_type: 'Single Core Copper',
    summary: '100% Electrolytic Copper, 1100V, FR PVC, 90m Box Roll',
  },
  description: 'House wiring FR flame retardant copper cable.',
  status: 'ACTIVE',
  tag_ids: [],
  gst: {
    code_type: 'HSN',
    hsn_sac: '85360000',
    gst_rate: 18,
    tax_type: 'TAXABLE',
  },
  prices: {
    retail_price: 450,
    purchase_price: 380,
    standard_cost: 350,
  },
  effective_date: '2026-10-23',
  reason: 'Sample product create',
};

const productProps = {
  company_id: { type: 'integer', example: 1 },
  sku: { type: 'string', example: 'SKU-ITEM-1590' },
  product_code: { type: 'string', example: 'ITM-2026-1590' },
  internal_item_code: { type: 'string', example: 'INT-ITM-1590' },
  barcode: { type: 'string', example: '890751698910' },
  qr_code: { type: 'string', example: 'QR-ITM-1590' },
  name: { type: 'string', example: 'Havells 2.5 sq mm FR Flame Retardant Wire Red 90m' },
  model_number: { type: 'string', example: 'WHFFDNRA2X50' },
  classification: { type: 'string', enum: PRODUCT_CLASSIFICATIONS, example: 'FINISHED_GOODS' },
  brand: { type: 'string', example: 'Havells' },
  category_id: { type: 'integer', example: 1, description: 'From GET /api/products/categories' },
  subcategory_id: { type: 'integer', example: 2 },
  manufacturer: { type: 'string', example: 'Havells India Ltd.' },
  model: { type: 'string', example: 'Single Core Copper', description: 'Child specification / type' },
  specifications: {
    type: 'object',
    additionalProperties: true,
    example: { child_type: 'Single Core Copper', summary: '100% Electrolytic Copper, 1100V, FR PVC, 90m Box Roll' },
  },
  description: { type: 'string' },
  technical_attributes: { type: 'object', additionalProperties: true },
  status: { type: 'string', enum: PRODUCT_STATUSES, example: 'ACTIVE' },
  block_purchase: { type: 'boolean' },
  block_sales: { type: 'boolean' },
  tag_ids: { type: 'array', items: { type: 'integer' }, example: [] },
  gst: {
    type: 'object',
    description: 'Optional on create — HSN/SAC + GST (also PUT /api/products/{id}/gst)',
    properties: {
      code_type: { type: 'string', enum: ['HSN', 'SAC'], example: 'HSN' },
      hsn_sac: { type: 'string', example: '85360000' },
      gst_rate: { type: 'number', enum: [0, 5, 12, 18, 28], example: 18 },
      tax_type: { type: 'string', enum: ['TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST', 'ZERO_RATED'], example: 'TAXABLE' },
      cess_rate: { type: 'number' },
    },
  },
  prices: {
    type: 'object',
    description: 'Optional on create — selling / purchase / standard cost (also PUT /api/products/{id}/prices)',
    properties: {
      retail_price: { type: 'number', example: 450, description: 'Selling price' },
      purchase_price: { type: 'number', example: 380, description: 'Purchase cost' },
      wholesale_price: { type: 'number' },
      commercial_price: { type: 'number' },
      standard_cost: { type: 'number', example: 350 },
    },
  },
  ...EFFECTIVE,
};

const variantProps = {
  variant_sku: { type: 'string', example: 'FAN-CEIL-48-WHT' },
  variant_code: { type: 'string' },
  name: { type: 'string', example: 'White 48"' },
  size: { type: 'string' },
  length: { type: 'string' },
  color: { type: 'string' },
  rating: { type: 'string' },
  capacity: { type: 'string' },
  model: { type: 'string' },
  specifications: { type: 'object', additionalProperties: true },
  barcode: { type: 'string' },
  status: { type: 'string', enum: PRODUCT_STATUSES },
  ...EFFECTIVE,
};

function productPaths() {
  const id = p('id');
  return {
    '/api/products/meta': {
      get: op('Classifications, statuses, media types, default category tree, your permissions', { responses: ok() }),
    },
    '/api/products/audit-logs': {
      get: op('Product audit log (append-only)', {
        parameters: [
          q('company_id', { type: 'integer' }), q('action'), q('entity_type'),
          q('page', { type: 'integer' }), q('limit', { type: 'integer' }),
        ],
        responses: ok(),
      }),
    },
    '/api/products/categories': {
      get: op('Multi-level category tree (Wires, Fans, Lights, SPD, PCB, MCB …)', {
        parameters: [q('company_id', { type: 'integer' }), q('as_of', date), q('status')],
        responses: ok(),
      }),
      post: op('Add category or subcategory', {
        requestBody: body(obj({
          company_id: { type: 'integer' }, code: { type: 'string' }, name: { type: 'string' },
          parent_id: { type: 'integer', description: 'Omit for top-level' },
          description: { type: 'string' }, sort_order: { type: 'integer' }, ...EFFECTIVE,
        }, ['company_id', 'code', 'name'])),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/categories/seed': {
      post: op('Seed default electronics categories for a company (idempotent by code)', {
        requestBody: body(obj({ company_id: { type: 'integer' }, ...EFFECTIVE }, ['company_id'])),
        responses: { 201: { description: 'Seeded / existing returned' } },
      }),
    },
    '/api/products/categories/{id}': {
      put: op('Edit category name / status with effective date', {
        parameters: [id],
        requestBody: body(obj({ name: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] }, sort_order: { type: 'integer' }, ...EFFECTIVE })),
        responses: ok(),
      }),
    },
    '/api/products/tags': {
      get: op('Custom tags for filtering / grouping', {
        parameters: [q('company_id', { type: 'integer' })],
        responses: ok(),
      }),
      post: op('Create custom tag', {
        requestBody: body(obj({ company_id: { type: 'integer' }, name: { type: 'string' }, color: { type: 'string' }, reason: { type: 'string' } }, ['company_id', 'name']),
          { sample: { value: { company_id: 1, name: 'Fast movers', color: '#2563eb' } } }),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/tags/{id}': {
      delete: op('Delete custom tag (unlinks from products)', { parameters: [id], responses: ok() }),
    },
    '/api/products': {
      get: op('List products (latest profile as of date)', {
        parameters: [
          q('company_id', { type: 'integer' }), q('as_of', date),
          q('classification', { type: 'string', enum: PRODUCT_CLASSIFICATIONS }),
          q('status', { type: 'string', enum: PRODUCT_STATUSES }),
          q('category_id', { type: 'integer' }), q('brand'), q('tag_id', { type: 'integer' }),
          q('block_purchase'), q('block_sales'), q('search'),
          q('page', { type: 'integer' }), q('limit', { type: 'integer' }),
        ],
        responses: ok(),
      }),
      post: op('Add product (Tab 1+2: identification, classification, GST, prices, tags)', {
        description: 'Create product master. Optional nested `gst` and `prices` are saved with effective_date. Change sku/barcode each try (unique per company). category_id/subcategory_id from GET /categories (seed first if empty).',
        requestBody: body(obj(productProps, ['company_id', 'sku', 'name', 'classification']), {
          wireCable: {
            summary: 'Finished goods — house wire (full form sample)',
            value: SAMPLE_CREATE,
          },
        }),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/{id}': {
      get: op('Product detail — profile, tags, variants, media, version history', {
        parameters: [id, q('as_of', date)],
        responses: ok(),
      }),
      put: op('Edit product identification / profile / status / blocks / tags with effective date', {
        parameters: [id],
        requestBody: body(obj(productProps)),
        responses: ok(),
      }),
    },
    '/api/products/{id}/audit-logs': {
      get: op('Audit log for one product', {
        parameters: [id, q('action'), q('entity_type'), q('page', { type: 'integer' })],
        responses: ok(),
      }),
    },
    '/api/products/{id}/variants': {
      post: op('Add variant (size, length, color, rating, capacity, model …)', {
        parameters: [id],
        requestBody: body(obj(variantProps, ['variant_sku', 'name']), {
          color: { value: { variant_sku: 'FAN-CEIL-48-WHT', name: 'White', color: 'White', size: '48"' } },
        }),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/{id}/variants/{variantId}': {
      put: op('Edit variant with effective date', {
        parameters: [id, p('variantId')],
        requestBody: body(obj(variantProps)),
        responses: ok(),
      }),
    },
    '/api/products/{id}/media': {
      post: op('Upload image / datasheet / tech spec / certificate / manual / warranty', {
        description: `multipart/form-data: field \`file\` (PDF/PNG/JPG/WEBP, max 10 MB) plus media_type (${MEDIA_TYPES.join(', ')}), title, is_primary (images), variant_id, sort_order.`,
        parameters: [id],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: obj({
                file: { type: 'string', format: 'binary' },
                media_type: { type: 'string', enum: MEDIA_TYPES },
                title: { type: 'string' },
                is_primary: { type: 'boolean' },
                variant_id: { type: 'integer' },
                sort_order: { type: 'integer' },
              }, ['file']),
            },
          },
        },
        responses: { 201: { description: 'Uploaded' } },
      }),
    },
    '/api/products/{id}/media/{mediaId}': {
      delete: op('Delete media file', { parameters: [id, p('mediaId')], responses: ok() }),
    },
    '/api/products/{id}/media/{mediaId}/file': {
      get: op('Download / view media file', { parameters: [id, p('mediaId')], responses: ok('Binary file') }),
    },
    // B UOM
    '/api/products/uoms': {
      get: op('B — List system + company UOMs', { parameters: [q('company_id', { type: 'integer' }), q('category')], responses: ok() }),
      post: op('B — Create custom UOM', {
        requestBody: body(obj({
          company_id: { type: 'integer' }, code: { type: 'string' }, name: { type: 'string' },
          category: { type: 'string', enum: ['COUNT', 'WEIGHT', 'VOLUME', 'LENGTH', 'PACKAGING', 'OTHER'] },
          decimal_precision: { type: 'integer', default: 0 },
        }, ['company_id', 'code', 'name'])),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/{id}/conversions': {
      get: op('B — Product unit conversions', { parameters: [id], responses: ok() }),
      post: op('B — Set conversion (e.g. 1 ROLL = 100 MTR)', {
        parameters: [id],
        requestBody: body(obj({
          from_uom_id: { type: 'integer' }, to_uom_id: { type: 'integer' }, factor: { type: 'number', example: 100 },
          ...EFFECTIVE,
        }, ['from_uom_id', 'to_uom_id', 'factor'])),
        responses: { 201: { description: 'Saved' } },
      }),
    },
    // C GST
    '/api/products/{id}/gst': {
      get: op('C — HSN/SAC + GST history', { parameters: [id, q('as_of', date)], responses: ok() }),
      put: op('C — Set HSN/SAC, GST rate, tax type (effective-dated)', {
        parameters: [id],
        requestBody: body(obj({
          code_type: { type: 'string', enum: ['HSN', 'SAC'] }, hsn_sac: { type: 'string', example: '841451' },
          gst_rate: { type: 'number', enum: [0, 5, 12, 18, 28] },
          tax_type: { type: 'string', enum: ['TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST', 'ZERO_RATED'] },
          cess_rate: { type: 'number' }, ...EFFECTIVE,
        }, ['hsn_sac', 'gst_rate'])),
        responses: ok(),
      }),
    },
    // E Pricing
    '/api/products/{id}/prices': {
      get: op('E — Purchase / sell / standard cost history', { parameters: [id, q('as_of', date)], responses: ok() }),
      put: op('E — Set prices (effective-dated)', {
        parameters: [id],
        requestBody: body(obj({
          purchase_price: { type: 'number' }, retail_price: { type: 'number' }, wholesale_price: { type: 'number' },
          commercial_price: { type: 'number' }, standard_cost: { type: 'number' },
          min_margin_percent: { type: 'number' }, discount_percent: { type: 'number' }, ...EFFECTIVE,
        })),
        responses: ok(),
      }),
    },
    '/api/products/{id}/vendors': {
      get: op('D/E — Preferred / alternate vendor mappings', { parameters: [id], responses: ok() }),
      post: op('Map vendor item code, price, lead time', {
        parameters: [id],
        requestBody: body(obj({
          vendor_id: { type: 'integer' }, vendor_item_code: { type: 'string' }, purchase_price: { type: 'number' },
          lead_time_days: { type: 'integer' }, is_preferred: { type: 'boolean' }, ...EFFECTIVE,
        }, ['vendor_id'])),
        responses: { 201: { description: 'Created' } },
      }),
    },
    // D Inventory
    '/api/products/warehouses': {
      get: op('D — Warehouses / stores / racks', { parameters: [q('company_id', { type: 'integer' }), q('as_of', date)], responses: ok() }),
      post: op('D — Add warehouse', {
        requestBody: body(obj({
          company_id: { type: 'integer' }, code: { type: 'string' }, name: { type: 'string' },
          warehouse_type: { type: 'string', example: 'STORE' }, rack_bin: { type: 'string' }, ...EFFECTIVE,
        }, ['company_id', 'code', 'name'])),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/stock': {
      get: op('D — Current stock balances', {
        parameters: [q('company_id', { type: 'integer' }), q('product_id', { type: 'integer' }), q('warehouse_id', { type: 'integer' }), q('stock_status')],
        responses: ok(),
      }),
    },
    '/api/products/stock/ledger': {
      get: op('D — Item stock ledger (immutable movements)', {
        parameters: [q('product_id', { type: 'integer' }), q('warehouse_id', { type: 'integer' }), q('from', date), q('to', date)],
        responses: ok(),
      }),
    },
    '/api/products/stock/opening': {
      post: op('D — Opening stock (+ optional batch / serials)', {
        requestBody: body(obj({
          product_id: { type: 'integer' }, warehouse_id: { type: 'integer' }, qty: { type: 'number' },
          uom_id: { type: 'integer' }, unit_cost: { type: 'number' }, batch_no: { type: 'string' },
          serial_nos: { type: 'array', items: { type: 'string' } }, stock_status: { type: 'string' },
          txn_date: date, reason: { type: 'string' },
        }, ['product_id', 'warehouse_id', 'qty', 'uom_id'])),
        responses: { 201: { description: 'Posted' } },
      }),
    },
    '/api/products/stock/adjust': {
      post: op('D — Stock adjustment (+/-) with reason', {
        requestBody: body(obj({
          product_id: { type: 'integer' }, warehouse_id: { type: 'integer' }, qty: { type: 'number', description: 'Positive = in, negative = out' },
          uom_id: { type: 'integer' }, reason_code: { type: 'string' }, reason: { type: 'string' },
        }, ['product_id', 'warehouse_id', 'qty', 'uom_id'])),
        responses: { 201: { description: 'Posted' } },
      }),
    },
    '/api/products/stock/transfer': {
      post: op('D — Transfer between warehouses', {
        requestBody: body(obj({
          product_id: { type: 'integer' }, from_warehouse_id: { type: 'integer' }, to_warehouse_id: { type: 'integer' },
          qty: { type: 'number' }, uom_id: { type: 'integer' }, reason: { type: 'string' },
        }, ['product_id', 'from_warehouse_id', 'to_warehouse_id', 'qty', 'uom_id'])),
        responses: { 201: { description: 'Posted' } },
      }),
    },
    // G BOM
    '/api/products/boms': {
      get: op('G — List BOMs', { parameters: [q('company_id', { type: 'integer' }), q('product_id', { type: 'integer' })], responses: ok() }),
      post: op('G — Create BOM with components (versioned)', {
        requestBody: body(obj({
          company_id: { type: 'integer' }, product_id: { type: 'integer' }, code: { type: 'string' }, name: { type: 'string' },
          output_qty: { type: 'number', default: 1 }, output_uom_id: { type: 'integer' },
          components: {
            type: 'array',
            items: obj({ product_id: { type: 'integer' }, qty: { type: 'number' }, uom_id: { type: 'integer' }, scrap_percent: { type: 'number' }, is_alternative: { type: 'boolean' } }),
          },
          ...EFFECTIVE,
        }, ['company_id', 'product_id', 'code', 'output_uom_id', 'components'])),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/boms/{id}': {
      get: op('G — BOM detail + components + versions', { parameters: [id, q('as_of', date)], responses: ok() }),
    },
    '/api/products/production-orders': {
      post: op('G — Create production order from BOM', {
        requestBody: body(obj({
          company_id: { type: 'integer' }, bom_id: { type: 'integer' }, warehouse_id: { type: 'integer' },
          qty: { type: 'number' }, order_no: { type: 'string' }, planned_date: date,
        }, ['company_id', 'bom_id', 'warehouse_id', 'qty'])),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/production-orders/{id}': {
      get: op('G — Production order + material requirements', { parameters: [id], responses: ok() }),
    },
    '/api/products/production-orders/{id}/issue': {
      post: op('G — Issue material to production', {
        parameters: [id],
        requestBody: body(obj({ product_id: { type: 'integer' }, qty: { type: 'number' }, uom_id: { type: 'integer' } }, ['product_id', 'qty', 'uom_id'])),
        responses: ok(),
      }),
    },
    '/api/products/production-orders/{id}/return': {
      post: op('G — Return unused material from production', {
        parameters: [id],
        requestBody: body(obj({ product_id: { type: 'integer' }, qty: { type: 'number' }, uom_id: { type: 'integer' } }, ['product_id', 'qty', 'uom_id'])),
        responses: ok(),
      }),
    },
    '/api/products/production-orders/{id}/complete': {
      post: op('G — Complete production → FG receipt (+ optional scrap)', {
        parameters: [id],
        requestBody: body(obj({ qty: { type: 'number' }, unit_cost: { type: 'number' }, scrap_product_id: { type: 'integer' }, scrap_qty: { type: 'number' }, scrap_uom_id: { type: 'integer' } })),
        responses: ok(),
      }),
    },
    // H Attributes
    '/api/products/attribute-defs': {
      get: op('H — Attribute definitions (category-based)', { parameters: [q('company_id', { type: 'integer' }), q('category_id', { type: 'integer' })], responses: ok() }),
      post: op('H — Create attribute (text/number/dropdown/…)', {
        requestBody: body(obj({
          company_id: { type: 'integer' }, code: { type: 'string' }, name: { type: 'string' },
          attribute_type: { type: 'string', enum: ['TEXT', 'NUMBER', 'DECIMAL', 'DROPDOWN', 'MULTI_SELECT', 'DATE', 'CHECKBOX'] },
          options: { type: 'array', items: { type: 'string' } }, category_id: { type: 'integer' }, is_required: { type: 'boolean' },
        }, ['company_id', 'code', 'name', 'attribute_type'])),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/products/{id}/attributes': {
      get: op('H — Product attribute values', { parameters: [id, q('as_of', date)], responses: ok() }),
      put: op('H — Set attribute values', {
        parameters: [id],
        requestBody: body(obj({ values: { type: 'object', additionalProperties: true }, ...EFFECTIVE }, ['values'])),
        responses: ok(),
      }),
    },
    '/api/products/bulk-update': {
      post: op('H — Bulk update tags / reorder levels', {
        requestBody: body(obj({
          company_id: { type: 'integer' }, product_ids: { type: 'array', items: { type: 'integer' } },
          tag_ids: { type: 'array', items: { type: 'integer' } }, min_stock: { type: 'number' }, reorder_level: { type: 'number' },
        }, ['company_id', 'product_ids'])),
        responses: ok(),
      }),
    },
    '/api/products/check-duplicates': {
      post: op('H/K — Duplicate SKU / code / barcode check', {
        requestBody: body(obj({
          company_id: { type: 'integer' }, sku: { type: 'string' }, product_code: { type: 'string' },
          barcode: { type: 'string' }, exclude_id: { type: 'integer' },
        }, ['company_id'])),
        responses: ok(),
      }),
    },
  };
}

function buildProductSwagger() {
  return {
    tags: [
      {
        name: TAG,
        description: 'STEP 5 — Product & Item Master A–K: master, UOM, GST, inventory, pricing, serial/batch/warranty, BOM/production, attributes, history (effective-dated; stock ledger append-only)',
      },
    ],
    paths: productPaths(),
  };
}

module.exports = { buildProductSwagger };
