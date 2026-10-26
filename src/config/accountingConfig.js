/**
 * Accounting & ERP integration definitions.
 *
 * Sales (Client Master) and Purchases (Vendor Master) are separate sides with their own voucher,
 * allocation, revision, e-way bill and audit tables and their own permissions (sales.* / purchases.*).
 * Company books (settings, financial years, ledgers, ledger mapping, voucher numbering, general ledger)
 * are shared per company under accounting.*.
 */
const { CLIENT, VENDOR } = require('./partyModules');

/** Ledger groups (chart of accounts) and their nature. */
const LEDGER_GROUPS = {
  CAPITAL: 'LIABILITY',
  RESERVES: 'LIABILITY',
  LOANS_LIABILITY: 'LIABILITY',
  CURRENT_LIABILITIES: 'LIABILITY',
  DUTIES_TAXES: 'LIABILITY',
  PROVISIONS: 'LIABILITY',
  SUNDRY_CREDITORS: 'LIABILITY',
  FIXED_ASSETS: 'ASSET',
  INVESTMENTS: 'ASSET',
  CURRENT_ASSETS: 'ASSET',
  LOANS_ADVANCES_ASSET: 'ASSET',
  SUNDRY_DEBTORS: 'ASSET',
  BANK: 'ASSET',
  CASH: 'ASSET',
  SALES: 'INCOME',
  DIRECT_INCOME: 'INCOME',
  INDIRECT_INCOME: 'INCOME',
  PURCHASE: 'EXPENSE',
  DIRECT_EXPENSE: 'EXPENSE',
  INDIRECT_EXPENSE: 'EXPENSE',
  SUSPENSE: 'SUSPENSE',
};

const INCOME_GROUPS = ['SALES', 'DIRECT_INCOME', 'INDIRECT_INCOME'];
const PURCHASE_LINE_GROUPS = ['PURCHASE', 'DIRECT_EXPENSE', 'INDIRECT_EXPENSE', 'FIXED_ASSETS', 'CURRENT_ASSETS'];
const TAX_GROUPS = ['DUTIES_TAXES'];

/** Ledger mapping keys → allowed ledger groups. Seeded ledgers use the key as system_key / code. */
const MAPPING_KEYS = {
  SALES: { groups: INCOME_GROUPS, ledger: ['Sales', 'SALES'] },
  SALES_RETURN: { groups: INCOME_GROUPS, ledger: ['Sales Returns', 'SALES'] },
  PURCHASE: { groups: PURCHASE_LINE_GROUPS, ledger: ['Purchases', 'PURCHASE'] },
  PURCHASE_RETURN: { groups: PURCHASE_LINE_GROUPS, ledger: ['Purchase Returns', 'PURCHASE'] },
  OUTPUT_CGST: { groups: TAX_GROUPS, ledger: ['Output CGST', 'DUTIES_TAXES'] },
  OUTPUT_SGST: { groups: TAX_GROUPS, ledger: ['Output SGST / UTGST', 'DUTIES_TAXES'] },
  OUTPUT_IGST: { groups: TAX_GROUPS, ledger: ['Output IGST', 'DUTIES_TAXES'] },
  OUTPUT_CESS: { groups: TAX_GROUPS, ledger: ['Output Cess', 'DUTIES_TAXES'] },
  INPUT_CGST: { groups: TAX_GROUPS, ledger: ['Input CGST', 'DUTIES_TAXES'] },
  INPUT_SGST: { groups: TAX_GROUPS, ledger: ['Input SGST / UTGST', 'DUTIES_TAXES'] },
  INPUT_IGST: { groups: TAX_GROUPS, ledger: ['Input IGST', 'DUTIES_TAXES'] },
  INPUT_CESS: { groups: TAX_GROUPS, ledger: ['Input Cess', 'DUTIES_TAXES'] },
  RCM_PAYABLE: { groups: TAX_GROUPS, ledger: ['GST Payable on Reverse Charge', 'DUTIES_TAXES'] },
  ROUND_OFF: { groups: ['INDIRECT_EXPENSE', 'INDIRECT_INCOME'], ledger: ['Round Off', 'INDIRECT_EXPENSE'] },
  CASH: { groups: ['CASH'], ledger: ['Cash in Hand', 'CASH'] },
  BANK: { groups: ['BANK'], ledger: ['Bank Account', 'BANK'] },
  CLIENT_CONTROL: { groups: ['SUNDRY_DEBTORS'], ledger: ['Sundry Debtors', 'SUNDRY_DEBTORS'] },
  VENDOR_CONTROL: { groups: ['SUNDRY_CREDITORS'], ledger: ['Sundry Creditors', 'SUNDRY_CREDITORS'] },
  OPENING_BALANCE: { groups: ['SUSPENSE', 'CAPITAL'], ledger: ['Opening Balance Difference', 'SUSPENSE'] },
};

const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
const PAYMENT_MODES = ['CASH', 'BANK_TRANSFER', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CARD', 'OTHER'];
/** Tax treatments with no GST charged on the document. */
const ZERO_TAX_TREATMENTS = ['EXEMPT', 'NIL_RATED', 'NON_GST', 'SEZ_WITHOUT_PAYMENT', 'EXPORT_WITHOUT_PAYMENT'];
/** Always inter-state (IGST). */
const INTER_STATE_TREATMENTS = ['SEZ_WITH_PAYMENT', 'SEZ_WITHOUT_PAYMENT', 'EXPORT_WITH_PAYMENT', 'EXPORT_WITHOUT_PAYMENT'];
/** GSTR-1 B2C large threshold (inter-state, unregistered, invoice value above). */
const B2CL_LIMIT = 100000;

/**
 * Voucher types per side.
 *   effect   DR = party owes us more (receivable up / payable down); CR = the opposite
 *   lines    item lines with GST; line ledgers default to the mapping key `lineKey`
 *   cash     receipt / payment through a cash or bank ledger
 *   eway     goods movement — e-way bill can be recorded
 *   gstDoc   GST invoice numbering rules (max 16 chars) and GST reports
 *   against  may reference an original invoice (auto-adjusted)
 */
const SALES = {
  key: 'sales',
  label: 'Sales',
  partyCfg: CLIENT,
  partyType: 'CLIENT',
  partyFk: 'client_id',
  partyPath: 'clients',
  table: 'sales_vouchers',
  linesTable: 'sales_voucher_lines',
  allocTable: 'sales_allocations',
  revisionTable: 'sales_voucher_revisions',
  ewayTable: 'sales_eway_bills',
  auditTable: 'sales_audit_logs',
  source: 'SALES',
  controlKey: 'CLIENT_CONTROL',
  taxPrefix: 'OUTPUT',
  receivableEffect: 'DR',
  swaggerTag: '08 Sales',
  billingTypes: ['BILLING', 'OFFICE'],
  shippingTypes: ['SHIPPING', 'DELIVERY', 'BILLING'],
  voucherTypes: {
    SALES_INVOICE: { label: 'Sales Invoice', effect: 'DR', lines: true, lineKey: 'SALES', eway: true, gstDoc: true, due: true, holdBlocks: true, creditCheck: true, format: 'INV/{FY}/{SEQ}' },
    SALES_RETURN: { label: 'Sales Return (Credit Note)', effect: 'CR', lines: true, lineKey: 'SALES_RETURN', eway: true, gstDoc: true, against: true, format: 'SR/{FY}/{SEQ}' },
    CREDIT_NOTE: { label: 'Credit Note', effect: 'CR', lines: true, lineKey: 'SALES_RETURN', gstDoc: true, against: true, format: 'CN/{FY}/{SEQ}' },
    RECEIPT: { label: 'Receipt', effect: 'CR', cash: true, format: 'RCT/{FY}/{SEQ}' },
    REFUND: { label: 'Refund', effect: 'DR', cash: true, format: 'RFD/{FY}/{SEQ}' },
  },
};

const PURCHASE = {
  key: 'purchases',
  label: 'Purchases',
  partyCfg: VENDOR,
  partyType: 'VENDOR',
  partyFk: 'vendor_id',
  partyPath: 'vendors',
  table: 'purchase_vouchers',
  linesTable: 'purchase_voucher_lines',
  allocTable: 'purchase_allocations',
  revisionTable: 'purchase_voucher_revisions',
  ewayTable: 'purchase_eway_bills',
  auditTable: 'purchase_audit_logs',
  source: 'PURCHASE',
  controlKey: 'VENDOR_CONTROL',
  taxPrefix: 'INPUT',
  receivableEffect: 'CR',
  swaggerTag: '09 Purchases',
  billingTypes: ['BILLING', 'REGISTERED', 'OFFICE'],
  shippingTypes: ['DISPATCH', 'REGISTERED', 'BILLING'],
  voucherTypes: {
    PURCHASE_INVOICE: { label: 'Purchase Invoice', effect: 'CR', lines: true, lineKey: 'PURCHASE', eway: true, due: true, supplierRef: true, format: 'PUR/{FY}/{SEQ}' },
    PURCHASE_RETURN: { label: 'Purchase Return', effect: 'DR', lines: true, lineKey: 'PURCHASE_RETURN', eway: true, against: true, format: 'PR/{FY}/{SEQ}' },
    DEBIT_NOTE: { label: 'Debit Note', effect: 'DR', lines: true, lineKey: 'PURCHASE_RETURN', against: true, format: 'DN/{FY}/{SEQ}' },
    PAYMENT: { label: 'Payment', effect: 'DR', cash: true, holdBlocks: true, format: 'PAY/{FY}/{SEQ}' },
  },
};

for (const side of [SALES, PURCHASE]) {
  side.voucherTypes.OPENING_BALANCE = { label: 'Opening Balance Bill', opening: true };
}

const SIDES = { sales: SALES, purchases: PURCHASE };
const ALL_VOUCHER_TYPES = [...new Set(Object.values(SIDES).flatMap((s) => Object.keys(s.voucherTypes)))];
const NUMBERED_VOUCHER_TYPES = Object.values(SIDES)
  .flatMap((s) => Object.entries(s.voucherTypes).filter(([, t]) => t.format).map(([type, t]) => ({ type, side: s.key, format: t.format })));

function sideForVoucherType(type) {
  return Object.values(SIDES).find((s) => s.voucherTypes[type] && !s.voucherTypes[type].opening) || null;
}

module.exports = {
  LEDGER_GROUPS,
  INCOME_GROUPS,
  PURCHASE_LINE_GROUPS,
  MAPPING_KEYS,
  GST_RATES,
  PAYMENT_MODES,
  ZERO_TAX_TREATMENTS,
  INTER_STATE_TREATMENTS,
  B2CL_LIMIT,
  SALES,
  PURCHASE,
  SIDES,
  ALL_VOUCHER_TYPES,
  NUMBERED_VOUCHER_TYPES,
  sideForVoucherType,
};
