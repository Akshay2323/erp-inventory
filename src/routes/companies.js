const express = require('express');
const router = express.Router();
const { uploadLogo } = require('../middleware/uploadLogo');
const { sendError } = require('../services/common');
const { getHrmsStatus, listHrmsTenants, getHrmsTenantForForm, listHrmsSalesPersons } = require('../services/hrmsService');
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
 *     HrmsSalesPerson:
 *       type: object
 *       properties:
 *         id: { type: integer, example: 7, description: Employee ID in HRMS }
 *         employee_code: { type: string, example: EMP0006, description: Sales person employee code }
 *         full_name: { type: string, example: Rohit shinde }
 *         name: { type: string, example: Rohit shinde }
 *         first_name: { type: string, example: Rohit }
 *         last_name: { type: string, example: shinde }
 *         email: { type: string, format: email, example: rohitshindefbo@gmail.com }
 *         mobile: { type: string, example: '6356173568' }
 *         gender: { type: string, nullable: true, example: male }
 *         status: { type: string, example: active }
 *         company_id: { type: integer, example: 1 }
 *         tenant_id: { type: integer, example: 1 }
 *         company_name: { type: string, example: Jyoti Electricals }
 *         branch_id: { type: integer, example: 2 }
 *         branch_name: { type: string, example: Head Office }
 *         department_id: { type: integer, example: 4 }
 *         department_name: { type: string, example: Sales }
 *         department_code: { type: string, example: Sales }
 *         designation_id: { type: integer, example: 8 }
 *         designation_name: { type: string, example: Salesman }
 *         designation_code: { type: string, example: Salesman }
 *         user_id: { type: integer, nullable: true, example: 13, description: Matched user ID in HRMS users table }
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
 * /api/companies/hrms/sales-persons:
 *   get:
 *     tags: [02 Companies, 02 HRMS, 08 Sales]
 *     summary: Fetch only sales person employee codes and details from HRMS DB
 *     description: |
 *       Fetches active employees from the HRMS database who belong to the Sales department or have a Sales/Salesman designation.
 *       Only sales personnel are returned (filtered from all HRMS employees).
 *     parameters:
 *       - in: query
 *         name: company_id
 *         description: Local ERP company ID or HRMS tenant ID (auto-scoped to accessible company)
 *         schema: { type: integer, example: 1 }
 *       - in: query
 *         name: tenant_id
 *         description: Direct HRMS tenant ID filter
 *         schema: { type: integer, example: 1 }
 *       - in: query
 *         name: search
 *         description: Search by employee code, name, email or mobile
 *         schema: { type: string, example: EMP0006 }
 *       - in: query
 *         name: designation_only
 *         description: If true, only returns employees whose designation contains 'sale' (e.g. Salesman)
 *         schema: { type: boolean, default: false }
 *       - in: query
 *         name: codes_only
 *         description: If true, returns an array of employee code strings e.g. ["EMP0002", "EMP0006"]
 *         schema: { type: boolean, default: false }
 *       - in: query
 *         name: branch_id
 *         description: Filter by HRMS branch ID
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         description: Employee status filter
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *     responses:
 *       200:
 *         description: List of sales persons or employee codes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/HrmsSalesPerson'
 */
router.get('/hrms/sales-persons', async (req, res) => {
  try {
    res.json(await listHrmsSalesPersons(req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/hrms/salespersons', async (req, res) => {
  try {
    res.json(await listHrmsSalesPersons(req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/hrms/sales-person-codes', async (req, res) => {
  try {
    res.json(await listHrmsSalesPersons(req.user, req.authSource, { ...req.query, codes_only: true }));
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
