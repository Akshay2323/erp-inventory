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

const SAMPLE_PRODUCT_HSN = {
  company_id: 1,
  item_type: 'PRODUCT',
  branch: 'HO',
  sku: 'SKU-ITEM-2994',
  product_code: 'ITM-2026-2994',
  name: 'Havells 2.5 sq mm FR Flame Retardant Wire Red 90m Box Roll',
  barcode: '890167827315',
  qr_code: 'QR-ITM-2994',
  model_number: 'WHFFDNRA2X50',
  internal_item_code: 'INT-ITM-2994',
  classification: 'FINISHED_GOODS',
  category: 'Wires',
  subcategory: 'Copper Wires',
  brand: 'Havells',
  manufacturer: 'Havells India Ltd.',
  child_type: 'Single Core Copper',
  spec_summary: '100% Electrolytic Copper, 1100V, FR PVC, 90m Box Roll',
  description: 'House wiring FR flame retardant copper cable.',
  status: 'ACTIVE',
  stock_uom: 'MTR',
  opening_qty: 100,
  reorder_level: 20,
  sellable: true,
  tags: ['High-Demand'],
  // Flat 6-step form fields (also accept nested gst / prices)
  hsn: '85369090',
  gst_rate: 18,
  purchase_cost: 1450,
  mrp: 1850,
  sale_price: 1600,
  max_discount_percent: 5,
  max_price_discount: 50,
  effective_date: '2026-10-28',
  reason: 'Product (Goods) Havells wire onboarding sample',
};

const SAMPLE_SERVICE_SAC = {
  company_id: 1,
  item_type: 'SERVICE',
  sku: 'SRV-INSTALL-001',
  name: 'Electrical Cabling and Installation Service',
  classification: 'SERVICES',
  category: 'Wires',
  description: 'On-site industrial cable routing and termination service.',
  status: 'ACTIVE',
  sellable: true,
  tags: ['Industrial'],
  // Flat 6-step form fields (also accept nested gst / prices)
  sac: '998313',
  gst_rate: 18,
  sale_price: 1500,
  purchase_cost: 1000,
  uom: 'Hours',
  effective_date: '2026-10-23',
  reason: 'Service item with SAC create sample',
};

const SAMPLE_CREATE = SAMPLE_PRODUCT_HSN;

const productProps = {
  company_id: { type: 'integer', example: 1 },
  branch: { type: 'string', example: 'HO', description: 'Dynamic branch assignment: branch code (e.g. "HO" for Head Office), branch name, or "All Branches / Main Store (Company-wide)"' },
  branch_id: { type: 'integer', example: null, description: 'Direct Branch ID (optional: null = All Branches / Company-wide)' },
  item_type: { type: 'string', enum: ['PRODUCT', 'SERVICE'], example: 'PRODUCT', description: 'Item type: PRODUCT (Goods) or SERVICE' },
  sku: { type: 'string', example: 'SKU-ITEM-1590' },
  product_code: { type: 'string', example: 'ITM-2026-1590' },
  internal_item_code: { type: 'string', example: 'INT-ITM-1590' },
  barcode: { type: 'string', example: '890751698910' },
  qr_code: { type: 'string', example: 'QR-ITM-1590' },
  name: { type: 'string', example: 'Havells 2.5 sq mm FR Flame Retardant Wire Red 90m' },
  model_number: { type: 'string', example: 'WHFFDNRA2X50' },
  classification: { type: 'string', enum: PRODUCT_CLASSIFICATIONS, example: 'FINISHED_GOODS' },
  brand: { type: 'string', example: 'Havells' },
  category: { type: 'string', example: 'Wires', description: 'Category id, code or name' },
  subcategory: { type: 'string', example: 'Copper Wires', description: 'Subcategory id, code or name' },
  category_id: { type: 'integer', example: 1, description: 'From GET /api/products/categories' },
  subcategory_id: { type: 'integer', example: 2 },
  manufacturer: { type: 'string', example: 'Havells India Ltd.' },
  child_type: { type: 'string', example: 'Single Core Copper' },
  model: { type: 'string', example: 'Single Core Copper', description: 'Child specification / type' },
  spec_summary: { type: 'string', example: '100% Electrolytic Copper, 1100V, FR PVC, 90m Box Roll' },
  specifications: {
    type: 'object',
    additionalProperties: true,
    example: { child_type: 'Single Core Copper', summary: '100% Electrolytic Copper, 1100V, FR PVC, 90m Box Roll' },
  },
  description: { type: 'string' },
  technical_attributes: { type: 'object', additionalProperties: true },
  status: { type: 'string', enum: PRODUCT_STATUSES, example: 'ACTIVE' },
  sellable: { type: 'boolean', example: true, description: 'Sellable toggle (maps to block_sales=0)' },
  block_purchase: { type: 'boolean' },
  block_sales: { type: 'boolean' },
  uom: { type: 'string', example: 'Meters', description: 'UOM id, code or name (e.g. Meters, Hours, PCS). Alias: stock_uom' },
  stock_uom: { type: 'string', example: 'MTR', description: 'Alias of uom / stock_uom_id (frontend step 4)' },
  stock_uom_id: { type: 'integer', example: 10 },
  hsn: { type: 'string', example: '85369090', description: 'PRODUCT only — maps to gst.code_type=HSN + gst.hsn_sac' },
  sac: { type: 'string', example: '998313', description: 'SERVICE only — maps to gst.code_type=SAC + gst.hsn_sac (6 digits)' },
  hsn_code: { type: 'string', example: '85369090' },
  sac_code: { type: 'string', example: '998313' },
  gst_rate: { type: 'number', enum: [0, 5, 12, 18, 28], example: 18, description: 'Top-level GST % (also nested under gst.gst_rate)' },
  purchase_cost: { type: 'number', example: 1450, description: 'Step 2 purchase cost → prices.purchase_price' },
  mrp: { type: 'number', example: 1850, description: 'Step 2 MRP → prices.retail_price' },
  sale_price: { type: 'number', example: 1600, description: 'Step 2 sale price → prices.wholesale_price' },
  max_discount_percent: { type: 'number', example: 15 },
  max_price_discount: { type: 'number', example: 50 },
  opening_qty: { type: 'number', example: 100, description: 'Opening stock quantity (Product only; ignored for SERVICE)' },
  reorder_level: { type: 'number', example: 20, description: 'Reorder stock level (Product only; ignored for SERVICE)' },
  tags: { type: 'array', items: { type: 'string' }, example: ['Copper', 'High Voltage'] },
  tag_ids: { type: 'array', items: { type: 'integer' }, example: [] },
  gst: {
    type: 'object',
    description: 'Optional on create — HSN (PRODUCT) or SAC (SERVICE) + GST rate. Prefer top-level hsn/sac + gst_rate from the 6-step form.',
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
      retail_price: { type: 'number', example: 450, description: 'Selling price / MRP' },
      purchase_price: { type: 'number', example: 380, description: 'Purchase cost' },
      wholesale_price: { type: 'number' },
      commercial_price: { type: 'number' },
      standard_cost: { type: 'number', example: 350 },
      max_price_discount: { type: 'number', example: 50 },
      discount_percent: { type: 'number', example: 10 },
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
    // /api/products/categories/seed — hidden from Swagger (internal only)
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
      post: op('Add product or service (6-step form: identification, classification, GST, prices, inventory, tags)', {
        description: 'Create product (Goods) with HSN or Service with SAC. Supports camelCase and snake_case keys. Nested `gst` and `prices` are saved with effective_date.',
        requestBody: body(obj(productProps, ['company_id', 'sku', 'name']), {
          productHsn: {
            summary: 'Product (Goods) + HSN example (6-step form)',
            value: SAMPLE_PRODUCT_HSN,
          },
          serviceSac: {
            summary: 'Service + SAC example (6-step form)',
            value: SAMPLE_SERVICE_SAC,
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
      delete: op('Delete product (soft → INACTIVE; hard=true permanent if unused)', {
        description: 'Default soft-delete sets status=INACTIVE and blocks purchase/sales. Pass `hard: true` (body or query) to permanently remove only when there is no stock / inventory history / BOM link.',
        parameters: [
          id,
          q('hard', { type: 'boolean' }, 'Permanent delete if unused'),
          q('effective_date', date),
          q('reason'),
        ],
        requestBody: body(obj({
          hard: { type: 'boolean', example: false },
          reason: { type: 'string', example: 'Removed from catalogue' },
          effective_date: date,
        })),
        responses: {
          200: { description: 'Deleted (soft or hard)' },
          409: { description: 'Hard delete blocked — stock or history exists' },
        },
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