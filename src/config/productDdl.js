/** Product & Item Master tables (A–K) + append-only audit triggers. */

function appendOnlyTriggers(table) {
  return ['UPDATE', 'DELETE'].map((op) => `
CREATE TRIGGER IF NOT EXISTS trg_${table}_no_${op.toLowerCase()}
BEFORE ${op} ON ${table} FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only (protected audit history)';`).join('\n');
}

const PRODUCT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS product_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  parent_id INT NULL,
  code VARCHAR(40) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_cat_company_code (company_id, code),
  INDEX idx_product_cat_parent (company_id, parent_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (parent_id) REFERENCES product_categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_category_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(1000) NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_cat_eff (category_id, effective_from),
  FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_brands (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_brand (company_id, code),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS product_tags (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  name VARCHAR(80) NOT NULL,
  color VARCHAR(20) NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_tag_company_name (company_id, name),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS units_of_measure (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NULL COMMENT 'NULL = system predefined',
  code VARCHAR(20) NOT NULL,
  name VARCHAR(80) NOT NULL,
  category VARCHAR(20) NOT NULL DEFAULT 'OTHER',
  decimal_precision TINYINT NOT NULL DEFAULT 0,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_uom_company_code (company_id, code),
  INDEX idx_uom_system (is_system, code)
);

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  sku VARCHAR(60) NOT NULL,
  product_code VARCHAR(60) NOT NULL,
  internal_item_code VARCHAR(60) NULL,
  barcode VARCHAR(80) NULL,
  qr_code VARCHAR(255) NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_products_company_sku (company_id, sku),
  UNIQUE KEY uk_products_company_code (company_id, product_code),
  UNIQUE KEY uk_products_company_internal (company_id, internal_item_code),
  UNIQUE KEY uk_products_company_barcode (company_id, barcode),
  INDEX idx_products_company (company_id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS product_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  model_number VARCHAR(100) NULL,
  item_type VARCHAR(20) NOT NULL DEFAULT 'PRODUCT',
  classification VARCHAR(40) NOT NULL,
  brand VARCHAR(120) NULL,
  brand_id INT NULL,
  category_id INT NULL,
  subcategory_id INT NULL,
  manufacturer VARCHAR(255) NULL,
  model VARCHAR(120) NULL,
  specifications JSON NULL,
  description TEXT NULL,
  technical_attributes JSON NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  block_purchase TINYINT(1) NOT NULL DEFAULT 0,
  block_sales TINYINT(1) NOT NULL DEFAULT 0,
  tracking_type VARCHAR(30) NOT NULL DEFAULT 'NONE',
  valuation_method VARCHAR(30) NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  warranty_months INT NULL,
  stock_uom_id INT NULL,
  purchase_uom_id INT NULL,
  sales_uom_id INT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_eff (product_id, effective_from),
  INDEX idx_product_ver_class (classification),
  INDEX idx_product_ver_item_type (item_type),
  INDEX idx_product_ver_status (status),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE SET NULL,
  FOREIGN KEY (subcategory_id) REFERENCES product_categories(id) ON DELETE SET NULL,
  FOREIGN KEY (brand_id) REFERENCES product_brands(id) ON DELETE SET NULL,
  FOREIGN KEY (stock_uom_id) REFERENCES units_of_measure(id) ON DELETE SET NULL,
  FOREIGN KEY (purchase_uom_id) REFERENCES units_of_measure(id) ON DELETE SET NULL,
  FOREIGN KEY (sales_uom_id) REFERENCES units_of_measure(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_tag_links (
  product_id INT NOT NULL,
  tag_id INT NOT NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, tag_id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES product_tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_variants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  variant_sku VARCHAR(60) NOT NULL,
  variant_code VARCHAR(60) NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_variant_sku (product_id, variant_sku),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_variant_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  variant_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  size VARCHAR(80) NULL,
  length VARCHAR(80) NULL,
  color VARCHAR(80) NULL,
  rating VARCHAR(80) NULL,
  capacity VARCHAR(80) NULL,
  model VARCHAR(120) NULL,
  specifications JSON NULL,
  barcode VARCHAR(80) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_variant_eff (variant_id, effective_from),
  FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_media (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  variant_id INT NULL,
  media_type VARCHAR(30) NOT NULL,
  title VARCHAR(255) NULL,
  file_path VARCHAR(500) NOT NULL,
  original_name VARCHAR(255) NULL,
  mime_type VARCHAR(120) NULL,
  file_size INT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_product_media (product_id, media_type),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_unit_conversions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  from_uom_id INT NOT NULL,
  to_uom_id INT NOT NULL,
  factor DECIMAL(18,6) NOT NULL COMMENT '1 from_uom = factor to_uom',
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_prod_conv_eff (product_id, from_uom_id, to_uom_id, effective_from),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (from_uom_id) REFERENCES units_of_measure(id),
  FOREIGN KEY (to_uom_id) REFERENCES units_of_measure(id)
);

CREATE TABLE IF NOT EXISTS product_gst_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  code_type VARCHAR(8) NOT NULL,
  hsn_sac VARCHAR(16) NOT NULL,
  gst_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  tax_type VARCHAR(20) NOT NULL DEFAULT 'TAXABLE',
  cess_rate DECIMAL(6,3) NULL DEFAULT 0,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_gst_eff (product_id, effective_from),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_price_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  purchase_price DECIMAL(18,4) NULL,
  retail_price DECIMAL(18,4) NULL,
  wholesale_price DECIMAL(18,4) NULL,
  commercial_price DECIMAL(18,4) NULL,
  standard_cost DECIMAL(18,4) NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  min_margin_percent DECIMAL(8,3) NULL,
  discount_percent DECIMAL(8,3) NULL,
  max_price_discount DECIMAL(18,4) NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_price_eff (product_id, effective_from),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_vendor_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  vendor_id INT NOT NULL,
  vendor_item_code VARCHAR(80) NULL,
  purchase_price DECIMAL(18,4) NULL,
  lead_time_days INT NULL,
  min_order_qty DECIMAL(18,3) NULL,
  is_preferred TINYINT(1) NOT NULL DEFAULT 0,
  purchase_uom_id INT NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pvm_product (product_id),
  INDEX idx_pvm_vendor (vendor_id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (purchase_uom_id) REFERENCES units_of_measure(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_attribute_defs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  attribute_type VARCHAR(20) NOT NULL,
  options JSON NULL,
  category_id INT NULL COMMENT 'NULL = all categories',
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_attr_def (company_id, code),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_attribute_values (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  attribute_def_id INT NOT NULL,
  value_text VARCHAR(1000) NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_attr_val_eff (product_id, attribute_def_id, effective_from),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (attribute_def_id) REFERENCES product_attribute_defs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  warehouse_type VARCHAR(30) NOT NULL DEFAULT 'STORE',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_wh_company_code (company_id, code),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS warehouse_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  warehouse_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(500) NULL,
  city VARCHAR(120) NULL,
  state VARCHAR(120) NULL,
  pincode VARCHAR(10) NULL,
  parent_warehouse_id INT NULL,
  rack_bin VARCHAR(80) NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_wh_eff (warehouse_id, effective_from),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_reorder_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  warehouse_id INT NULL,
  min_stock DECIMAL(18,3) NOT NULL DEFAULT 0,
  max_stock DECIMAL(18,3) NULL,
  reorder_level DECIMAL(18,3) NULL,
  reorder_qty DECIMAL(18,3) NULL,
  safety_stock DECIMAL(18,3) NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_reorder_eff (product_id, warehouse_id, effective_from),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory_stock (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  product_id INT NOT NULL,
  variant_id INT NULL,
  warehouse_id INT NOT NULL,
  stock_status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE',
  qty DECIMAL(18,3) NOT NULL DEFAULT 0,
  stock_uom_id INT NOT NULL,
  avg_cost DECIMAL(18,4) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_inv_stock (product_id, warehouse_id, stock_status, variant_id),
  INDEX idx_inv_stock_wh (warehouse_id, product_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (stock_uom_id) REFERENCES units_of_measure(id)
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  product_id INT NOT NULL,
  variant_id INT NULL,
  warehouse_id INT NOT NULL,
  to_warehouse_id INT NULL,
  txn_type VARCHAR(40) NOT NULL,
  txn_date DATE NOT NULL,
  stock_status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE',
  txn_qty DECIMAL(18,3) NOT NULL,
  txn_uom_id INT NOT NULL,
  stock_qty DECIMAL(18,3) NOT NULL COMMENT 'qty in stock UOM (+ in / - out)',
  stock_uom_id INT NOT NULL,
  unit_cost DECIMAL(18,4) NULL,
  reference_type VARCHAR(40) NULL,
  reference_id INT NULL,
  reference_no VARCHAR(80) NULL,
  batch_id INT NULL,
  serial_id INT NULL,
  reason_code VARCHAR(40) NULL,
  remarks VARCHAR(500) NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_inv_txn_product (product_id, txn_date),
  INDEX idx_inv_txn_wh (warehouse_id, txn_date),
  INDEX idx_inv_txn_ref (reference_type, reference_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (txn_uom_id) REFERENCES units_of_measure(id),
  FOREIGN KEY (stock_uom_id) REFERENCES units_of_measure(id)
);
${appendOnlyTriggers('inventory_transactions')}

CREATE TABLE IF NOT EXISTS inventory_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  product_id INT NOT NULL,
  warehouse_id INT NULL,
  batch_no VARCHAR(80) NOT NULL,
  lot_no VARCHAR(80) NULL,
  supplier_batch_ref VARCHAR(80) NULL,
  mfg_date DATE NULL,
  expiry_date DATE NULL,
  qty DECIMAL(18,3) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_batch (product_id, batch_no),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory_serial_numbers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  product_id INT NOT NULL,
  variant_id INT NULL,
  serial_no VARCHAR(120) NOT NULL,
  warehouse_id INT NULL,
  batch_id INT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'IN_STOCK',
  customer_name VARCHAR(255) NULL,
  invoice_ref VARCHAR(80) NULL,
  warranty_start DATE NULL,
  warranty_end DATE NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_serial (company_id, serial_no),
  INDEX idx_serial_product (product_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES inventory_batches(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_warranty_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  product_id INT NOT NULL,
  serial_id INT NULL,
  customer_name VARCHAR(255) NULL,
  customer_id INT NULL,
  invoice_ref VARCHAR(80) NULL,
  warranty_start DATE NOT NULL,
  warranty_end DATE NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  service_notes TEXT NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_warranty_product (product_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (serial_id) REFERENCES inventory_serial_numbers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bills_of_materials (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  product_id INT NOT NULL COMMENT 'Finished / SFG product',
  code VARCHAR(40) NOT NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bom_code (company_id, code),
  INDEX idx_bom_product (product_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS bom_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bom_id INT NOT NULL,
  version_no INT NOT NULL DEFAULT 1,
  name VARCHAR(255) NOT NULL,
  output_qty DECIMAL(18,3) NOT NULL DEFAULT 1,
  output_uom_id INT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  approval_status VARCHAR(30) NOT NULL DEFAULT 'APPROVED',
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bom_ver (bom_id, version_no),
  UNIQUE KEY uk_bom_eff (bom_id, effective_from),
  FOREIGN KEY (bom_id) REFERENCES bills_of_materials(id) ON DELETE CASCADE,
  FOREIGN KEY (output_uom_id) REFERENCES units_of_measure(id)
);

CREATE TABLE IF NOT EXISTS bom_components (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bom_version_id INT NOT NULL,
  component_product_id INT NOT NULL,
  qty DECIMAL(18,6) NOT NULL,
  uom_id INT NOT NULL,
  scrap_percent DECIMAL(8,3) NOT NULL DEFAULT 0,
  is_alternative TINYINT(1) NOT NULL DEFAULT 0,
  alt_group VARCHAR(40) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  remarks VARCHAR(255) NULL,
  FOREIGN KEY (bom_version_id) REFERENCES bom_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (component_product_id) REFERENCES products(id),
  FOREIGN KEY (uom_id) REFERENCES units_of_measure(id)
);

CREATE TABLE IF NOT EXISTS production_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  bom_id INT NOT NULL,
  bom_version_id INT NOT NULL,
  product_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  order_no VARCHAR(40) NOT NULL,
  qty DECIMAL(18,3) NOT NULL,
  uom_id INT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  planned_date DATE NULL,
  completed_date DATE NULL,
  remarks VARCHAR(500) NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_prod_order (company_id, order_no),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (bom_id) REFERENCES bills_of_materials(id),
  FOREIGN KEY (bom_version_id) REFERENCES bom_versions(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (uom_id) REFERENCES units_of_measure(id)
);

CREATE TABLE IF NOT EXISTS production_material_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  production_order_id INT NOT NULL,
  product_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  txn_type VARCHAR(30) NOT NULL COMMENT 'ISSUE / RETURN / SCRAP / CONSUMPTION',
  qty DECIMAL(18,3) NOT NULL,
  uom_id INT NOT NULL,
  inventory_txn_id BIGINT NULL,
  remarks VARCHAR(500) NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (production_order_id) REFERENCES production_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (uom_id) REFERENCES units_of_measure(id)
);

CREATE TABLE IF NOT EXISTS production_output_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  production_order_id INT NOT NULL,
  product_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  qty DECIMAL(18,3) NOT NULL,
  uom_id INT NOT NULL,
  unit_cost DECIMAL(18,4) NULL,
  inventory_txn_id BIGINT NULL,
  remarks VARCHAR(500) NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (production_order_id) REFERENCES production_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (uom_id) REFERENCES units_of_measure(id)
);

CREATE TABLE IF NOT EXISTS inventory_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  product_id INT NULL,
  warehouse_id INT NULL,
  action VARCHAR(40) NOT NULL,
  field_name VARCHAR(80) NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  reference_type VARCHAR(40) NULL,
  reference_id INT NULL,
  changed_by VARCHAR(255),
  changed_by_role VARCHAR(80) NULL,
  note VARCHAR(500) NULL,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_inv_audit (company_id, changed_at)
);
${appendOnlyTriggers('inventory_audit_logs')}

CREATE TABLE IF NOT EXISTS product_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  product_id INT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id INT NULL,
  action VARCHAR(40) NOT NULL,
  field_name VARCHAR(80) NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  effective_date DATE NULL,
  change_reason VARCHAR(500) NULL,
  changed_by VARCHAR(255),
  changed_by_role VARCHAR(80) NULL,
  note VARCHAR(500) NULL,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_product_audit_company (company_id, changed_at),
  INDEX idx_product_audit_product (product_id, changed_at)
);
${appendOnlyTriggers('product_audit_logs')}
`;

/** Drop order (children first) for reset-db. */
const PRODUCT_TABLES = [
  'production_output_transactions',
  'production_material_transactions',
  'production_orders',
  'bom_components',
  'bom_versions',
  'bills_of_materials',
  'product_warranty_records',
  'inventory_serial_numbers',
  'inventory_batches',
  'inventory_transactions',
  'inventory_audit_logs',
  'inventory_stock',
  'product_reorder_settings',
  'warehouse_versions',
  'warehouses',
  'product_attribute_values',
  'product_attribute_defs',
  'product_vendor_mappings',
  'product_price_versions',
  'product_gst_versions',
  'product_unit_conversions',
  'product_media',
  'product_variant_versions',
  'product_variants',
  'product_tag_links',
  'product_versions',
  'products',
  'units_of_measure',
  'product_tags',
  'product_brands',
  'product_category_versions',
  'product_categories',
  'product_audit_logs',
];

module.exports = { PRODUCT_TABLES_SQL, PRODUCT_TABLES };
