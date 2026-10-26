const swaggerJsdoc = require('swagger-jsdoc');
const { PARTY_MODULES } = require('./partyModules');
const { buildPartySwagger } = require('./partySwagger');
const { buildProductSwagger } = require('./productSwagger');
const { buildAccountingSwagger } = require('./accountingSwagger');

const port = process.env.PORT || 4000;

/** Tag order = Swagger sidebar order (step-by-step workflow) */
const TAGS = [
  {
    name: '00 Auth',
    description: 'Dual login — inventory local OR portal (redirect Sanctum token)',
  },
  {
    name: '01 Health',
    description: 'STEP 0 — Check API is online',
  },
  {
    name: '02 Companies',
    description: 'STEP 1 — Company master: add/edit with effective date, logo, auto-fetch from HRMS',
  },
  {
    name: '03 Branches',
    description: 'STEP 2 — Company-wise branches: effective date, map location (India), auto-fetch from HRMS',
  },
  {
    name: '04 Clients',
    description: 'STEP 3 — Client Master: GST, addresses, bank / UPI, contacts, KYC documents, effective-date history, approvals, audit log',
  },
  {
    name: '05 Vendors',
    description: 'STEP 4 — Vendor Master: GST, addresses, bank / UPI, contacts, KYC documents, effective-date history, approvals, audit log',
  },
];

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'inventory-app',
      version: '2.0.0',
      description: `
All APIs require token except \`/api/auth/login\`, \`/api/auth/portal-login\`, \`/api/auth/register\`.

**Two login ways:** (1) Inventory local \`POST /api/auth/login\` (2) Portal \`POST /api/auth/portal-login\` or pass redirect Sanctum token in Authorization header.
      `.trim(),
    },
    servers: [
      {
        url: '/',
        description: 'Same host as this docs page (recommended)',
      },
      {
        url: `http://localhost:${port}`,
        description: 'Localhost',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: TAGS,
  },
  apis: ['./src/routes/*.js', './src/server.js'],
};

/** Hidden from Swagger UI (APIs stay mounted). */
const HIDDEN_TAGS = new Set([
]);

const spec = swaggerJsdoc(options);
for (const cfg of Object.values(PARTY_MODULES)) {
  const { paths, schemas } = buildPartySwagger(cfg);
  Object.assign(spec.paths, paths);
  spec.components.schemas = { ...(spec.components.schemas || {}), ...schemas };
}
const products = buildProductSwagger();
spec.tags.push(...products.tags);
Object.assign(spec.paths, products.paths);
const accounting = buildAccountingSwagger();
spec.tags.push(...accounting.tags);
Object.assign(spec.paths, accounting.paths);

spec.tags = (spec.tags || []).filter((t) => !HIDDEN_TAGS.has(t.name));
for (const [path, methods] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(methods)) {
    if (!op || typeof op !== 'object' || !Array.isArray(op.tags)) continue;
    if (op.tags.some((t) => HIDDEN_TAGS.has(t))) delete methods[method];
  }
  if (!Object.keys(methods).length) delete spec.paths[path];
}

module.exports = spec;
