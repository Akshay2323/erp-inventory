/**
 * Company books (shared per company) + separate Sales (sales_*) and Purchase (purchase_*) voucher tables.
 * Ledger entries, voucher revisions and audit logs are append-only (protected by triggers).
 */
const { SIDES } = require('./accountingConfig');
const { appendOnlyTriggers } = require('./partyDdl');

const VERSION_TAIL = `
  effective_from DATE NOT NULL,
  effective_to DATE NULL COMMENT 'NULL = open-ended (latest version)',
  remarks VARCHAR(500) COMMENT 'change reason',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,`;

const AMOUNT = 'DECIMAL(16,2) NOT NULL DEFAULT 0';

const BOOKS_SQL = `
CREATE TABLE IF NOT EXISTS company_books (
  company_id INT PRIMARY KEY,
  books_start_date DATE NOT NULL COMMENT 'first date of accounting in this system',
  fy_start_month TINYINT NOT NULL DEFAULT 4 COMMENT '4 = April-March',
  base_currency CHAR(3) NOT NULL DEFAULT 'INR',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS company_accounting_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  trade_name VARCHAR(255),
  gstin VARCHAR(15),
  pan VARCHAR(10),
  gst_registration_type VARCHAR(40) NOT NULL DEFAULT 'REGULAR',
  state_code CHAR(2) NOT NULL,
  address VARCHAR(500),
  city VARCHAR(120),
  pincode VARCHAR(6),
  phone VARCHAR(15),
  email VARCHAR(255),
  invoice_round_off TINYINT(1) NOT NULL DEFAULT 1,
  eway_bill_threshold DECIMAL(16,2) NOT NULL DEFAULT 50000,
  credit_limit_action VARCHAR(10) NOT NULL DEFAULT 'BLOCK' COMMENT 'BLOCK / WARN',
  invoice_terms TEXT,${VERSION_TAIL}
  UNIQUE KEY uk_company_accounting_settings (company_id, effective_from),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS financial_years (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  code VARCHAR(9) NOT NULL COMMENT 'e.g. 2026-27',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN / CLOSED',
  closed_by VARCHAR(255),
  closed_at DATETIME NULL,
  status_remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_financial_years_code (company_id, code),
  UNIQUE KEY uk_financial_years_start (company_id, start_date),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS ledgers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  code VARCHAR(30) NOT NULL,
  system_key VARCHAR(30) NULL COMMENT 'seeded ledger for a mapping key',
  opening_balance ${AMOUNT},
  opening_type CHAR(2) NOT NULL DEFAULT 'DR',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ledgers_code (company_id, code),
  UNIQUE KEY uk_ledgers_system (company_id, system_key),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS ledger_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ledger_id INT NOT NULL,
  name VARCHAR(150) NOT NULL,
  ledger_group VARCHAR(30) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
  description VARCHAR(500),
  bank_account_no VARCHAR(20),
  ifsc VARCHAR(11),${VERSION_TAIL}
  UNIQUE KEY uk_ledger_versions (ledger_id, effective_from),
  FOREIGN KEY (ledger_id) REFERENCES ledgers(id)
);

CREATE TABLE IF NOT EXISTS ledger_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  mapping_key VARCHAR(30) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ledger_mappings (company_id, mapping_key),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS ledger_mapping_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mapping_id INT NOT NULL,
  ledger_id INT NOT NULL,${VERSION_TAIL}
  UNIQUE KEY uk_ledger_mapping_versions (mapping_id, effective_from),
  FOREIGN KEY (mapping_id) REFERENCES ledger_mappings(id),
  FOREIGN KEY (ledger_id) REFERENCES ledgers(id)
);

CREATE TABLE IF NOT EXISTS voucher_series (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  voucher_type VARCHAR(30) NOT NULL,
  name VARCHAR(100) NOT NULL,
  branch_id INT NULL COMMENT 'NULL = all branches',
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_voucher_series_name (company_id, voucher_type, name),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS voucher_series_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  series_id INT NOT NULL,
  format VARCHAR(60) NOT NULL COMMENT 'tokens: {FY} {FYFULL} {YYYY} {YY} {MM} {SEQ}',
  padding TINYINT NOT NULL DEFAULT 4,
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',${VERSION_TAIL}
  UNIQUE KEY uk_voucher_series_versions (series_id, effective_from),
  FOREIGN KEY (series_id) REFERENCES voucher_series(id)
);

CREATE TABLE IF NOT EXISTS voucher_counters (
  series_id INT NOT NULL,
  financial_year_id INT NOT NULL,
  last_number INT NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, financial_year_id),
  FOREIGN KEY (series_id) REFERENCES voucher_series(id),
  FOREIGN KEY (financial_year_id) REFERENCES financial_years(id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  financial_year_id INT NOT NULL,
  entry_date DATE NOT NULL,
  source VARCHAR(10) NOT NULL COMMENT 'SALES / PURCHASE / OPENING',
  voucher_id INT NOT NULL,
  voucher_type VARCHAR(30) NOT NULL,
  voucher_no VARCHAR(50) NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  ledger_id INT NOT NULL,
  party_type VARCHAR(10) NULL COMMENT 'CLIENT / VENDOR',
  party_id INT NULL,
  debit ${AMOUNT},
  credit ${AMOUNT},
  narration VARCHAR(500),
  is_reversal TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = reverses the same voucher revision (edit / cancel)',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ledger_entries_ledger (company_id, ledger_id, entry_date),
  INDEX idx_ledger_entries_party (party_type, party_id, entry_date),
  INDEX idx_ledger_entries_voucher (source, voucher_id, revision),
  FOREIGN KEY (ledger_id) REFERENCES ledgers(id)
);
${appendOnlyTriggers('ledger_entries')}

CREATE TABLE IF NOT EXISTS accounting_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  entity_type VARCHAR(30) NOT NULL COMMENT 'BOOKS / SETTINGS / FINANCIAL_YEAR / LEDGER / MAPPING / SERIES',
  entity_id INT NULL,
  action VARCHAR(30) NOT NULL,
  field_name VARCHAR(64) NULL,
  old_value TEXT,
  new_value TEXT,
  effective_date DATE NULL,
  financial_year VARCHAR(9) NULL,
  change_reason VARCHAR(500),
  changed_by VARCHAR(255),
  changed_by_role VARCHAR(50),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_accounting_audit_company (company_id, changed_at),
  INDEX idx_accounting_audit_entity (entity_type, entity_id)
);
${appendOnlyTriggers('accounting_audit_logs')}
`;

function sideTablesSql(side) {
  const fk = side.partyFk;
  const party = side.partyCfg.table;
  return `
CREATE TABLE IF NOT EXISTS ${side.table} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  branch_id INT NULL,
  financial_year_id INT NOT NULL,
  voucher_type VARCHAR(30) NOT NULL,
  series_id INT NULL,
  voucher_no VARCHAR(50) NOT NULL,
  voucher_date DATE NOT NULL,
  posting_date DATE NOT NULL COMMENT 'ledger date (books start date for opening bills)',
  ${fk} INT NOT NULL,
  party_code VARCHAR(30),
  party_name VARCHAR(255),
  party_gstin VARCHAR(15),
  party_state_code CHAR(2),
  party_registration_type VARCHAR(40),
  company_gstin VARCHAR(15),
  company_state_code CHAR(2),
  place_of_supply CHAR(2),
  supply_type VARCHAR(10) COMMENT 'INTRA / INTER',
  tax_treatment VARCHAR(40),
  reverse_charge TINYINT(1) NOT NULL DEFAULT 0,
  reference_no VARCHAR(50) COMMENT 'supplier invoice no / customer PO / opening bill no',
  reference_date DATE NULL,
  due_date DATE NULL,
  against_voucher_id INT NULL,
  payment_mode VARCHAR(20),
  cash_bank_ledger_id INT NULL,
  instrument_no VARCHAR(50),
  instrument_date DATE NULL,
  bank_cleared_on DATE NULL,
  taxable_value ${AMOUNT},
  cgst_amount ${AMOUNT},
  sgst_amount ${AMOUNT},
  igst_amount ${AMOUNT},
  cess_amount ${AMOUNT},
  round_off ${AMOUNT},
  total_amount ${AMOUNT} COMMENT 'party amount',
  party_effect CHAR(2) NOT NULL COMMENT 'DR / CR on the party account',
  status VARCHAR(10) NOT NULL DEFAULT 'POSTED' COMMENT 'POSTED / CANCELLED',
  revision INT NOT NULL DEFAULT 1,
  narration VARCHAR(1000),
  party_snapshot JSON NULL COMMENT 'party details as on voucher date',
  company_snapshot JSON NULL COMMENT 'company GST details as on voucher date',
  billing_address JSON NULL,
  shipping_address JSON NULL,
  cancelled_by VARCHAR(255),
  cancelled_at DATETIME NULL,
  cancel_reason VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(255),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_${side.table}_no (company_id, voucher_type, financial_year_id, voucher_no),
  INDEX idx_${side.table}_party (${fk}, status, voucher_date),
  INDEX idx_${side.table}_date (company_id, voucher_date),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (${fk}) REFERENCES ${party}(id),
  FOREIGN KEY (financial_year_id) REFERENCES financial_years(id)
);

CREATE TABLE IF NOT EXISTS ${side.linesTable} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  voucher_id INT NOT NULL,
  line_no INT NOT NULL,
  ledger_id INT NOT NULL,
  item_code VARCHAR(50),
  description VARCHAR(500) NOT NULL,
  hsn_sac VARCHAR(8),
  qty DECIMAL(18,3) NOT NULL DEFAULT 1,
  unit VARCHAR(10),
  rate DECIMAL(16,4) NOT NULL DEFAULT 0,
  discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  discount_amount ${AMOUNT},
  taxable_value ${AMOUNT},
  gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  cgst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  sgst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  igst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  cgst_amount ${AMOUNT},
  sgst_amount ${AMOUNT},
  igst_amount ${AMOUNT},
  cess_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  cess_amount ${AMOUNT},
  itc_eligible TINYINT(1) NOT NULL DEFAULT 1,
  line_total ${AMOUNT},
  INDEX idx_${side.linesTable}_voucher (voucher_id),
  FOREIGN KEY (voucher_id) REFERENCES ${side.table}(id)
);

CREATE TABLE IF NOT EXISTS ${side.allocTable} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  ${fk} INT NOT NULL,
  from_voucher_id INT NOT NULL COMMENT 'settling voucher (receipt / payment / return / note)',
  to_voucher_id INT NOT NULL COMMENT 'bill being settled',
  amount DECIMAL(16,2) NOT NULL,
  allocation_date DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / REVERSED',
  remarks VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reversed_by VARCHAR(255),
  reversed_at DATETIME NULL,
  reverse_reason VARCHAR(500),
  INDEX idx_${side.allocTable}_from (from_voucher_id, status),
  INDEX idx_${side.allocTable}_to (to_voucher_id, status),
  FOREIGN KEY (from_voucher_id) REFERENCES ${side.table}(id),
  FOREIGN KEY (to_voucher_id) REFERENCES ${side.table}(id)
);

CREATE TABLE IF NOT EXISTS ${side.revisionTable} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  voucher_id INT NOT NULL,
  revision INT NOT NULL,
  data JSON NOT NULL COMMENT 'voucher + lines as they were in this revision',
  reason VARCHAR(500),
  changed_by VARCHAR(255),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_${side.revisionTable} (voucher_id, revision)
);
${appendOnlyTriggers(side.revisionTable)}

CREATE TABLE IF NOT EXISTS ${side.ewayTable} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  voucher_id INT NOT NULL,
  eway_bill_no VARCHAR(12) NOT NULL,
  eway_bill_date DATETIME NOT NULL,
  valid_upto DATETIME NULL,
  transport_mode VARCHAR(10) NOT NULL DEFAULT 'ROAD',
  distance_km INT NOT NULL,
  transporter_id VARCHAR(15),
  transporter_name VARCHAR(150),
  transport_doc_no VARCHAR(30),
  transport_doc_date DATE NULL,
  vehicle_no VARCHAR(20),
  vehicle_type VARCHAR(10) NOT NULL DEFAULT 'REGULAR',
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / CANCELLED',
  cancel_reason VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(255),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cancelled_by VARCHAR(255),
  cancelled_at DATETIME NULL,
  INDEX idx_${side.ewayTable}_voucher (voucher_id),
  FOREIGN KEY (voucher_id) REFERENCES ${side.table}(id)
);

CREATE TABLE IF NOT EXISTS ${side.auditTable} (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  voucher_id INT NULL,
  ${fk} INT NULL,
  entity_type VARCHAR(30) NOT NULL COMMENT 'VOUCHER / ALLOCATION / EWAY_BILL / OPENING',
  entity_id INT NULL,
  action VARCHAR(30) NOT NULL,
  field_name VARCHAR(64) NULL,
  old_value TEXT,
  new_value TEXT,
  effective_date DATE NULL,
  financial_year VARCHAR(9) NULL,
  change_reason VARCHAR(500),
  changed_by VARCHAR(255),
  changed_by_role VARCHAR(50),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_${side.auditTable}_company (company_id, changed_at),
  INDEX idx_${side.auditTable}_voucher (voucher_id),
  INDEX idx_${side.auditTable}_party (${fk})
);
${appendOnlyTriggers(side.auditTable)}`;
}

function sideTableNames(side) {
  return [side.auditTable, side.ewayTable, side.revisionTable, side.allocTable, side.linesTable, side.table];
}

const ACCOUNTING_TABLES_SQL = `${BOOKS_SQL}\n${Object.values(SIDES).map(sideTablesSql).join('\n')}`;
const ACCOUNTING_TABLES = [
  ...Object.values(SIDES).flatMap(sideTableNames),
  'accounting_audit_logs', 'ledger_entries', 'voucher_counters', 'voucher_series_versions', 'voucher_series',
  'ledger_mapping_versions', 'ledger_mappings', 'ledger_versions', 'ledgers', 'financial_years',
  'company_accounting_settings', 'company_books',
];

module.exports = { ACCOUNTING_TABLES_SQL, ACCOUNTING_TABLES };
