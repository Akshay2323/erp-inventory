/** OpenAPI paths + schemas for Client Master and Vendor Master, generated from the module specs. */
const { CHILD_SLUGS } = require('../services/party/childService');

const TYPE_SCHEMAS = {
  text: { type: 'string' },
  email: { type: 'string', format: 'email' },
  mobile: { type: 'string', example: '9876543210' },
  gstin: { type: 'string', example: '27AAPFU0939F1ZV' },
  pan: { type: 'string', example: 'AAPFU0939F' },
  state_code: { type: 'string', example: '27', description: 'GST state code (or state name)' },
  state: { type: 'string', example: 'Maharashtra' },
  pincode: { type: 'string', example: '400001' },
  ifsc: { type: 'string', example: 'HDFC0000123' },
  upi: { type: 'string', example: 'name@okhdfcbank' },
  account_number: { type: 'string', example: '50100123456789' },
  bool: { type: 'boolean' },
  int: { type: 'integer' },
  user_id: { type: 'integer' },
  decimal: { type: 'number' },
  qty: { type: 'number' },
  coord: { type: 'number' },
  date: { type: 'string', format: 'date' },
  json: { oneOf: [{ type: 'object' }, { type: 'array', items: {} }] },
};

function fieldSchema(spec) {
  const s = { ...TYPE_SCHEMAS[spec.type] };
  if (spec.values) s.enum = spec.values;
  if (spec.max) s.maxLength = spec.max;
  if (spec.default !== undefined) s.default = spec.type === 'bool' ? !!spec.default : spec.default;
  if (spec.label) s.description = spec.label;
  return s;
}

function objectSchema(specs, { required = true, extra = {} } = {}) {
  const req = required ? Object.keys(specs).filter((f) => specs[f].required) : [];
  return {
    type: 'object',
    ...(req.length ? { required: req } : {}),
    properties: { ...Object.fromEntries(Object.entries(specs).map(([f, s]) => [f, fieldSchema(s)])), ...extra },
  };
}

const EFFECTIVE = {
  effective_date: {
    type: 'string', format: 'date',
    description: 'Date from which the change applies (default today). Same date as latest version = correction; later = new version; future = scheduled.',
  },
  reason: { type: 'string', description: 'Change reason (stored in audit log / history)' },
};

const p = (name, where = 'path', schema = { type: 'integer' }, extra = {}) => ({
  name, in: where, required: where === 'path', schema, ...extra,
});
const q = (name, schema = { type: 'string' }, description) => p(name, 'query', schema, description ? { description } : {});
const json = (ref) => ({ required: true, content: { 'application/json': { schema: ref } } });
const ok = (description = 'OK') => ({ 200: { description } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

function buildPartySwagger(cfg) {
  const tag = cfg.swaggerTag;
  const L = cfg.label;
  const l = L.toLowerCase();
  const base = `/api/${cfg.key}`;
  const S = (suffix) => `${L}${suffix}`;
  const op = (summary, rest = {}) => ({ tags: [tag], summary, ...rest });
  const id = p('id');
  const rootId = p('rootId');
  const sectionNames = Object.keys(CHILD_SLUGS);
  const sec = p('section', 'path', { type: 'string', enum: sectionNames });

  const childSchemas = {};
  for (const [slug, key] of Object.entries(CHILD_SLUGS)) {
    const c = cfg.children[key];
    childSchemas[S(`_${key}`)] = objectSchema(c.fields, {
      extra: {
        ...(c.defaultGroup ? { is_default: { type: 'boolean', description: c.defaultLabel } } : {}),
        ...(c.file ? { file: { type: 'string', format: 'binary', description: 'PDF/PNG/JPG/WEBP, max 5 MB (multipart only)' } } : {}),
        ...EFFECTIVE,
      },
    });
    childSchemas[S(`_${key}`)].description = `${c.label} — POST/PUT ${base}/{id}/${slug}`;
  }

  const schemas = {
    [S('Create')]: {
      ...objectSchema(cfg.profile, {
        extra: {
          company_id: { type: 'integer' },
          code: { type: 'string', description: `Optional — auto ${cfg.codePrefix}-00001 per company` },
          financial: ref(S('Financial')),
          ...Object.fromEntries(Object.keys(cfg.children).filter((k) => k !== 'documents')
            .map((k) => [k, { type: 'array', items: ref(S(`_${k}`)) }])),
          acknowledge_duplicates: { type: 'boolean', description: 'Continue despite PAN / mobile / email / name duplicate warnings' },
          ...EFFECTIVE,
        },
      }),
      required: ['company_id', ...Object.keys(cfg.profile).filter((f) => cfg.profile[f].required && f !== 'gst_registration_type')],
    },
    [S('Update')]: objectSchema(cfg.profile, {
      required: false,
      extra: {
        acknowledge_duplicates: { type: 'boolean' },
        kyc_status: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'], description: 'Update KYC on the same PUT (also available via POST …/kyc)' },
        kyc_remarks: { type: 'string' },
        ...EFFECTIVE,
      },
    }),
    [S('Financial')]: objectSchema(cfg.financial, { required: false, extra: EFFECTIVE }),
    ...childSchemas,
  };

  const sensitive = [
    ...cfg.sensitiveProfile, ...cfg.sensitiveFinancial,
    ...Object.values(cfg.children).filter((c) => c.sensitive).map((c) => `${c.label.toLowerCase()}s`),
  ].join(', ');
  const approvalNote = `Sensitive changes (${sensitive}) by users without \`${cfg.key}.approve\` return **202 PENDING_APPROVAL** and apply only after approval.`;

  const paths = {
    [`${base}/meta`]: { get: op(`${L} form metadata — fields, enums, GST state codes, your permissions`, { responses: ok() }) },
    [`${base}/audit-logs`]: {
      get: op(`${L} audit log / history viewer (all ${l}s)`, {
        description: `Requires \`${cfg.key}.audit\`. Field-level old/new values, who, when, reason, approval.`,
        parameters: [
          q(cfg.fk, { type: 'integer' }), q('company_id', { type: 'integer' }),
          q('entity_type', { type: 'string', enum: ['RECORD', 'PROFILE', 'FINANCIAL', 'ADDRESS', 'GST', 'BANK', 'UPI', 'CONTACT', 'DOCUMENT'] }),
          q('entity_id', { type: 'integer' }), q('field'), q('action'), q('changed_by'),
          q('approval_status', { type: 'string', enum: ['AUTO_APPROVED', 'PENDING', 'APPROVED', 'REJECTED'] }),
          q('from', { type: 'string', format: 'date' }, 'changed_at from'), q('to', { type: 'string', format: 'date' }, 'changed_at to'),
          q('effective_from', { type: 'string', format: 'date' }), q('effective_to', { type: 'string', format: 'date' }),
          q('financial_year', { type: 'string', example: '2026-27' }), q('search'),
          q('page', { type: 'integer' }), q('limit', { type: 'integer', maximum: 500 }),
        ],
        responses: ok(),
      }),
    },
    [`${base}/approvals`]: {
      get: op(`${L} approval queue`, {
        parameters: [
          q('status', { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL'], default: 'PENDING' }),
          q('company_id', { type: 'integer' }), q(cfg.fk, { type: 'integer' }),
        ],
        responses: ok(),
      }),
    },
    [`${base}/approvals/{approvalId}/decision`]: {
      post: op('Approve / reject a pending change', {
        description: 'APPROVE applies the queued change (as of its effective date). REJECT requires remarks.',
        parameters: [p('approvalId')],
        requestBody: json({
          type: 'object', required: ['action'],
          properties: { action: { type: 'string', enum: ['APPROVE', 'REJECT'] }, remarks: { type: 'string' } },
        }),
        responses: ok(),
      }),
    },
    [`${base}/approvals/{approvalId}/cancel`]: {
      post: op('Withdraw a pending change (requester or approver)', { parameters: [p('approvalId')], responses: ok() }),
    },
    [`${base}/duplicates`]: {
      get: op(`Duplicate scan — ${l}s sharing GSTIN / PAN / mobile / email / name`, {
        parameters: [q('company_id', { type: 'integer' })], responses: ok(),
      }),
    },
    [`${base}/check-duplicates`]: {
      post: op('Live duplicate check while filling the form', {
        requestBody: json({
          type: 'object', required: ['company_id'],
          properties: {
            company_id: { type: 'integer' }, exclude_id: { type: 'integer' }, name: { type: 'string' },
            legal_name: { type: 'string' }, gstin: { type: 'string' }, pan: { type: 'string' },
            mobile: { type: 'string' }, alt_mobile: { type: 'string' }, email: { type: 'string' },
          },
        }),
        responses: ok('{ errors: [GSTIN matches], warnings: [PAN/MOBILE/EMAIL/NAME matches] }'),
      }),
    },
    [base]: {
      get: op(`List ${l}s (details effective on as_of)`, {
        parameters: [
          q('company_id', { type: 'integer' }), q('as_of', { type: 'string', format: 'date' }),
          q(cfg.categoryField, { type: 'string', enum: cfg.profile[cfg.categoryField].values }),
          q('status', { type: 'string', enum: ['ACTIVE', 'INACTIVE'] }),
          q('approval_status', { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] }),
          q('kyc_status', { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] }),
          q(cfg.holdField, { type: 'boolean' }), q('state_code'), q('search'),
          q('include_merged', { type: 'boolean' }), q('page', { type: 'integer' }), q('limit', { type: 'integer' }),
        ],
        responses: ok(),
      }),
      post: op(`Add ${l}`, {
        description: [
          `Profile + optional \`financial\` and child arrays (${Object.keys(cfg.children).filter((k) => k !== 'documents').join(', ')}) in one request.`,
          'GSTIN is validated (checksum); state_code and PAN are derived from it. gst_registration_type defaults to REGULAR when GSTIN is given.',
          'GSTIN duplicate = 409. PAN / mobile / email / name duplicate = 409 warning — resend with acknowledge_duplicates=true.',
          `Created ${l} is APPROVED when the creator has \`${cfg.key}.approve\`, otherwise PENDING approval.`,
          'effective_date (default today) cannot be before the company effective date.',
        ].join('\n\n'),
        requestBody: json(ref(S('Create'))),
        responses: { 201: { description: 'Created' }, 409: { description: 'Duplicate (see details)' } },
      }),
    },
    [`${base}/{id}`]: {
      get: op(`${L} detail as of a date (profile, financial, all sections, upcoming changes, pending approvals)`, {
        parameters: [id, q('as_of', { type: 'string', format: 'date' }), q('include_inactive', { type: 'boolean' })],
        responses: ok(),
      }),
      put: op(`Edit ${l} profile with effective date`, {
        description: `Send only changed fields. ${approvalNote} Set status=INACTIVE (optionally future-dated) to deactivate — nothing is deleted. KYC: send \`kyc_status\` (PENDING/VERIFIED/REJECTED) here, or use POST \`/{id}/kyc\`.`,
        parameters: [id], requestBody: json(ref(S('Update'))),
        responses: { 200: { description: 'APPLIED' }, 202: { description: 'PENDING_APPROVAL' } },
      }),
    },
    [`${base}/{id}/financial`]: {
      put: op('Edit financial settings with effective date', {
        description: `${approvalNote} Outstanding / advance balances are maintained by transactions, not editable here.`,
        parameters: [id], requestBody: json(ref(S('Financial'))),
        responses: { 200: { description: 'APPLIED' }, 202: { description: 'PENDING_APPROVAL' } },
      }),
    },
    [`${base}/{id}/versions`]: {
      get: op('Profile + financial version history (effective dates)', { parameters: [id], responses: ok() }),
    },
    [`${base}/{id}/profile-versions/{versionId}`]: {
      delete: op('Cancel a scheduled (future) profile change', { parameters: [id, p('versionId')], responses: ok() }),
    },
    [`${base}/{id}/financial-versions/{versionId}`]: {
      delete: op('Cancel a scheduled (future) financial change', { parameters: [id, p('versionId')], responses: ok() }),
    },
    [`${base}/{id}/approval`]: {
      post: op(`Approve / reject the ${l} record`, {
        parameters: [id],
        requestBody: json({
          type: 'object', required: ['action'],
          properties: { action: { type: 'string', enum: ['APPROVE', 'REJECT'] }, remarks: { type: 'string' } },
        }),
        responses: ok(),
      }),
    },
    [`${base}/{id}/kyc`]: {
      post: op('Set KYC status (PENDING / VERIFIED / REJECTED) — needs .approve permission', {
        parameters: [id],
        requestBody: json({
          type: 'object', required: ['status'],
          properties: { status: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] }, remarks: { type: 'string' } },
        }),
        responses: ok(),
      }),
    },
    [`${base}/{id}/merge`]: {
      post: op(`Merge this duplicate ${l} into another (needs ${cfg.key}.merge)`, {
        description: 'Source becomes INACTIVE and points to the target. Its history, audit log and transactions are kept and shown under the target.',
        parameters: [id],
        requestBody: json({
          type: 'object', required: ['into_id', 'reason'],
          properties: { into_id: { type: 'integer' }, reason: { type: 'string' } },
        }),
        responses: ok(),
      }),
    },
    [`${base}/{id}/snapshot`]: {
      get: op('Transaction snapshot — details as on a date (store on invoices / vouchers)', {
        parameters: [id, q('date', { type: 'string', format: 'date' })], responses: ok(),
      }),
    },
    [`${base}/{id}/transactions`]: {
      get: op(`Linked transactions (${cfg.transactionTypes.join(', ')})`, {
        description: 'Includes records merged into this one. Types show available=false until the sales / purchase modules exist.',
        parameters: [id, q('from', { type: 'string', format: 'date' }), q('to', { type: 'string', format: 'date' })],
        responses: ok(),
      }),
    },
    [`${base}/{id}/audit-logs`]: {
      get: op(`Audit log of one ${l} (same filters as /audit-logs)`, {
        parameters: [id, q('entity_type'), q('field'), q('from', { type: 'string', format: 'date' }),
          q('to', { type: 'string', format: 'date' }), q('financial_year'), q('changed_by'), q('page', { type: 'integer' })],
        responses: ok(),
      }),
    },
    [`${base}/{id}/documents/{rootId}/file`]: {
      get: op('Download / view a KYC document', {
        parameters: [id, rootId, q('version_id', { type: 'integer' }, 'Older file version (default latest)')],
        responses: ok('File'),
      }),
    },
    [`${base}/{id}/{section}`]: {
      get: op('List a section (addresses, gst-registrations, bank-accounts, upi-ids, contacts, documents)', {
        parameters: [id, sec, q('as_of', { type: 'string', format: 'date' }), q('include_inactive', { type: 'boolean' })],
        responses: ok(),
      }),
      post: op('Add to a section with effective date', {
        description: `Body schema per section: ${Object.keys(childSchemas).join(', ')}. Documents: multipart/form-data with \`file\`. ${approvalNote}`,
        parameters: [id, sec],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { oneOf: Object.keys(childSchemas).filter((k) => !k.endsWith('documents')).map(ref) } },
            'multipart/form-data': { schema: ref(S('_documents')) },
          },
        },
        responses: { 201: { description: 'APPLIED' }, 202: { description: 'PENDING_APPROVAL' } },
      }),
    },
    [`${base}/{id}/{section}/{rootId}`]: {
      put: op('Edit a section record with effective date (send changed fields only)', {
        description: `Bank / UPI / document edits reset verification to UNVERIFIED. ${approvalNote}`,
        parameters: [id, sec, rootId],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: true } },
            'multipart/form-data': { schema: ref(S('_documents')) },
          },
        },
        responses: { 200: { description: 'APPLIED' }, 202: { description: 'PENDING_APPROVAL' } },
      }),
    },
    [`${base}/{id}/{section}/{rootId}/deactivate`]: {
      post: op('Deactivate a section record from a date (kept in history)', {
        parameters: [id, sec, rootId], requestBody: json({ type: 'object', properties: EFFECTIVE }), responses: ok(),
      }),
    },
    [`${base}/{id}/{section}/{rootId}/reactivate`]: {
      post: op('Reactivate a section record from a date', {
        parameters: [id, sec, rootId], requestBody: json({ type: 'object', properties: EFFECTIVE }), responses: ok(),
      }),
    },
    [`${base}/{id}/{section}/{rootId}/default`]: {
      post: op('Set as default (address per type, refund / payment bank, UPI, primary contact)', {
        parameters: [id, sec, rootId], requestBody: json({ type: 'object', properties: { reason: { type: 'string' } } }), responses: ok(),
      }),
    },
    [`${base}/{id}/{section}/{rootId}/verify`]: {
      post: op(`Verify bank account / UPI / document (needs ${cfg.key}.approve)`, {
        parameters: [id, sec, rootId],
        requestBody: json({
          type: 'object', required: ['status'],
          properties: { status: { type: 'string', enum: ['VERIFIED', 'REJECTED', 'UNVERIFIED'] }, remarks: { type: 'string' } },
        }),
        responses: ok(),
      }),
    },
    [`${base}/{id}/{section}/{rootId}/history`]: {
      get: op('Version + change history of a section record (old / new values)', { parameters: [id, sec, rootId], responses: ok() }),
    },
    [`${base}/{id}/{section}/{rootId}/versions/{versionId}`]: {
      delete: op('Cancel a scheduled (future) change of a section record', {
        parameters: [id, sec, rootId, p('versionId')], responses: ok(),
      }),
    },
  };

  return { paths, schemas };
}

module.exports = { buildPartySwagger };
