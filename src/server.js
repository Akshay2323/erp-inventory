const path = require('path');
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
require('dotenv').config();

const swaggerSpec = require('./config/swagger');
const { protectApi } = require('./middleware/protectApi');
const authRouter = require('./routes/auth');
const companiesRouter = require('./routes/companies');
const branchesRouter = require('./routes/branches');
const { createPartyRouter } = require('./routes/partyRouter');
const { CLIENT, VENDOR } = require('./config/partyModules');
const productsRouter = require('./routes/products');
const { createAccountingRouter, createVoucherRouter } = require('./routes/accountingRouter');
const { SALES, PURCHASE } = require('./config/accountingConfig');

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Chrome Private Network Access: allow pages on another host to call this API on a LAN IP
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// All /api/* routes require login except /api/auth/login and /api/auth/register
app.use(protectApi);

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [01 Health]
 *     summary: Health check (login required)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: API is running
 *       401:
 *         description: Login required
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    product: 'inventory-app',
    database: process.env.DB_NAME || 'inventory_db',
    port: Number(PORT),
    user: req.user,
  });
});

app.use('/api/auth', authRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/clients', createPartyRouter(CLIENT));
app.use('/api/vendors', createPartyRouter(VENDOR));
app.use('/api/products', productsRouter);
app.use('/api/accounting', createAccountingRouter());
app.use('/api/sales', createVoucherRouter(SALES));
app.use('/api/purchases', createVoucherRouter(PURCHASE));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'inventory-app Docs',
  swaggerOptions: {
    persistAuthorization: true,
    docExpansion: 'list',
    tagsSorter: 'alpha',
    operationsSorter: 'alpha',
  },
}));
app.get('/api-docs.json', (req, res) => res.json(swaggerSpec));

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log(`inventory-app → http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`               → http://${ip}:${PORT}`));
  console.log(`Swagger UI    → http://localhost:${PORT}/api-docs`);
  ips.forEach((ip) => console.log(`               → http://${ip}:${PORT}/api-docs`));
});
