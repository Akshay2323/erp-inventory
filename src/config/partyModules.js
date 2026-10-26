/**
 * Client Master and Vendor Master definitions.
 *
 * Both modules are fully separate (own tables, routes, permissions, audit logs, approvals);
 * they only share the engine code in services/party/* which reads these specs.
 *
 * Field spec: { type, required, max, values, default, min, maxValue, label }
 *   types: text, email, mobile, enum, gstin, pan, state_code, state, pincode, ifsc, upi,
 *          account_number, bool, int, decimal, qty, date, json, coord, user_id
 */
const { GST_REGISTRATION_TYPES, TAX_TREATMENTS } = require('../services/taxValidation');

const PAYMENT_MODES = ['CASH', 'BANK_TRANSFER', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CARD', 'OTHER'];
const TRANSPORT_MODES = ['ROAD', 'RAIL', 'AIR', 'SHIP', 'COURIER', 'OWN_VEHICLE', 'SELF_PICKUP', 'OTHER'];
const FREIGHT_TERMS = ['PAID', 'TO_PAY', 'EX_WORKS', 'FOR_DESTINATION', 'FOB', 'CIF', 'OTHER'];
const CONTACT_PURPOSES = ['SALES', 'PURCHASE', 'ACCOUNTS', 'PAYMENTS', 'DELIVERY', 'DISPATCH', 'MANAGEMENT', 'OTHER'];
const ACCOUNT_TYPES = ['SAVINGS', 'CURRENT', 'CASH_CREDIT', 'OVERDRAFT', 'NRE', 'NRO', 'OTHER'];
const DOCUMENT_TYPES = ['GST_CERTIFICATE', 'PAN_CARD', 'BANK_PROOF', 'BUSINESS_REGISTRATION', 'OTHER'];

const text = (max, extra = {}) => ({ type: 'text', max, ...extra });
const enumOf = (values, extra = {}) => ({ type: 'enum', values, ...extra });

function commonProfile() {
  return {
    name: text(255, { required: true }),
    legal_name: text(255),
    email: { type: 'email' },
    mobile: { type: 'mobile', required: true },
    alt_mobile: { type: 'mobile' },
    contact_person: text(150),
    gstin: { type: 'gstin' },
    pan: { type: 'pan' },
    gst_registration_type: enumOf(GST_REGISTRATION_TYPES, { required: true }),
    state_code: { type: 'state_code' },
    place_of_supply: { type: 'state_code' },
    tax_treatment: enumOf(TAX_TREATMENTS, { default: 'TAXABLE' }),
    status: enumOf(['ACTIVE', 'INACTIVE'], { default: 'ACTIVE' }),
    hold_reason: text(255),
    internal_remarks: text(2000),
  };
}

function financial({ withCreditLimit, openingType }) {
  return {
    ...(withCreditLimit ? { credit_limit: { type: 'decimal', min: 0, default: 0 } } : {}),
    credit_period_days: { type: 'int', min: 0, maxValue: 3650, default: 0 },
    payment_terms: text(500),
    opening_balance: { type: 'decimal', min: 0, default: 0 },
    opening_balance_type: enumOf(['DR', 'CR'], { default: openingType }),
    opening_balance_date: { type: 'date' },
    default_payment_mode: enumOf(PAYMENT_MODES),
  };
}

function children({ prefix, addressTypes, defaultBankLabel, defaultUpiLabel }) {
  const verification = true;
  return {
    addresses: {
      table: `${prefix}_addresses`,
      historyTable: `${prefix}_address_history`,
      entityType: 'ADDRESS',
      label: 'Address',
      defaultGroup: 'address_type',
      defaultLabel: 'Default address for its type',
      fields: {
        address_type: enumOf(addressTypes, { required: true }),
        label: text(100),
        line1: text(255, { required: true }),
        line2: text(255),
        landmark: text(150),
        city: text(120, { required: true }),
        state: { type: 'state', required: true },
        state_code: { type: 'state_code' },
        pincode: { type: 'pincode' },
        country: text(60, { default: 'India' }),
        contact_name: text(150),
        contact_phone: { type: 'mobile' },
        instructions: text(1000),
        latitude: { type: 'coord' },
        longitude: { type: 'coord' },
      },
    },
    gst_registrations: {
      table: `${prefix}_gst_registrations`,
      entityType: 'GST',
      label: 'GST registration',
      sensitive: true,
      unique: ['gstin'],
      fields: {
        gstin: { type: 'gstin', required: true },
        registration_type: enumOf(GST_REGISTRATION_TYPES, { default: 'REGULAR' }),
        state_code: { type: 'state_code' },
        trade_name: text(255),
        place_of_supply: { type: 'state_code' },
      },
    },
    bank_accounts: {
      table: `${prefix}_bank_accounts`,
      historyTable: `${prefix}_bank_history`,
      entityType: 'BANK',
      label: 'Bank account',
      sensitive: true,
      verification,
      defaultGroup: 'ALL',
      defaultLabel: defaultBankLabel,
      unique: ['ifsc', 'account_number'],
      masked: 'account_number',
      fields: {
        account_holder_name: text(150, { required: true }),
        bank_name: text(150, { required: true }),
        account_number: { type: 'account_number', required: true },
        ifsc: { type: 'ifsc', required: true },
        branch_name: text(150),
        account_type: enumOf(ACCOUNT_TYPES, { default: 'CURRENT' }),
      },
    },
    upi_ids: {
      table: `${prefix}_upi_details`,
      entityType: 'UPI',
      label: 'UPI ID',
      sensitive: true,
      verification,
      defaultGroup: 'ALL',
      defaultLabel: defaultUpiLabel,
      unique: ['upi_id'],
      fields: {
        upi_id: { type: 'upi', required: true },
        holder_name: text(150),
      },
    },
    contacts: {
      table: `${prefix}_contacts`,
      entityType: 'CONTACT',
      label: 'Contact person',
      defaultGroup: 'ALL',
      defaultLabel: 'Primary contact',
      fields: {
        name: text(150, { required: true }),
        designation: text(100),
        department: text(100),
        mobile: { type: 'mobile' },
        email: { type: 'email' },
        purpose: enumOf(CONTACT_PURPOSES, { default: 'OTHER' }),
      },
    },
    documents: {
      table: `${prefix}_documents`,
      entityType: 'DOCUMENT',
      label: 'Document',
      verification,
      file: true,
      fields: {
        document_type: enumOf(DOCUMENT_TYPES, { required: true }),
        document_number: text(100),
        issue_date: { type: 'date' },
        expiry_date: { type: 'date' },
        description: text(255),
      },
    },
  };
}

const CLIENT = {
  key: 'clients',
  label: 'Client',
  labelPlural: 'Clients',
  table: 'clients',
  prefix: 'client',
  fk: 'client_id',
  codePrefix: 'CL',
  swaggerTag: '04 Clients',
  categoryField: 'category',
  holdField: 'credit_hold',
  balanceLabels: { outstanding_balance: 'Outstanding Balance', advance_balance: 'Advance Balance' },
  profile: {
    category: enumOf(['RETAIL', 'COMMERCIAL'], { required: true }),
    ...commonProfile(),
    business_name: text(255),
    credit_hold: { type: 'bool', default: 0 },
    // sales settings
    customer_group: text(100),
    price_list: text(100),
    discount_rules: { type: 'json', label: 'e.g. [{"type":"PERCENT","value":5,"min_amount":10000}]' },
    special_pricing: { type: 'json', label: 'e.g. [{"item":"SR-12","price":52,"valid_to":"2027-03-31"}]' },
    salesperson_user_id: { type: 'user_id' },
    salesperson_name: text(150),
    customer_terms: text(2000),
    // delivery settings (delivery locations = addresses of type DELIVERY)
    preferred_transport: enumOf(TRANSPORT_MODES),
    delivery_instructions: text(1000),
    delivery_contact_name: text(150),
    delivery_contact_phone: { type: 'mobile' },
  },
  sensitiveProfile: ['gstin', 'pan', 'gst_registration_type', 'state_code', 'tax_treatment', 'credit_hold'],
  financial: financial({ withCreditLimit: true, openingType: 'DR' }),
  sensitiveFinancial: ['credit_limit', 'opening_balance', 'opening_balance_type', 'opening_balance_date'],
  children: children({
    prefix: 'client',
    addressTypes: ['BILLING', 'SHIPPING', 'DELIVERY', 'OFFICE', 'OTHER'],
    defaultBankLabel: 'Default refund account',
    defaultUpiLabel: 'Default refund UPI',
  }),
  transactionTypes: [
    'QUOTATION', 'SALES_ORDER', 'SALES_INVOICE', 'DELIVERY', 'RECEIPT', 'REFUND', 'SALES_RETURN', 'CREDIT_NOTE',
  ],
};

const VENDOR = {
  key: 'vendors',
  label: 'Vendor',
  labelPlural: 'Vendors',
  table: 'vendors',
  prefix: 'vendor',
  fk: 'vendor_id',
  codePrefix: 'VN',
  swaggerTag: '05 Vendors',
  categoryField: 'vendor_type',
  holdField: 'payment_hold',
  balanceLabels: { outstanding_balance: 'Outstanding Payables', advance_balance: 'Advance Payments' },
  profile: {
    vendor_type: enumOf(
      ['MANUFACTURER', 'DISTRIBUTOR', 'DEALER', 'WHOLESALER', 'SERVICE_PROVIDER', 'OTHER'],
      { required: true }
    ),
    ...commonProfile(),
    trade_name: text(255),
    payment_hold: { type: 'bool', default: 0 },
    // purchase settings
    default_purchase_ledger: text(150),
    purchase_price_list: text(100),
    vendor_item_codes: { type: 'json', label: 'e.g. [{"item":"SR-12","vendor_item_code":"V-ROD-12"}]' },
    purchase_terms: text(2000),
    tax_settings: { type: 'json', label: 'e.g. {"tds_applicable":true,"tds_section":"194C","tds_rate":1,"rcm_applicable":false}' },
    // supply & delivery (dispatch locations = addresses of type DISPATCH)
    lead_time_days: { type: 'int', min: 0, maxValue: 3650 },
    min_order_qty: { type: 'qty', min: 0 },
    min_order_value: { type: 'decimal', min: 0 },
    preferred_transporter: text(150),
    freight_terms: enumOf(FREIGHT_TERMS),
    delivery_instructions: text(1000),
  },
  sensitiveProfile: ['gstin', 'pan', 'gst_registration_type', 'state_code', 'tax_treatment', 'payment_hold'],
  financial: financial({ withCreditLimit: false, openingType: 'CR' }),
  sensitiveFinancial: ['opening_balance', 'opening_balance_type', 'opening_balance_date'],
  children: children({
    prefix: 'vendor',
    addressTypes: ['REGISTERED', 'BILLING', 'SHIPPING', 'DISPATCH', 'OFFICE', 'OTHER'],
    defaultBankLabel: 'Default payment account',
    defaultUpiLabel: 'Default payment UPI',
  }),
  transactionTypes: [
    'PURCHASE_ORDER', 'GOODS_RECEIPT', 'PURCHASE_INVOICE', 'PAYMENT', 'PURCHASE_RETURN', 'DEBIT_NOTE',
  ],
};

for (const cfg of [CLIENT, VENDOR]) {
  cfg.versionTable = `${cfg.prefix}_versions`;
  cfg.financialTable = `${cfg.prefix}_financial_settings`;
  cfg.auditTable = `${cfg.prefix}_audit_logs`;
  cfg.approvalTable = `${cfg.prefix}_approvals`;
}

const PARTY_MODULES = { clients: CLIENT, vendors: VENDOR };

module.exports = { PARTY_MODULES, CLIENT, VENDOR, PAYMENT_MODES };
