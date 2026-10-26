/**
 * Router factory for Client Master (/api/clients) and Vendor Master (/api/vendors).
 * Each call builds an independent router bound to one module config; Swagger paths for it are
 * generated in config/partySwagger.js.
 */
const express = require('express');
const { sendError, removeUploadedFile } = require('../services/common');
const { buildPartyContext } = require('../services/party/access');
const { uploadDocument } = require('../middleware/uploadDocument');
const svc = require('../services/party/partyService');

function createPartyRouter(cfg) {
  const router = express.Router();
  const withFile = uploadDocument(cfg.key);

  const handle = (fn, okStatus = 200) => async (req, res) => {
    try {
      const ctx = await buildPartyContext(cfg, req.user, req.authSource);
      const result = await fn(ctx, req);
      const status = result?.status === 'PENDING_APPROVAL' ? 202 : okStatus;
      res.set('Cache-Control', 'no-store');
      res.status(status).json(result);
    } catch (err) {
      removeUploadedFile(req.file);
      sendError(res, err);
    }
  };
  const section = (req) => svc.childKeyFromSlug(req.params.section);

  // ---- module-level ----
  router.get('/meta', handle((ctx) => svc.meta(ctx)));
  router.get('/audit-logs', handle((ctx, req) => svc.auditLogs(ctx, req.query)));
  router.get('/approvals', handle((ctx, req) => svc.listApprovals(ctx, req.query)));
  router.post('/approvals/:approvalId/decision', handle((ctx, req) => svc.decideApproval(ctx, req.params.approvalId, req.body)));
  router.post('/approvals/:approvalId/cancel', handle((ctx, req) => svc.cancelApproval(ctx, req.params.approvalId)));
  router.get('/duplicates', handle((ctx, req) => svc.listDuplicates(ctx, req.query)));
  router.post('/check-duplicates', handle((ctx, req) => svc.checkDuplicates(ctx, req.body)));

  // ---- records ----
  router.get('/', handle((ctx, req) => svc.listParties(ctx, req.query)));
  router.post('/', handle((ctx, req) => svc.createParty(ctx, req.body), 201));
  router.get('/:id', handle((ctx, req) => svc.getParty(ctx, req.params.id, req.query)));
  router.put('/:id', handle((ctx, req) => svc.updateProfile(ctx, req.params.id, req.body)));
  router.put('/:id/financial', handle((ctx, req) => svc.updateFinancial(ctx, req.params.id, req.body)));
  router.get('/:id/versions', handle((ctx, req) => svc.getVersions(ctx, req.params.id)));
  router.delete('/:id/profile-versions/:versionId',
    handle((ctx, req) => svc.cancelScheduled(ctx, req.params.id, 'PROFILE', req.params.versionId)));
  router.delete('/:id/financial-versions/:versionId',
    handle((ctx, req) => svc.cancelScheduled(ctx, req.params.id, 'FINANCIAL', req.params.versionId)));
  router.post('/:id/approval', handle((ctx, req) => svc.setRecordApproval(ctx, req.params.id, req.body)));
  router.post('/:id/kyc', handle((ctx, req) => svc.setKyc(ctx, req.params.id, req.body)));
  router.post('/:id/merge', handle((ctx, req) => svc.mergeParty(ctx, req.params.id, req.body)));
  router.get('/:id/snapshot', handle((ctx, req) => svc.getSnapshot(ctx, req.params.id, req.query)));
  router.get('/:id/transactions', handle((ctx, req) => svc.getTransactions(ctx, req.params.id, req.query)));
  router.get('/:id/audit-logs', handle((ctx, req) => svc.auditLogs(ctx, req.query, req.params.id)));

  router.get('/:id/documents/:rootId/file', async (req, res) => {
    try {
      const ctx = await buildPartyContext(cfg, req.user, req.authSource);
      const file = await svc.getDocumentFile(ctx, req.params.id, req.params.rootId, req.query.version_id);
      res.type(file.mime);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name || 'document')}"`);
      res.sendFile(file.path);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- child sections: addresses, gst-registrations, bank-accounts, upi-ids, contacts, documents ----
  router.get('/:id/:section', handle((ctx, req) => svc.listChildren(ctx, req.params.id, section(req), req.query)));
  router.post('/:id/:section', withFile,
    handle((ctx, req) => svc.addChild(ctx, req.params.id, section(req), req.body, req.documentFile || null), 201));
  router.put('/:id/:section/:rootId', withFile,
    handle((ctx, req) => svc.updateChild(ctx, req.params.id, section(req), req.params.rootId, req.body, req.documentFile || null)));
  router.post('/:id/:section/:rootId/deactivate',
    handle((ctx, req) => svc.setChildActive(ctx, req.params.id, section(req), req.params.rootId, req.body, false)));
  router.post('/:id/:section/:rootId/reactivate',
    handle((ctx, req) => svc.setChildActive(ctx, req.params.id, section(req), req.params.rootId, req.body, true)));
  router.post('/:id/:section/:rootId/default',
    handle((ctx, req) => svc.setChildDefault(ctx, req.params.id, section(req), req.params.rootId, req.body)));
  router.post('/:id/:section/:rootId/verify',
    handle((ctx, req) => svc.verifyChild(ctx, req.params.id, section(req), req.params.rootId, req.body)));
  router.get('/:id/:section/:rootId/history',
    handle((ctx, req) => svc.childHistory(ctx, req.params.id, section(req), req.params.rootId)));
  router.delete('/:id/:section/:rootId/versions/:versionId',
    handle((ctx, req) => svc.cancelChildScheduled(ctx, req.params.id, section(req), req.params.rootId, req.params.versionId)));

  return router;
}

module.exports = { createPartyRouter };
