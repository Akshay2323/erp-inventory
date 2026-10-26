/**
 * Builds the separate table sets for Client Master (client_*) and Vendor Master (vendor_*)
 * from config/partyModules.js.
 */
const { PARTY_MODULES } = require('./partyModules');

const COLUMN_TYPES = {
  email: 'VARCHAR(255)',
  mobile: 'VARCHAR(15)',
  enum: 'VARCHAR(40)',
  gstin: 'VARCHAR(15)',
  pan: 'VARCHAR(10)',
  state_code: 'CHAR(2)',
  state: 'VARCHAR(120)',
  pincode: 'VARCHAR(6)',
  ifsc: 'VARCHAR(11)',
  upi: 'VARCHAR(320)',
  account_number: 'VARCHAR(20)',
  int: 'INT',
  user_id: 'INT',
  decimal: 'DECIMAL(16,2)',
  qty: 'DECIMAL(18,3)',
  date: 'DATE',
  json: 'JSON',
  coord: 'DECIMAL(10,7)',
};

function columnDdl(name, spec) {
  if (spec.type === 'bool') return `${name} TINYINT(1) NOT NULL DEFAULT 0`;
  const type = spec.type === 'text' ? (spec.max > 1000 ? 'TEXT' : `VARCHAR(${spec.max})`) : COLUMN_TYPES[spec.type];
  if (!type) throw new Error(`No column type for ${name} (${spec.type})`);
  return `${name} ${type}${spec.required ? ' NOT NULL' : ' NULL'}`;
}

function columns(fields) {
  return Object.entries(fields).map(([name, spec]) => `  ${columnDdl(name, spec)},`).join('\n');
}

const VERSION_TAIL = `
  effective_from DATE NOT NULL,
  effective_to DATE NULL COMMENT 'NULL = open-ended (latest version)',
  remarks VARCHAR(500) COMMENT 'change reason',
  created_by VARCHAR(255),
  approval_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,`;

function appendOnlyTriggers(table) {
  return ['UPDATE', 'DELETE'].map((op) => `
CREATE TRIGGER IF NOT EXISTS trg_${table}_no_${op.toLowerCase()}
BEFORE ${op} ON ${table} FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only (protected audit history)';`).join('\n');
}

function partyTablesSql(cfg) {
  const { table, fk } = cfg;
  const parts = [];

  parts.push(`
CREATE TABLE IF NOT EXISTS ${table} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  code VARCHAR(30) NOT NULL,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / APPROVED / REJECTED',
  approved_by VARCHAR(255),
  approved_at DATETIME NULL,
  approval_remarks VARCHAR(500),
  kyc_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / VERIFIED / REJECTED',
  kyc_updated_by VARCHAR(255),
  kyc_updated_at DATETIME NULL,
  kyc_remarks VARCHAR(500),
  outstanding_balance DECIMAL(16,2) NOT NULL DEFAULT 0 COMMENT 'maintained by transaction modules',
  advance_balance DECIMAL(16,2) NOT NULL DEFAULT 0 COMMENT 'maintained by transaction modules',
  merged_into_id INT NULL,
  merged_at DATETIME NULL,
  merged_by VARCHAR(255),
  merge_reason VARCHAR(500),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_${table}_company_code (company_id, code),
  INDEX idx_${table}_merged (merged_into_id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);`);

  parts.push(`
CREATE TABLE IF NOT EXISTS ${cfg.versionTable} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ${fk} INT NOT NULL,
${columns(cfg.profile)}${VERSION_TAIL}
  UNIQUE KEY uk_${cfg.versionTable}_effective (${fk}, effective_from),
  INDEX idx_${cfg.versionTable}_gstin (gstin),
  INDEX idx_${cfg.versionTable}_pan (pan),
  INDEX idx_${cfg.versionTable}_mobile (mobile),
  FOREIGN KEY (${fk}) REFERENCES ${table}(id)
);`);

  parts.push(`
CREATE TABLE IF NOT EXISTS ${cfg.financialTable} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ${fk} INT NOT NULL,
${columns(cfg.financial)}${VERSION_TAIL}
  UNIQUE KEY uk_${cfg.financialTable}_effective (${fk}, effective_from),
  FOREIGN KEY (${fk}) REFERENCES ${table}(id)
);`);

  for (const child of Object.values(cfg.children)) {
    const extra = [
      child.file ? `  file_path VARCHAR(500),\n  original_name VARCHAR(255),\n  mime_type VARCHAR(100),\n  file_size INT,` : '',
      child.verification
        ? `  verification_status VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED',\n  verified_by VARCHAR(255),\n  verified_at DATETIME NULL,\n  verification_remarks VARCHAR(500),`
        : '',
    ].filter(Boolean).join('\n');
    parts.push(`
CREATE TABLE IF NOT EXISTS ${child.table} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  root_id INT NULL COMMENT 'stable id of the record — all versions share it',
  ${fk} INT NOT NULL,
${columns(child.fields)}
${extra ? `${extra}\n` : ''}  is_default TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,${VERSION_TAIL}
  UNIQUE KEY uk_${child.table}_effective (root_id, effective_from),
  INDEX idx_${child.table}_party (${fk}),
  FOREIGN KEY (${fk}) REFERENCES ${table}(id)
);`);

    if (child.historyTable) {
      parts.push(`
CREATE TABLE IF NOT EXISTS ${child.historyTable} (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ${fk} INT NOT NULL,
  root_id INT NOT NULL,
  change_type VARCHAR(30) NOT NULL COMMENT 'ADDED / MODIFIED / CORRECTED / DEACTIVATED / REACTIVATED / DEFAULT_CHANGED / VERIFIED / SCHEDULE_CANCELLED',
  old_values JSON NULL,
  new_values JSON NULL,
  effective_date DATE NULL,
  change_reason VARCHAR(500),
  changed_by VARCHAR(255),
  approval_id INT NULL,
  approved_by VARCHAR(255),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_${child.historyTable}_record (${fk}, root_id)
);
${appendOnlyTriggers(child.historyTable)}`);
    }
  }

  parts.push(`
CREATE TABLE IF NOT EXISTS ${cfg.auditTable} (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  ${fk} INT NOT NULL,
  entity_type VARCHAR(30) NOT NULL COMMENT 'RECORD / PROFILE / FINANCIAL / ADDRESS / GST / BANK / UPI / CONTACT / DOCUMENT',
  entity_id INT NULL COMMENT 'root_id of the child record',
  action VARCHAR(30) NOT NULL,
  field_name VARCHAR(64) NULL,
  old_value TEXT,
  new_value TEXT,
  effective_date DATE NULL,
  financial_year VARCHAR(9) NULL COMMENT 'e.g. 2026-27, from effective date',
  change_reason VARCHAR(500),
  changed_by VARCHAR(255),
  changed_by_role VARCHAR(50),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  approval_id INT NULL,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED' COMMENT 'NOT_REQUIRED / AUTO_APPROVED / APPROVED / PENDING / REJECTED',
  approved_by VARCHAR(255),
  approved_at DATETIME NULL,
  INDEX idx_${cfg.auditTable}_party (${fk}, changed_at),
  INDEX idx_${cfg.auditTable}_company (company_id, changed_at),
  INDEX idx_${cfg.auditTable}_field (field_name),
  INDEX idx_${cfg.auditTable}_user (changed_by),
  INDEX idx_${cfg.auditTable}_fy (financial_year)
);
${appendOnlyTriggers(cfg.auditTable)}`);

  parts.push(`
CREATE TABLE IF NOT EXISTS ${cfg.approvalTable} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  ${fk} INT NOT NULL,
  operation VARCHAR(40) NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id INT NULL,
  summary VARCHAR(500),
  payload JSON NULL,
  effective_date DATE NULL,
  change_reason VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / APPROVED / REJECTED / CANCELLED',
  requested_by VARCHAR(255),
  requested_by_role VARCHAR(50),
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  decided_by VARCHAR(255),
  decided_at DATETIME NULL,
  decision_remarks VARCHAR(500),
  INDEX idx_${cfg.approvalTable}_status (company_id, status),
  INDEX idx_${cfg.approvalTable}_party (${fk})
);`);

  return parts.join('\n');
}

function partyTableNames(cfg) {
  const childTables = Object.values(cfg.children).flatMap((c) => [c.historyTable, c.table].filter(Boolean));
  return [cfg.auditTable, cfg.approvalTable, ...childTables, cfg.financialTable, cfg.versionTable, cfg.table];
}

const PARTY_TABLES_SQL = Object.values(PARTY_MODULES).map(partyTablesSql).join('\n');
const PARTY_TABLES = Object.values(PARTY_MODULES).flatMap(partyTableNames);

module.exports = { PARTY_TABLES_SQL, PARTY_TABLES, appendOnlyTriggers };
