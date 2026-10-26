/** OpenAPI paths for /api/accounting, /api/sales and /api/purchases. */
const {
  LEDGER_GROUPS, MAPPING_KEYS, GST_RATES, PAYMENT_MODES, SIDES,
} = require('./accountingConfig');

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
  effective_date: { ...date, description: 'Applies from this date (default today). Same date as latest version = correction; later = new version; future = scheduled.' },
  reason: { type: 'string' },
};

function accountingPaths() {
  const tag = '07 Accounting';
  const op = (summary, rest = {}) => ({ tags: [tag], summary, ...rest });
  const cid = p('companyId');
  const id = p('id');
  const settingsProps = {
    trade_name: { type: 'string' }, gstin: { type: 'string', example: '27AAPFU0939F1ZV' }, pan: { type: 'string' },
    gst_registration_type: { type: 'string', enum: ['REGULAR', 'COMPOSITION', 'UNREGISTERED', 'SEZ'] },
    state_code: { type: 'string', example: '27' }, address: { type: 'string' }, city: { type: 'string' }, pincode: { type: 'string' },
    phone: { type: 'string' }, email: { type: 'string' }, invoice_round_off: { type: 'boolean', default: true },
    eway_bill_threshold: { type: 'number', default: 50000 }, credit_limit_action: { type: 'string', enum: ['BLOCK', 'WARN'] },
    invoice_terms: { type: 'string' },
  };
  const ledgerProps = {
    name: { type: 'string' }, ledger_group: { type: 'string', enum: Object.keys(LEDGER_GROUPS) },
    status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] }, description: { type: 'string' },
    bank_account_no: { type: 'string' }, ifsc: { type: 'string' },
    opening_balance: { type: 'number', description: 'Books opening balance (not for Sundry Debtors / Creditors)' },
    opening_type: { type: 'string', enum: ['DR', 'CR'] },
  };
  return {
    '/api/accounting/meta': { get: op('Ledger groups, mapping keys, numbering tokens, your permissions', { responses: ok() }) },
    '/api/accounting/companies/{companyId}/setup': {
      post: op('Set up books for a company (once)', {
        description: 'Creates books start date, financial years, company GST settings (effective from books start), default ledgers, ledger mapping and voucher numbering.',
        parameters: [cid],
        requestBody: body(obj({
          books_start_date: { ...date, description: 'Default: start of current financial year' },
          fy_start_month: { type: 'integer', default: 4, description: '4 = April-March' },
          ...settingsProps, reason: { type: 'string' },
        }, ['state_code']), { india: { value: { books_start_date: '2026-04-01', gstin: '27AAPFU0939F1ZV', trade_name: 'My Company', city: 'Mumbai', pincode: '400001' } } }),
        responses: { 201: { description: 'Created' }, 409: { description: 'Already set up' } },
      }),
    },
    '/api/accounting/companies/{companyId}/settings': {
      get: op('Company accounting settings as of a date + history', { parameters: [cid, q('as_of', date)], responses: ok() }),
      put: op('Edit company settings with effective date (GSTIN, state, round-off, e-way threshold, credit control …)', {
        description: 'Vouchers dated on / after the effective date use the new settings; older vouchers keep the settings stored on them.',
        parameters: [cid], requestBody: body(obj({ ...settingsProps, ...EFFECTIVE })), responses: ok(),
      }),
    },
    '/api/accounting/companies/{companyId}/settings-versions/{versionId}': {
      delete: op('Cancel a scheduled settings change', { parameters: [cid, p('versionId')], responses: ok() }),
    },
    '/api/accounting/companies/{companyId}/financial-years': {
      get: op('Financial years (created automatically from books start)', { parameters: [cid], responses: ok() }),
      post: op('Create the next financial year in advance', { parameters: [cid], responses: { 201: { description: 'Created' } } }),
    },
    '/api/accounting/financial-years/{id}/close': {
      post: op('Close a financial year (no vouchers / allocations can be added or changed in it)', {
        parameters: [id], requestBody: body(obj({ reason: { type: 'string' } }, ['reason'])), responses: ok(),
      }),
    },
    '/api/accounting/financial-years/{id}/reopen': {
      post: op('Reopen a closed financial year', { parameters: [id], requestBody: body(obj({ reason: { type: 'string' } }, ['reason'])), responses: ok() }),
    },
    '/api/accounting/companies/{companyId}/ledger-mappings': {
      get: op('Ledger mapping (which ledger each posting goes to) as of a date', { parameters: [cid, q('as_of', date)], responses: ok() }),
      put: op('Change ledger mapping from an effective date', {
        description: `Keys: ${Object.keys(MAPPING_KEYS).join(', ')}. Vouchers dated from the effective date post to the new ledger.`,
        parameters: [cid],
        requestBody: body(obj({ mappings: { type: 'object', additionalProperties: { type: 'integer' }, example: { SALES: 25 } }, ...EFFECTIVE }, ['mappings'])),
        responses: ok(),
      }),
    },
    '/api/accounting/ledgers': {
      get: op('Chart of accounts as of a date', {
        parameters: [q('company_id', { type: 'integer' }), q('as_of', date), q('group', { type: 'string', enum: Object.keys(LEDGER_GROUPS) }), q('status'), q('search')],
        responses: ok(),
      }),
      post: op('Add ledger', {
        requestBody: body(obj({ company_id: { type: 'integer' }, code: { type: 'string' }, ...ledgerProps, ...EFFECTIVE }, ['company_id', 'name', 'ledger_group']),
          { bank: { value: { company_id: 1, code: 'HDFC-CA', name: 'HDFC Current A/c', ledger_group: 'BANK', ifsc: 'HDFC0000123' } } }),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/accounting/ledgers/{id}': {
      get: op('Ledger detail + history + mapping keys', { parameters: [id, q('as_of', date)], responses: ok() }),
      put: op('Edit ledger with effective date (name / group / status are versioned)', { parameters: [id], requestBody: body(obj({ ...ledgerProps, ...EFFECTIVE })), responses: ok() }),
    },
    '/api/accounting/ledgers/{id}/versions/{versionId}': { delete: op('Cancel a scheduled ledger change', { parameters: [id, p('versionId')], responses: ok() }) },
    '/api/accounting/ledgers/{id}/statement': {
      get: op('Ledger statement (opening, entries, running balance)', { parameters: [id, q('from', date), q('to', date), q('month', { type: 'string', example: '2026-10' })], responses: ok() }),
    },
    '/api/accounting/voucher-series': {
      get: op('Voucher numbering series + counters per financial year', { parameters: [q('company_id', { type: 'integer' }), q('voucher_type'), q('as_of', date)], responses: ok() }),
      post: op('Add numbering series (e.g. per branch)', {
        description: 'Tokens: {FY} 26-27, {FYFULL} 2026-27, {YYYY}, {YY}, {MM}, {SEQ}. GST invoice / note numbers must be at most 16 characters.',
        requestBody: body(obj({
          company_id: { type: 'integer' }, voucher_type: { type: 'string' }, name: { type: 'string' }, branch_id: { type: 'integer' },
          format: { type: 'string', example: 'SRT/{FY}/{SEQ}' }, padding: { type: 'integer', default: 4 }, is_default: { type: 'boolean' }, ...EFFECTIVE,
        }, ['company_id', 'voucher_type', 'name', 'format'])),
        responses: { 201: { description: 'Created' } },
      }),
    },
    '/api/accounting/voucher-series/{id}': {
      get: op('Numbering series detail', { parameters: [id], responses: ok() }),
      put: op('Change numbering format from an effective date / make default', {
        parameters: [id],
        requestBody: body(obj({ format: { type: 'string' }, padding: { type: 'integer' }, status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] }, is_default: { type: 'boolean' }, ...EFFECTIVE })),
        responses: ok(),
      }),
    },
    '/api/accounting/voucher-series/{id}/versions/{versionId}': { delete: op('Cancel a scheduled format change', { parameters: [id, p('versionId')], responses: ok() }) },
    '/api/accounting/voucher-series/{id}/preview': { get: op('Next number that would be issued on a date', { parameters: [id, q('date', date)], responses: ok() }) },
    '/api/accounting/trial-balance': {
      get: op('Trial balance', { parameters: [q('company_id', { type: 'integer' }), q('from', date), q('to', date), q('include_zero', { type: 'boolean' })], responses: ok() }),
    },
    '/api/accounting/reconciliation': {
      get: op('Account reconciliation checks', {
        description: 'Party ledger vs bill-wise outstanding, master balances, opening bills vs master opening, control ledgers vs party totals, balanced postings, trial balance.',
        parameters: [q('company_id', { type: 'integer' })], responses: ok(),
      }),
    },
    '/api/accounting/reconciliation/refresh-balances': {
      post: op('Recalculate client / vendor outstanding & advance balances', { requestBody: body(obj({ company_id: { type: 'integer' } }, ['company_id'])), responses: ok() }),
    },
    '/api/accounting/bank-reconciliation': {
      get: op('Bank reconciliation (uncleared receipts / payments)', { parameters: [q('ledger_id', { type: 'integer' }), q('as_of', date)], responses: ok() }),
    },
    '/api/accounting/audit-logs': {
      get: op('Accounting audit log (settings, years, ledgers, mapping, numbering)', {
        parameters: [q('company_id', { type: 'integer' }), q('entity_type'), q('entity_id', { type: 'integer' }), q('action'), q('field'),
          q('changed_by'), q('financial_year'), q('from', date), q('to', date), q('page', { type: 'integer' })],
        responses: ok(),
      }),
    },
  };
}

function sidePaths(side) {
  const tag = side.swaggerTag;
  const base = `/api/${side.key}`;
  const fk = side.partyFk;
  const op = (summary, rest = {}) => ({ tags: [tag], summary, ...rest });
  const id = p('id');
  const types = Object.keys(side.voucherTypes).filter((t) => !side.voucherTypes[t].opening);
  const invoice = types.find((t) => side.voucherTypes[t].due);
  const settle = types.find((t) => side.voucherTypes[t].cash && side.voucherTypes[t].effect !== side.voucherTypes[invoice].effect);
  const ret = types.find((t) => side.voucherTypes[t].against);
  const line = obj({
    ledger_id: { type: 'integer', description: `Optional — default: mapped ${side.voucherTypes[invoice].lineKey} ledger` },
    item_code: { type: 'string' }, description: { type: 'string' }, hsn_sac: { type: 'string', example: '7214' },
    qty: { type: 'number', default: 1 }, unit: { type: 'string', example: 'KGS' }, rate: { type: 'number' },
    discount_percent: { type: 'number' }, gst_rate: { type: 'number', enum: GST_RATES }, cess_rate: { type: 'number' },
    ...(side.key === 'purchases' ? { itc_eligible: { type: 'boolean', default: true } } : {}),
  }, ['description', 'rate']);
  const voucherProps = {
    company_id: { type: 'integer' }, voucher_type: { type: 'string', enum: types }, [fk]: { type: 'integer' },
    voucher_date: { ...date, description: 'Transaction date — party, company GST and ledger details effective on this date are used and stored' },
    branch_id: { type: 'integer' }, series_id: { type: 'integer', description: 'Optional numbering series' },
    reference_no: { type: 'string', description: side.key === 'purchases' ? 'Supplier invoice no (required for PURCHASE_INVOICE)' : 'Customer PO / reference' },
    reference_date: date, due_date: { ...date, description: 'Default: voucher date + credit period' },
    place_of_supply: { type: 'string', description: 'GST state code — default from shipping address / party' },
    tax_treatment: { type: 'string' }, ...(side.key === 'purchases' ? { reverse_charge: { type: 'boolean' } } : {}),
    billing_address_id: { type: 'integer' }, shipping_address_id: { type: 'integer' },
    against_voucher_id: { type: 'integer', description: `Original ${invoice} (returns / notes) — adjusted automatically` },
    lines: { type: 'array', items: line },
    amount: { type: 'number', description: 'Receipt / payment / refund amount' },
    payment_mode: { type: 'string', enum: PAYMENT_MODES }, cash_bank_ledger_id: { type: 'integer' },
    instrument_no: { type: 'string' }, instrument_date: date,
    allocations: { type: 'array', items: obj({ voucher_id: { type: 'integer' }, amount: { type: 'number' } }), description: 'Bill-wise adjustment' },
    auto_allocate: { type: 'boolean', description: 'Adjust against oldest open bills (FIFO)' },
    ...(side.key === 'sales' ? { override_credit_limit: { type: 'boolean', description: 'Needs sales.approve' } } : {}),
    narration: { type: 'string' }, reason: { type: 'string' },
  };
  const examples = {
    [invoice]: {
      value: {
        company_id: 1, voucher_type: invoice, [fk]: 1, voucher_date: '2026-10-14',
        ...(side.key === 'purchases' ? { reference_no: 'SUP/1023', reference_date: '2026-10-12' } : {}),
        lines: [{ description: 'TMT Bar 12mm', hsn_sac: '7214', qty: 1000, unit: 'KGS', rate: 58, gst_rate: 18 }],
      },
    },
    [settle]: { value: { company_id: 1, voucher_type: settle, [fk]: 1, amount: 50000, payment_mode: 'NEFT', instrument_no: 'UTR123', auto_allocate: true } },
    [ret]: { value: { company_id: 1, voucher_type: ret, [fk]: 1, against_voucher_id: 1, lines: [{ description: 'TMT Bar 12mm returned', hsn_sac: '7214', qty: 50, unit: 'KGS', rate: 58, gst_rate: 18 }] } },
  };
  const party = `${base}/${side.partyPath}/{partyId}`;
  const summary = side.key === 'sales' ? 'receivables' : 'payables';
  return {
    [`${base}/meta`]: { get: op('Voucher types, GST rates, payment modes, your permissions', { responses: ok() }) },
    [`${base}/vouchers`]: {
      get: op(`${side.label} vouchers`, {
        parameters: [q('company_id', { type: 'integer' }), q('voucher_type', { type: 'string', enum: types }), q(fk, { type: 'integer' }),
          q('status', { type: 'string', enum: ['POSTED', 'CANCELLED'] }), q('branch_id', { type: 'integer' }), q('from', date), q('to', date),
          q('search'), q('open_only', { type: 'boolean' }), q('page', { type: 'integer' }), q('limit', { type: 'integer' })],
        responses: ok(),
      }),
      post: op(`Add ${types.join(' / ')}`, {
        description: [
          `Linked only to ${side.partyCfg.label} Master. GST (CGST+SGST or IGST) is calculated from company state vs place of supply on the voucher date.`,
          'Posts to the general ledger via the ledger mapping effective on the voucher date and stores the party / company details of that date.',
          side.key === 'sales' ? 'Sales invoices check credit hold and credit limit.' : 'Payments are blocked while the vendor is on payment hold.',
          'Unallocated receipts / payments stay as advances.',
        ].join('\n\n'),
        requestBody: body(obj(voucherProps, ['company_id', 'voucher_type', fk]), examples),
        responses: { 201: { description: 'Posted (response includes warnings, e.g. e-way bill required)' }, 409: { description: 'Credit limit / hold / duplicate supplier invoice' } },
      }),
    },
    [`${base}/vouchers/{id}`]: {
      get: op('Voucher with lines, allocations, e-way bill, ledger entries', { parameters: [id], responses: ok() }),
      put: op('Amend voucher (new revision)', {
        description: 'Send changed fields (lines replace all lines). reason is required. Previous revision is kept; ledger entries are reversed and re-posted. Date must stay in the same financial year.',
        parameters: [id], requestBody: body(obj(voucherProps, ['reason'])), responses: ok(),
      }),
    },
    [`${base}/vouchers/{id}/cancel`]: {
      post: op('Cancel voucher (allocations released, ledger reversed; number is kept)', { parameters: [id], requestBody: body(obj({ reason: { type: 'string' } }, ['reason'])), responses: ok() }),
    },
    [`${base}/vouchers/{id}/revisions`]: { get: op('Previous revisions of a voucher', { parameters: [id], responses: ok() }) },
    [`${base}/vouchers/{id}/auto-allocate`]: {
      post: op('Adjust open amount against oldest open items (FIFO)', { parameters: [id], requestBody: body(obj({ allocation_date: date })), responses: ok() }),
    },
    [`${base}/vouchers/{id}/bank-clearance`]: {
      post: op('Mark receipt / payment cleared in bank (null = uncleared)', { parameters: [id], requestBody: body(obj({ cleared_on: date, reason: { type: 'string' } })), responses: ok() }),
    },
    [`${base}/vouchers/{id}/eway-bill`]: {
      post: op('Record e-way bill', {
        parameters: [id],
        requestBody: body(obj({
          eway_bill_no: { type: 'string', example: '331001234567' }, eway_bill_date: { type: 'string', example: '2026-10-14 10:30' },
          distance_km: { type: 'integer' }, transport_mode: { type: 'string', enum: ['ROAD', 'RAIL', 'AIR', 'SHIP'] },
          vehicle_no: { type: 'string', example: 'MH12AB1234' }, vehicle_type: { type: 'string', enum: ['REGULAR', 'ODC'] },
          transporter_id: { type: 'string' }, transporter_name: { type: 'string' }, transport_doc_no: { type: 'string' }, transport_doc_date: date,
        }, ['eway_bill_no', 'distance_km'])),
        responses: { 201: { description: 'Recorded — validity computed (200 km per day)' } },
      }),
      put: op('Update Part-B (vehicle / transport document)', {
        parameters: [id],
        requestBody: body(obj({ vehicle_no: { type: 'string' }, transport_mode: { type: 'string' }, transport_doc_no: { type: 'string' }, transport_doc_date: date,
          reason: { type: 'string', enum: ['FIRST_TIME', 'BREAKDOWN', 'TRANSSHIPMENT', 'OTHERS'] } }, ['reason'])),
        responses: ok(),
      }),
    },
    [`${base}/vouchers/{id}/eway-bill/cancel`]: {
      post: op('Cancel e-way bill (within 24 hours)', { parameters: [id], requestBody: body(obj({ reason: { type: 'string' } }, ['reason'])), responses: ok() }),
    },
    [`${base}/vouchers/{id}/eway-bill/json`]: {
      get: op('E-way bill portal JSON (bulk upload format)', { parameters: [id, q('distance_km', { type: 'integer' }, 'When no e-way bill is recorded yet')], responses: ok() }),
    },
    [`${base}/allocations`]: {
      post: op('Bill-wise adjustment (advance / receipt / return against a bill)', {
        requestBody: body(obj({ from_voucher_id: { type: 'integer' }, to_voucher_id: { type: 'integer' }, amount: { type: 'number' }, allocation_date: date, remarks: { type: 'string' } },
          ['from_voucher_id', 'to_voucher_id', 'amount'])),
        responses: { 201: { description: 'Allocated' } },
      }),
    },
    [`${base}/allocations/{id}/reverse`]: {
      post: op('Reverse an allocation', { parameters: [id], requestBody: body(obj({ reason: { type: 'string' } }, ['reason'])), responses: ok() }),
    },
    [`${party}/opening-bills`]: {
      get: op(`Opening bills of a ${side.partyCfg.label.toLowerCase()} vs master opening balance`, { parameters: [p('partyId')], responses: ok() }),
      put: op(`Set bill-wise opening balance of a ${side.partyCfg.label.toLowerCase()}`, {
        description: 'Replaces opening bills (posted on the books start date). Without `bills`, one bill is created from the master opening balance.',
        parameters: [p('partyId')],
        requestBody: body(obj({
          bills: { type: 'array', items: obj({ bill_no: { type: 'string' }, bill_date: date, due_date: date, amount: { type: 'number' }, balance_type: { type: 'string', enum: ['DR', 'CR'] } }, ['bill_no', 'amount']) },
          reason: { type: 'string' },
        })),
        responses: ok(),
      }),
    },
    [`${party}/statement`]: {
      get: op(`${side.partyCfg.label} ledger statement (opening, entries, running balance, open bills)`, {
        parameters: [p('partyId'), q('from', date), q('to', date), q('month', { type: 'string' })], responses: ok(),
      }),
    },
    [`${base}/outstanding`]: {
      get: op('Bill-wise outstanding (open bills + unadjusted advances / credits)', { parameters: [q('company_id', { type: 'integer' }), q(fk, { type: 'integer' }), q('as_of', date)], responses: ok() }),
    },
    [`${base}/${summary}`]: {
      get: op(`${side.partyCfg.label}-wise ${summary} (outstanding, overdue, advance, ledger balance)`, {
        parameters: [q('company_id', { type: 'integer' }), q(fk, { type: 'integer' }), q('as_of', date)], responses: ok(),
      }),
    },
    [`${base}/ageing`]: {
      get: op('Ageing report', {
        parameters: [q('company_id', { type: 'integer' }), q(fk, { type: 'integer' }), q('as_of', date),
          q('basis', { type: 'string', enum: ['DUE_DATE', 'BILL_DATE'] }), q('buckets', { type: 'string', example: '30,60,90,180' })],
        responses: ok(),
      }),
    },
    [`${base}/register`]: {
      get: op(`${side.label} register (by voucher type and month)`, { parameters: [q('company_id', { type: 'integer' }), q('from', date), q('to', date), q('month')], responses: ok() }),
    },
    [`${base}/gst-report`]: {
      get: op(side.key === 'sales' ? 'GSTR-1 data (B2B, B2CL, B2CS, exports, credit notes, nil / exempt, HSN, documents)' : 'Purchase GST / ITC report (B2B by supplier, reverse charge, notes, ITC summary, HSN)', {
        description: 'Uses the GSTIN / state / place of supply stored on each voucher (transaction-time details).',
        parameters: [q('company_id', { type: 'integer' }), q('month', { type: 'string', example: '2026-10' }), q('from', date), q('to', date)],
        responses: ok(),
      }),
    },
    [`${base}/eway-bills/pending`]: {
      get: op('Vouchers above the e-way bill threshold without an e-way bill', { parameters: [q('company_id', { type: 'integer' }), q('from', date), q('to', date)], responses: ok() }),
    },
    [`${base}/audit-logs`]: {
      get: op(`${side.label} audit log (vouchers, allocations, e-way bills, opening bills)`, {
        parameters: [q('company_id', { type: 'integer' }), q('voucher_id', { type: 'integer' }), q(fk, { type: 'integer' }), q('entity_type'),
          q('action'), q('field'), q('changed_by'), q('financial_year'), q('from', date), q('to', date), q('page', { type: 'integer' })],
        responses: ok(),
      }),
    },
  };
}

function buildAccountingSwagger() {
  return {
    tags: [
      { name: '07 Accounting', description: 'STEP 6 — Company books: settings (effective date), financial years, ledgers, ledger mapping, voucher numbering, trial balance, reconciliation' },
      { name: '08 Sales', description: 'STEP 7 — Sales linked to Client Master: invoices, receipts, refunds, returns, credit notes, outstanding, ageing, statements, GSTR-1, e-way bills' },
      { name: '09 Purchases', description: 'STEP 8 — Purchases linked to Vendor Master: invoices, payments, returns, debit notes, payables, ageing, statements, ITC report, e-way bills' },
    ],
    paths: { ...accountingPaths(), ...Object.values(SIDES).reduce((acc, side) => ({ ...acc, ...sidePaths(side) }), {}) },
  };
}

module.exports = { buildAccountingSwagger };
