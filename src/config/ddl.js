const { PARTY_TABLES_SQL, PARTY_TABLES } = require('./partyDdl');
const { PRODUCT_TABLES_SQL, PRODUCT_TABLES } = require('./productDdl');
const { ACCOUNTING_TABLES_SQL, ACCOUNTING_TABLES } = require('./accountingDdl');

/**
 * CREATE TABLE IF NOT EXISTS — safe for live data (never drops).
 * Order respects foreign keys.
 */
const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  email VARCHAR(255) UNIQUE,
  full_name VARCHAR(100),
  password_encrypted TEXT NOT NULL,
  role ENUM('ADMIN','COMPANY_ADMIN','USER') NOT NULL DEFAULT 'USER',
  company_id INT NULL COMMENT 'companies.id — NULL for platform ADMIN',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_company_id (company_id)
);

CREATE TABLE IF NOT EXISTS companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source ENUM('MANUAL','HRMS') NOT NULL DEFAULT 'MANUAL',
  hrms_tenant_id BIGINT UNSIGNED NULL UNIQUE COMMENT 'hrms_db.tenants.id when fetched from HRMS',
  admin_user_id INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS company_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  legal_name VARCHAR(255),
  email VARCHAR(255),
  address TEXT,
  logo VARCHAR(500),
  subscription_start DATE NULL,
  subscription_end DATE NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL COMMENT 'NULL = open-ended (latest version)',
  remarks VARCHAR(255),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_company_effective (company_id, effective_from),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  code VARCHAR(50) NOT NULL,
  source ENUM('MANUAL','HRMS') NOT NULL DEFAULT 'MANUAL',
  hrms_branch_id BIGINT UNSIGNED NULL UNIQUE COMMENT 'hrms_db.branches.id when fetched from HRMS',
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_branch_company_code (company_id, code),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS branch_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(120),
  state VARCHAR(120),
  pincode VARCHAR(10),
  phone VARCHAR(20),
  email VARCHAR(255),
  contact_person_name VARCHAR(255),
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  location_label VARCHAR(500) COMMENT 'Place picked from map search',
  effective_from DATE NOT NULL,
  effective_to DATE NULL COMMENT 'NULL = open-ended (latest version)',
  remarks VARCHAR(255),
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_branch_effective (branch_id, effective_from),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
);
${PARTY_TABLES_SQL}
${PRODUCT_TABLES_SQL}
${ACCOUNTING_TABLES_SQL}
`;

const ALL_TABLES = [
  ...ACCOUNTING_TABLES,
  ...PRODUCT_TABLES,
  ...PARTY_TABLES,
  'branch_versions', 'branches', 'company_versions', 'companies', 'users', 'schema_migrations',
];

module.exports = { CREATE_TABLES_SQL, ALL_TABLES };
