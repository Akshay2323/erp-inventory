/**
 * /api/accounting (company books) and the per-side routers /api/sales and /api/purchases.
 * Swagger paths are generated in config/accountingSwagger.js.
 */
const express = require('express');
const { sendError } = require('../services/common');
const {
  LEDGER_GROUPS, MAPPING_KEYS, GST_RATES, PAYMENT_MODES, NUMBERED_VOUCHER_TYPES, B2CL_LIMIT,
} = require('../config/accountingConfig');
const { moduleContext, listLogs } = require('../services/accounting/common');
const books = require('../services/accounting/books');
const ledgers = require('../services/accounting/ledgers');
const series = require('../services/accounting/series');
const vouchers = require('../services/accounting/vouchers');
const reports = require('../services/accounting/reports');

function handler(cfgOrKey) {
  return (fn, okStatus = 200) => async (req, res) => {
    try {
      const ctx = await moduleContext(cfgOrKey, req.user, req.authSource);
      res.status(okStatus).json(await fn(ctx, req));
    } catch (err) {
      sendError(res, err);
    }
  };
}

function createAccountingRouter() {
  const router = express.Router();
  const h = handler('accounting');

  router.get('/meta', h((ctx) => ({
    ledger_groups: LEDGER_GROUPS,
    mapping_keys: Object.fromEntries(Object.entries(MAPPING_KEYS).map(([k, v]) => [k, { allowed_groups: v.groups, default_ledger: v.ledger[0] }])),
    numbered_voucher_types: NUMBERED_VOUCHER_TYPES,
    numbering_tokens: series.TOKENS,
    settings_fields: Object.keys(books.SETTINGS_FIELDS),
    company_gst_registration_types: books.COMPANY_GST_TYPES,
    your_permissions: ctx.permissions,
  })));

  router.post('/companies/:companyId/setup', h((ctx, req) => books.setupBooks(ctx, req.params.companyId, req.body, {
    seedLedgers: ledgers.seedLedgers, seedSeries: series.seedSeries,
  }), 201));
  router.get('/companies/:companyId/settings', h((ctx, req) => books.getSettings(ctx, req.params.companyId, req.query)));
  router.put('/companies/:companyId/settings', h((ctx, req) => books.updateSettings(ctx, req.params.companyId, req.body)));
  router.delete('/companies/:companyId/settings-versions/:versionId',
    h((ctx, req) => books.cancelSettingsVersion(ctx, req.params.companyId, req.params.versionId)));
  router.get('/companies/:companyId/financial-years', h((ctx, req) => books.listFinancialYears(ctx, req.params.companyId)));
  router.post('/companies/:companyId/financial-years', h((ctx, req) => books.createNextFinancialYear(ctx, req.params.companyId, req.body), 201));
  router.post('/financial-years/:id/close', h((ctx, req) => books.setFinancialYearStatus(ctx, req.params.id, 'CLOSED', req.body)));
  router.post('/financial-years/:id/reopen', h((ctx, req) => books.setFinancialYearStatus(ctx, req.params.id, 'OPEN', req.body)));
  router.get('/companies/:companyId/ledger-mappings', h((ctx, req) => ledgers.getMappings(ctx, req.params.companyId, req.query)));
  router.put('/companies/:companyId/ledger-mappings', h((ctx, req) => ledgers.updateMappings(ctx, req.params.companyId, req.body)));

  router.get('/ledgers', h((ctx, req) => ledgers.listLedgers(ctx, req.query)));
  router.post('/ledgers', h((ctx, req) => ledgers.createLedger(ctx, req.body), 201));
  router.get('/ledgers/:id', h((ctx, req) => ledgers.getLedger(ctx, req.params.id, req.query)));
  router.put('/ledgers/:id', h((ctx, req) => ledgers.updateLedger(ctx, req.params.id, req.body)));
  router.delete('/ledgers/:id/versions/:versionId', h((ctx, req) => ledgers.cancelLedgerVersion(ctx, req.params.id, req.params.versionId)));
  router.get('/ledgers/:id/statement', h((ctx, req) => reports.ledgerStatement(ctx, req.params.id, req.query)));

  router.get('/voucher-series', h((ctx, req) => series.listSeries(ctx, req.query)));
  router.post('/voucher-series', h((ctx, req) => series.createSeries(ctx, req.body), 201));
  router.get('/voucher-series/:id', h((ctx, req) => series.getSeries(ctx, req.params.id, req.query)));
  router.put('/voucher-series/:id', h((ctx, req) => series.updateSeries(ctx, req.params.id, req.body)));
  router.delete('/voucher-series/:id/versions/:versionId', h((ctx, req) => series.cancelSeriesVersion(ctx, req.params.id, req.params.versionId)));
  router.get('/voucher-series/:id/preview', h((ctx, req) => series.previewSeries(ctx, req.params.id, req.query)));

  router.get('/trial-balance', h((ctx, req) => reports.trialBalance(ctx, req.query)));
  router.get('/reconciliation', h((ctx, req) => reports.reconciliation(ctx, req.query)));
  router.post('/reconciliation/refresh-balances', h((ctx, req) => reports.refreshBalances(ctx, req.body)));
  router.get('/bank-reconciliation', h((ctx, req) => reports.bankReconciliation(ctx, req.query)));
  router.get('/audit-logs', h((ctx, req) => {
    ctx.assert('audit');
    return listLogs(ctx, 'accounting_audit_logs', req.query);
  }));
  return router;
}

function createVoucherRouter(side) {
  const router = express.Router();
  const h = handler(side);
  const party = side.partyPath;

  router.get('/meta', h((ctx) => ({
    module: side.key,
    party_module: side.partyCfg.key,
    party_field: side.partyFk,
    voucher_types: Object.fromEntries(Object.entries(side.voucherTypes).filter(([, t]) => !t.opening).map(([k, t]) => [k, {
      label: t.label, party_effect: t.effect, has_lines: !!t.lines, cash_bank: !!t.cash, eway_bill: !!t.eway,
      against_invoice: !!t.against, default_ledger_key: t.lineKey || null,
    }])),
    gst_rates: GST_RATES,
    payment_modes: PAYMENT_MODES,
    b2cl_limit: B2CL_LIMIT,
    your_permissions: ctx.permissions,
  })));

  router.get('/vouchers', h((ctx, req) => vouchers.listVouchers(ctx, req.query)));
  router.post('/vouchers', h((ctx, req) => vouchers.createVoucher(ctx, req.body), 201));
  router.get('/vouchers/:id', h((ctx, req) => vouchers.getVoucher(ctx, req.params.id)));
  router.put('/vouchers/:id', h((ctx, req) => vouchers.amendVoucher(ctx, req.params.id, req.body)));
  router.post('/vouchers/:id/cancel', h((ctx, req) => vouchers.cancelVoucher(ctx, req.params.id, req.body)));
  router.get('/vouchers/:id/revisions', h((ctx, req) => vouchers.listRevisions(ctx, req.params.id)));
  router.post('/vouchers/:id/auto-allocate', h((ctx, req) => vouchers.autoAllocate(ctx, req.params.id, req.body)));
  router.post('/vouchers/:id/bank-clearance', h((ctx, req) => vouchers.setBankClearance(ctx, req.params.id, req.body)));
  router.post('/vouchers/:id/eway-bill', h((ctx, req) => vouchers.recordEwayBill(ctx, req.params.id, req.body), 201));
  router.put('/vouchers/:id/eway-bill', h((ctx, req) => vouchers.updateEwayPartB(ctx, req.params.id, req.body)));
  router.post('/vouchers/:id/eway-bill/cancel', h((ctx, req) => vouchers.cancelEwayBill(ctx, req.params.id, req.body)));
  router.get('/vouchers/:id/eway-bill/json', h((ctx, req) => vouchers.ewayBillJson(ctx, req.params.id, req.query)));

  router.post('/allocations', h((ctx, req) => vouchers.allocate(ctx, req.body), 201));
  router.post('/allocations/:id/reverse', h((ctx, req) => vouchers.reverseAllocation(ctx, req.params.id, req.body)));

  router.get(`/${party}/:partyId/opening-bills`, h((ctx, req) => vouchers.getOpeningBills(ctx, req.params.partyId)));
  router.put(`/${party}/:partyId/opening-bills`, h((ctx, req) => vouchers.setOpeningBills(ctx, req.params.partyId, req.body)));
  router.get(`/${party}/:partyId/statement`, h((ctx, req) => reports.statement(ctx, req.params.partyId, req.query)));

  router.get('/outstanding', h((ctx, req) => reports.outstanding(ctx, req.query)));
  router.get(side.key === 'sales' ? '/receivables' : '/payables', h((ctx, req) => reports.partySummary(ctx, req.query)));
  router.get('/ageing', h((ctx, req) => reports.ageing(ctx, req.query)));
  router.get('/register', h((ctx, req) => reports.register(ctx, req.query)));
  router.get('/gst-report', h((ctx, req) => reports.gstReport(ctx, req.query)));
  router.get('/eway-bills/pending', h((ctx, req) => reports.pendingEwayBills(ctx, req.query)));
  router.get('/audit-logs', h((ctx, req) => {
    ctx.assert('audit');
    return listLogs(ctx, side.auditTable, req.query, { partyFk: side.partyFk });
  }));
  return router;
}

module.exports = { createAccountingRouter, createVoucherRouter };
