const { ROLES } = require('./roles');

/**
 * Module permissions — every module is granted separately.
 *
 * clients / vendors (masters)
 *   view    list / detail / snapshot / transactions
 *   create  add new record (non-approvers' records start as PENDING approval)
 *   edit    edit profile, addresses, contacts, documents ...
 *   approve approve/reject records and sensitive changes, verify bank/UPI/documents, KYC, holds
 *   merge   merge duplicate records
 *   audit   view audit history / approvals
 *
 * sales / purchases (vouchers linked to Client / Vendor Master)
 *   view    vouchers, outstanding, ageing, statements, GST reports
 *   create  new invoices, returns, notes, receipts / payments, opening bills
 *   edit    amend vouchers (new revision), bill-wise allocation, e-way bills, bank clearance
 *   cancel  cancel vouchers
 *   approve override credit limit
 *   audit   voucher audit log and revisions
 *
 * products (item master)
 *   view    list / detail / categories / tags / media download
 *   create  add products, categories, tags, variants
 *   edit    edit profile, tags, variants, media upload/delete
 *   audit   product audit history
 *
 * accounting (company books)
 *   view    settings, financial years, ledgers, mapping, numbering, trial balance, reconciliation
 *   manage  setup books, edit settings / ledgers / mapping / numbering
 *   close_year  close / reopen financial years
 *   audit   accounting audit log
 */
const MASTER_ACTIONS = ['view', 'create', 'edit', 'approve', 'merge', 'audit'];
const PRODUCT_ACTIONS = ['view', 'create', 'edit', 'audit'];
const VOUCHER_ACTIONS = ['view', 'create', 'edit', 'cancel', 'approve', 'audit'];
const BOOK_ACTIONS = ['view', 'manage', 'close_year', 'audit'];
const ACTIONS = [...new Set([...MASTER_ACTIONS, ...PRODUCT_ACTIONS, ...VOUCHER_ACTIONS, ...BOOK_ACTIONS])];

const FULL = {
  clients: MASTER_ACTIONS,
  vendors: MASTER_ACTIONS,
  products: PRODUCT_ACTIONS,
  sales: VOUCHER_ACTIONS,
  purchases: VOUCHER_ACTIONS,
  accounting: BOOK_ACTIONS,
};

const ROLE_PERMISSIONS = {
  // local inventory logins
  ADMIN: FULL,
  COMPANY_ADMIN: FULL,
  USER: {},
  // portal (HRMS) roles
  [ROLES.SUPER_ADMIN]: FULL,
  [ROLES.GROUP_ADMIN]: FULL,
  [ROLES.COMPANY_ADMIN]: FULL,
  [ROLES.MANAGER]: {
    clients: ['view', 'create', 'edit', 'audit'],
    vendors: ['view', 'create', 'edit', 'audit'],
    products: ['view', 'create', 'edit', 'audit'],
    sales: ['view', 'create', 'edit', 'cancel', 'audit'],
    purchases: ['view', 'create', 'edit', 'cancel', 'audit'],
    accounting: ['view'],
  },
  [ROLES.SALES]: {
    clients: ['view', 'create', 'edit'],
    vendors: ['view'],
    products: ['view'],
    sales: ['view', 'create', 'edit'],
  },
  [ROLES.DEPARTMENT_HEAD]: {
    clients: ['view'],
    vendors: ['view'],
    products: ['view'],
    sales: ['view'],
    purchases: ['view'],
    accounting: ['view'],
  },
  [ROLES.HR]: {},
  [ROLES.EMPLOYEE]: {},
};

function permissionsFor(role, moduleKey) {
  return new Set(ROLE_PERMISSIONS[role]?.[moduleKey] || []);
}

function hasPermission(user, moduleKey, action) {
  return permissionsFor(user?.role, moduleKey).has(action);
}

module.exports = { ACTIONS, ROLE_PERMISSIONS, permissionsFor, hasPermission };
