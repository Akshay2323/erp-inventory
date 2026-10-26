const express = require('express');
const router = express.Router();
const { uploadLogo } = require('../middleware/uploadLogo');
const { sendError } = require('../services/common');
const { getHrmsStatus, listHrmsTenants, getHrmsTenantForForm } = require('../services/hrmsService');
const {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  cancelScheduledVersion,
} = require('../services/companyService');

/**
 * @swagger
 * tags:
 *   - name: 02 Companies
 *     description: Company master — add/edit with effective date, logo upload, auto-fetch from HRMS
 *
 * components:
 *   schemas:
 *     CompanyForm:
 *       type: object
 *       properties:
 *         hrms_tenant_id:
 *           type: integer
 *           description: Optional (add only). HRMS company id — blank fields are auto-filled from HRMS
 *         company_name: { type: string, example: Jyoti Electricals }
 *         legal_name: { type: string, example: Jyoti Electricals Pvt Ltd }
 *         email: { type: string, example: info@jyoti.com }
 *         address: { type: string, example: Ring Road, Surat }
 *         logo:
 *           type: string
 *           format: binary
 *           description: PNG / JPG / WEBP, max 2 MB
 *         subscription_start: { type: string, format: date, example: '2026-10-01' }
 *         subscription_end: { type: string, format: date, example: '2027-09-30' }
 *         admin_name: { type: string, example: Ravi Patel }
 *         admin_email: { type: string, example: ravi@jyoti.com }
 *         admin_password: { type: string, format: password }
 *         confirm_password: { type: string, format: password }
 *         is_active:
 *           type: boolean
 *           description: Active checkbox (default true). Platform admins only on edit.
 *         remove_logo:
 *           type: boolean
 *           description: Set true on edit to clear the logo (no new file)
 *         effective_date:
 *           type: string
 *           format: date
 *           description: Date from which these details apply (default today). Alias on edit - effective_from is also accepted.
 *         effective_from:
 *           type: string
 *           format: date
 *           description: Same as effective_date (accepted on edit so forms that send effective_from work)
 *         remarks: { type: string, example: Address changed }
 */

/**
 * @swagger
 * /api/companies/hrms/status:
 *   get:
 *     tags: [02 Companies]
 *     summary: Is "Auto Fetch from HRMS" available for the logged-in user?
 *     responses:
 *       200:
 *         description: "{ available: boolean, reason: string|null }"
 */
router.get('/hrms/status', async (req, res) => {
  try {
    res.json(await getHrmsStatus(req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/companies/hrms/tenants:
 *   get:
 *     tags: [02 Companies]
 *     summary: List HRMS companies the user can fetch from (dropdown)
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/hrms/tenants', async (req, res) => {
  try {
    res.json(await listHrmsTenants(req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/companies/hrms/tenants/{id}:
 *   get:
 *     tags: [02 Companies]
 *     summary: Fetch one HRMS company mapped to the Add Company form (incl. its Company Admin name/email)
 *     description: Password is never fetched — admin_password must still be entered.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Prefill data
 */
router.get('/hrms/tenants/:id', async (req, res) => {
  try {
    res.json(await getHrmsTenantForForm(req.params.id, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/companies:
 *   get:
 *     tags: [02 Companies]
 *     summary: List companies (latest version by default)
 *     parameters:
 *       - in: query
 *         name: as_of
 *         schema: { type: string, format: date }
 *         description: Optional. Point-in-time view for this date. Omit to show the latest version (what the edit form uses).
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: include_inactive
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/', async (req, res) => {
  try {
    res.json(await listCompanies(req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/companies/{id}:
 *   get:
 *     tags: [02 Companies]
 *     summary: Company detail + full effective-date history (versions)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: as_of
 *         schema: { type: string, format: date }
 *         description: Optional. Point-in-time view. Omit for the latest version.
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/:id', async (req, res) => {
  try {
    res.json(await getCompany(req.params.id, req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/companies:
 *   post:
 *     tags: [02 Companies]
 *     summary: Add company (+ company admin login)
 *     description: |
 *       Required: company_name, email, admin_name, admin_email, admin_password, confirm_password.
 *       With hrms_tenant_id, blank company fields and logo are taken from HRMS.
 *       effective_date (default today) is when this version of the details starts.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema: { $ref: '#/components/schemas/CompanyForm' }
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CompanyForm' }
 *     responses:
 *       201:
 *         description: Created
 *       409:
 *         description: Duplicate company / admin email / HRMS company already added
 */
router.post('/', uploadLogo, async (req, res) => {
  try {
    res.status(201).json(await createCompany(req.body, req.file, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/companies/{id}:
 *   put:
 *     tags: [02 Companies]
 *     summary: Edit company with effective date (full form supported)
 *     description: |
 *       Send the full form or only changed fields. All of these are updatable:
 *       company_name, legal_name, email, address, logo / remove_logo, subscription_start / end,
 *       admin_name, admin_email, admin_password + confirm_password, is_active, remarks, effective_date.
 *       - effective_date on an existing version date → corrects that version
 *       - any other date (past, today, or future) → new version for that date; neighbours are adjusted
 *       Admin login fields update directly (not versioned). is_active and subscription dates: platform admins only.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema: { $ref: '#/components/schemas/CompanyForm' }
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CompanyForm' }
 *     responses:
 *       200:
 *         description: Updated
 */
router.put('/:id', uploadLogo, async (req, res) => {
  try {
    res.json(await updateCompany(req.params.id, req.body, req.file, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/companies/{id}/versions/{versionId}:
 *   delete:
 *     tags: [02 Companies]
 *     summary: Cancel a scheduled (future-dated) change
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: versionId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Cancelled — previous version is open-ended again
 */
router.delete('/:id/versions/:versionId', async (req, res) => {
  try {
    res.json(await cancelScheduledVersion(req.params.id, req.params.versionId, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
