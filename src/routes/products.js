/**
 * Product & Item Master A–K — /api/products
 */
const express = require('express');
const { sendError, removeUploadedFile } = require('../services/common');
const { uploadProductMedia } = require('../middleware/uploadProductMedia');
const svc = require('../services/product/productService');
const uom = require('../services/product/uomService');
const gstPrice = require('../services/product/gstPricingService');
const inv = require('../services/product/inventoryService');
const bom = require('../services/product/bomService');
const attrs = require('../services/product/attributeService');

const router = express.Router();

const handle = (fn, okStatus = 200) => async (req, res) => {
  try {
    const ctx = await svc.moduleContext(req.user, req.authSource);
    const result = await fn(ctx, req);
    res.status(okStatus).json(result);
  } catch (err) {
    removeUploadedFile(req.file);
    sendError(res, err);
  }
};

router.get('/meta', handle((ctx) => svc.meta(ctx)));
router.get('/audit-logs', handle((ctx, req) => svc.auditLogs(ctx, req.query)));
router.post('/check-duplicates', handle((ctx, req) => attrs.checkDuplicates(ctx, req.body)));
router.post('/bulk-update', handle((ctx, req) => attrs.bulkUpdate(ctx, req.body)));

// B — UOM
router.get('/uoms', handle((ctx, req) => uom.listUoms(ctx, req.query)));
router.post('/uoms/seed', handle(() => uom.seedSystemUoms(), 201));
router.post('/uoms', handle((ctx, req) => uom.createUom(ctx, req.body), 201));
router.put('/uoms/:id', handle((ctx, req) => uom.updateUom(ctx, req.params.id, req.body)));

// D — warehouses & stock (before /:id)
router.get('/warehouses', handle((ctx, req) => inv.listWarehouses(ctx, req.query)));
router.post('/warehouses', handle((ctx, req) => inv.createWarehouse(ctx, req.body), 201));
router.put('/warehouses/:id', handle((ctx, req) => inv.updateWarehouse(ctx, req.params.id, req.body)));
router.get('/stock', handle((ctx, req) => inv.getStock(ctx, req.query)));
router.get('/stock/ledger', handle((ctx, req) => inv.stockLedger(ctx, req.query)));
router.post('/stock/opening', handle((ctx, req) => inv.openingStock(ctx, req.body), 201));
router.post('/stock/adjust', handle((ctx, req) => inv.adjustStock(ctx, req.body), 201));
router.post('/stock/transfer', handle((ctx, req) => inv.transferStock(ctx, req.body), 201));

// H — attributes & tags seed
router.get('/attribute-defs', handle((ctx, req) => attrs.listAttributeDefs(ctx, req.query)));
router.post('/attribute-defs', handle((ctx, req) => attrs.createAttributeDef(ctx, req.body), 201));
router.post('/tags/seed-suggested', handle((ctx, req) => attrs.seedSuggestedTags(ctx, req.body.company_id), 201));

// G — BOM / production
router.get('/boms', handle((ctx, req) => bom.listBoms(ctx, req.query)));
router.post('/boms', handle((ctx, req) => bom.createBom(ctx, req.body), 201));
router.get('/boms/:id', handle((ctx, req) => bom.getBom(ctx, req.params.id, req.query)));
router.post('/production-orders', handle((ctx, req) => bom.createProductionOrder(ctx, req.body), 201));
router.get('/production-orders/:id', handle((ctx, req) => bom.getProductionOrder(ctx, req.params.id)));
router.post('/production-orders/:id/issue', handle((ctx, req) => bom.issueMaterials(ctx, req.params.id, req.body)));
router.post('/production-orders/:id/return', handle((ctx, req) => bom.returnMaterials(ctx, req.params.id, req.body)));
router.post('/production-orders/:id/complete', handle((ctx, req) => bom.completeProduction(ctx, req.params.id, req.body)));

// A — categories / tags
router.get('/categories', handle((ctx, req) => svc.listCategories(ctx, req.query)));
router.post('/categories/seed', handle((ctx, req) => svc.seedDefaultCategories(ctx, req.body.company_id, req.body), 201));
router.post('/categories', handle((ctx, req) => svc.createCategory(ctx, req.body), 201));
router.put('/categories/:id', handle((ctx, req) => svc.updateCategory(ctx, req.params.id, req.body)));
router.get('/tags', handle((ctx, req) => svc.listTags(ctx, req.query)));
router.post('/tags', handle((ctx, req) => svc.createTag(ctx, req.body), 201));
router.delete('/tags/:id', handle((ctx, req) => svc.deleteTag(ctx, req.params.id)));

// A — products
router.get('/', handle((ctx, req) => svc.listProducts(ctx, req.query)));
router.post('/', handle((ctx, req) => svc.createProduct(ctx, req.body), 201));
router.get('/:id', handle((ctx, req) => svc.getProduct(ctx, req.params.id, req.query)));
router.put('/:id', handle((ctx, req) => svc.updateProduct(ctx, req.params.id, req.body)));
router.delete('/:id', handle((ctx, req) => svc.deleteProduct(ctx, req.params.id, req.body || {}, req.query)));
router.get('/:id/audit-logs', handle((ctx, req) => svc.auditLogs(ctx, req.query, req.params.id)));

router.post('/:id/variants', handle((ctx, req) => svc.createVariant(ctx, req.params.id, req.body), 201));
router.put('/:id/variants/:variantId', handle((ctx, req) => svc.updateVariant(ctx, req.params.id, req.params.variantId, req.body)));

router.get('/:id/conversions', handle((ctx, req) => uom.listConversions(ctx, req.params.id)));
router.post('/:id/conversions', handle((ctx, req) => uom.upsertConversion(ctx, req.params.id, req.body), 201));

router.get('/:id/gst', handle((ctx, req) => gstPrice.getGst(ctx, req.params.id, req.query)));
router.put('/:id/gst', handle((ctx, req) => gstPrice.setGst(ctx, req.params.id, req.body)));
router.get('/:id/prices', handle((ctx, req) => gstPrice.getPrices(ctx, req.params.id, req.query)));
router.put('/:id/prices', handle((ctx, req) => gstPrice.setPrices(ctx, req.params.id, req.body)));
router.get('/:id/vendors', handle((ctx, req) => gstPrice.listVendorMappings(ctx, req.params.id)));
router.post('/:id/vendors', handle((ctx, req) => gstPrice.upsertVendorMapping(ctx, req.params.id, req.body), 201));

router.get('/:id/attributes', handle((ctx, req) => attrs.getProductAttributes(ctx, req.params.id, req.query)));
router.put('/:id/attributes', handle((ctx, req) => attrs.setProductAttributes(ctx, req.params.id, req.body)));
router.post('/:id/reorder', handle((ctx, req) => inv.setReorder(ctx, req.params.id, req.body), 201));

router.post('/:id/media', uploadProductMedia, handle((ctx, req) => svc.addMedia(ctx, req.params.id, req.body, req.productFile || null), 201));
router.delete('/:id/media/:mediaId', handle((ctx, req) => svc.deleteMedia(ctx, req.params.id, req.params.mediaId)));
router.get('/:id/media/:mediaId/file', async (req, res) => {
  try {
    const ctx = await svc.moduleContext(req.user, req.authSource);
    const { media, fullPath } = await svc.getMediaFile(ctx, req.params.id, req.params.mediaId);
    res.type(media.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(media.original_name || 'file')}"`);
    res.sendFile(fullPath);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
