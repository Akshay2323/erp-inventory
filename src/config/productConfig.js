/**
 * Product & Item Master — sections A–K definitions.
 */

const PRODUCT_CLASSIFICATIONS = [
  'RAW_MATERIAL', 'COMPONENT', 'SEMI_FINISHED', 'FINISHED_GOODS',
  'TRADING_GOODS', 'CONSUMABLES', 'SPARE_PARTS', 'PACKAGING', 'SERVICES',
];

/** Frontend item type (step 1): Product/Goods uses HSN; Service uses SAC. */
const ITEM_TYPES = ['PRODUCT', 'SERVICE'];

const PRODUCT_STATUSES = [
  'ACTIVE', 'INACTIVE', 'DISCONTINUED', 'UNDER_DEVELOPMENT',
];

const MEDIA_TYPES = [
  'IMAGE', 'DATASHEET', 'TECHNICAL_SPEC', 'CERTIFICATE', 'MANUAL', 'WARRANTY', 'OTHER',
];

const UOM_CATEGORIES = ['COUNT', 'WEIGHT', 'VOLUME', 'LENGTH', 'PACKAGING', 'OTHER'];

/** Predefined units (section B.1) — seeded system-wide (company_id NULL). */
const PREDEFINED_UOMS = [
  { code: 'PCS', name: 'Pieces', category: 'COUNT', decimal_precision: 0 },
  { code: 'NOS', name: 'Nos', category: 'COUNT', decimal_precision: 0 },
  { code: 'UNIT', name: 'Units', category: 'COUNT', decimal_precision: 0 },
  { code: 'HR', name: 'Hours', category: 'COUNT', decimal_precision: 2 },
  { code: 'DAY', name: 'Days', category: 'COUNT', decimal_precision: 2 },
  { code: 'KG', name: 'Kilograms', category: 'WEIGHT', decimal_precision: 3 },
  { code: 'GM', name: 'Grams', category: 'WEIGHT', decimal_precision: 3 },
  { code: 'LTR', name: 'Liters', category: 'VOLUME', decimal_precision: 3 },
  { code: 'ML', name: 'Milliliters', category: 'VOLUME', decimal_precision: 3 },
  { code: 'MTR', name: 'Meters', category: 'LENGTH', decimal_precision: 3 },
  { code: 'MM', name: 'Millimeters', category: 'LENGTH', decimal_precision: 2 },
  { code: 'CM', name: 'Centimeters', category: 'LENGTH', decimal_precision: 2 },
  { code: 'FT', name: 'Feet', category: 'LENGTH', decimal_precision: 3 },
  { code: 'ROLL', name: 'Rolls', category: 'PACKAGING', decimal_precision: 0 },
  { code: 'BOX', name: 'Boxes', category: 'PACKAGING', decimal_precision: 0 },
  { code: 'PACK', name: 'Packs', category: 'PACKAGING', decimal_precision: 0 },
  { code: 'SET', name: 'Sets', category: 'PACKAGING', decimal_precision: 0 },
  { code: 'BUNDLE', name: 'Bundles', category: 'PACKAGING', decimal_precision: 0 },
  { code: 'COIL', name: 'Coils', category: 'PACKAGING', decimal_precision: 0 },
];

const GST_RATES = [0, 5, 12, 18, 28];
const TAX_TYPES = ['TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST', 'ZERO_RATED'];
const HSN_SAC_TYPES = ['HSN', 'SAC'];

const STOCK_STATUSES = [
  'AVAILABLE', 'RESERVED', 'ALLOCATED', 'IN_TRANSIT', 'DAMAGED', 'REJECTED', 'QUARANTINED',
];

const STOCK_TXN_TYPES = [
  'OPENING', 'PURCHASE_RECEIPT', 'SALES', 'SALES_RETURN', 'PURCHASE_RETURN',
  'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
  'PRODUCTION_ISSUE', 'PRODUCTION_RETURN', 'PRODUCTION_RECEIPT', 'SCRAP',
];

const VALUATION_METHODS = ['FIFO', 'WEIGHTED_AVERAGE', 'STANDARD_COST'];
const TRACKING_TYPES = ['NONE', 'SERIAL', 'BATCH', 'SERIAL_AND_BATCH'];
const PRICE_TYPES = ['PURCHASE', 'RETAIL', 'WHOLESALE', 'COMMERCIAL', 'STANDARD_COST', 'CUSTOMER'];

const ATTRIBUTE_TYPES = ['TEXT', 'NUMBER', 'DECIMAL', 'DROPDOWN', 'MULTI_SELECT', 'DATE', 'CHECKBOX'];

const SUGGESTED_TAGS = [
  'High Voltage', 'Low Voltage', 'Copper', 'Aluminium', 'Indoor', 'Outdoor',
  'Industrial', 'Domestic', 'Imported', 'Local',
];

const DEFAULT_CATEGORY_TREE = [
  {
    code: 'WIRES', name: 'Wires',
    children: [
      { code: 'WIRES-CU', name: 'Copper Wires' },
      { code: 'WIRES-AL', name: 'Aluminium Wires' },
      { code: 'WIRES-FLEX', name: 'Flexible Cables' },
      { code: 'WIRES-HOUSE', name: 'House Wires' },
      { code: 'WIRES-FR', name: 'House Wires (FR/FRLS/ZHFR)' },
    ],
  },
  {
    code: 'FANS', name: 'Fans',
    children: [
      { code: 'FANS-CEIL', name: 'Ceiling Fans' },
      { code: 'FANS-EXH', name: 'Exhaust Fans' },
      { code: 'FANS-TBL', name: 'Table Fans' },
      { code: 'FANS-HOUSE', name: 'House Fans' },
    ],
  },
  {
    code: 'LIGHTS', name: 'Lights',
    children: [
      { code: 'LIGHTS-LED', name: 'LED Lights' },
      { code: 'LIGHTS-PANEL', name: 'Panel Lights' },
      { code: 'LIGHTS-STREET', name: 'Street Lights' },
    ],
  },
  {
    code: 'SPD', name: 'SPD',
    children: [
      { code: 'SPD-TYPE1', name: 'Type 1 SPD' },
      { code: 'SPD-TYPE2', name: 'Type 2 SPD' },
    ],
  },
  {
    code: 'PCB', name: 'PCB',
    children: [
      { code: 'PCB-CTRL', name: 'Control PCB' },
      { code: 'PCB-PWR', name: 'Power PCB' },
    ],
  },
  {
    code: 'MCB', name: 'MCB',
    children: [
      { code: 'MCB-1P', name: 'Single Pole MCB' },
      { code: 'MCB-2P', name: 'Double Pole MCB' },
      { code: 'MCB-3P', name: 'Triple Pole MCB' },
    ],
  },
  {
    code: 'ELEC-COMP', name: 'Electrical Components',
    children: [
      { code: 'ELEC-SW', name: 'Switches' },
      { code: 'ELEC-SKT', name: 'Sockets' },
      { code: 'ELEC-RELAY', name: 'Relays' },
    ],
  },
  {
    code: 'ELECTRONICS', name: 'Electronics',
    children: [
      { code: 'ELEC-IC', name: 'ICs' },
      { code: 'ELEC-SMD', name: 'SMD Components' },
      { code: 'ELEC-CONN', name: 'Connectors' },
    ],
  },
];

const PRODUCT_VERSION_FIELDS = {
  name: { type: 'text', max: 255, required: true },
  model_number: { type: 'text', max: 100 },
  item_type: { type: 'enum', values: ITEM_TYPES, default: 'PRODUCT' },
  classification: { type: 'enum', values: PRODUCT_CLASSIFICATIONS, required: true },
  brand: { type: 'text', max: 120 },
  brand_id: { type: 'int' },
  category_id: { type: 'int' },
  subcategory_id: { type: 'int' },
  manufacturer: { type: 'text', max: 255 },
  model: { type: 'text', max: 120 },
  specifications: { type: 'json' },
  description: { type: 'text', max: 5000 },
  technical_attributes: { type: 'json' },
  status: { type: 'enum', values: PRODUCT_STATUSES, default: 'ACTIVE' },
  block_purchase: { type: 'bool', default: 0 },
  block_sales: { type: 'bool', default: 0 },
  tracking_type: { type: 'enum', values: TRACKING_TYPES, default: 'NONE' },
  valuation_method: { type: 'enum', values: VALUATION_METHODS, default: 'WEIGHTED_AVERAGE' },
  warranty_months: { type: 'int' },
  stock_uom_id: { type: 'int' },
  purchase_uom_id: { type: 'int' },
  sales_uom_id: { type: 'int' },
};

const VARIANT_VERSION_FIELDS = {
  name: { type: 'text', max: 255, required: true },
  size: { type: 'text', max: 80 },
  length: { type: 'text', max: 80 },
  color: { type: 'text', max: 80 },
  rating: { type: 'text', max: 80 },
  capacity: { type: 'text', max: 80 },
  model: { type: 'text', max: 120 },
  specifications: { type: 'json' },
  barcode: { type: 'text', max: 80 },
  status: { type: 'enum', values: PRODUCT_STATUSES, default: 'ACTIVE' },
};

const GST_VERSION_FIELDS = {
  code_type: { type: 'enum', values: HSN_SAC_TYPES, required: true },
  hsn_sac: { type: 'text', max: 16, required: true },
  gst_rate: { type: 'enum', values: GST_RATES.map(String), required: true },
  tax_type: { type: 'enum', values: TAX_TYPES, default: 'TAXABLE' },
  cess_rate: { type: 'text', max: 20 },
};

const PRICE_VERSION_FIELDS = {
  purchase_price: { type: 'text', max: 40 },
  retail_price: { type: 'text', max: 40 },
  wholesale_price: { type: 'text', max: 40 },
  commercial_price: { type: 'text', max: 40 },
  standard_cost: { type: 'text', max: 40 },
  currency: { type: 'text', max: 8, default: 'INR' },
  min_margin_percent: { type: 'text', max: 20 },
  discount_percent: { type: 'text', max: 20 },
  max_price_discount: { type: 'text', max: 40 },
};

module.exports = {
  PRODUCT_CLASSIFICATIONS,
  ITEM_TYPES,
  PRODUCT_STATUSES,
  MEDIA_TYPES,
  UOM_CATEGORIES,
  PREDEFINED_UOMS,
  GST_RATES,
  TAX_TYPES,
  HSN_SAC_TYPES,
  STOCK_STATUSES,
  STOCK_TXN_TYPES,
  VALUATION_METHODS,
  TRACKING_TYPES,
  PRICE_TYPES,
  ATTRIBUTE_TYPES,
  SUGGESTED_TAGS,
  DEFAULT_CATEGORY_TREE,
  PRODUCT_VERSION_FIELDS,
  VARIANT_VERSION_FIELDS,
  GST_VERSION_FIELDS,
  PRICE_VERSION_FIELDS,
};
