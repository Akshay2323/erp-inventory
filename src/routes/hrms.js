const express = require('express');
const router = express.Router();
const { sendError } = require('../services/common');
const {
  getHrmsStatus,
  listHrmsTenants,
  getHrmsTenantForForm,
  listHrmsBranches,
  listHrmsSalesPersons,
} = require('../services/hrmsService');

/**
 * @swagger
 * tags:
 *   - name: 02 HRMS
 *     description: HRMS Database Integration — auto-fetch sales person employee codes, companies, and branches
 */

/**
 * @swagger
 * /api/hrms/status:
 *   get:
 *     tags: [02 HRMS]
 *     summary: Check if HRMS database is available and accessible
 *     responses:
 *       200:
 *         description: HRMS availability status
 */
router.get('/status', async (req, res) => {
  try {
    res.json(await getHrmsStatus(req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/hrms/tenants:
 *   get:
 *     tags: [02 HRMS]
 *     summary: List accessible HRMS companies / tenants
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of HRMS companies
 */
router.get('/tenants', async (req, res) => {
  try {
    res.json(await listHrmsTenants(req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/hrms/tenants/{id}:
 *   get:
 *     tags: [02 HRMS]
 *     summary: Fetch single HRMS company details
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Company details
 */
router.get('/tenants/:id', async (req, res) => {
  try {
    res.json(await getHrmsTenantForForm(req.params.id, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/hrms/branches:
 *   get:
 *     tags: [02 HRMS]
 *     summary: List HRMS branches for a company / tenant
 *     parameters:
 *       - in: query
 *         name: tenant_id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of branches
 */
router.get('/branches', async (req, res) => {
  try {
    res.json(await listHrmsBranches(req.query.tenant_id, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/hrms/sales-persons:
 *   get:
 *     tags: [02 HRMS, 02 Companies, 08 Sales]
 *     summary: Fetch only sales person employee codes and profiles from HRMS DB
 *     description: |
 *       Queries `employees`, `employee_job_details`, `departments`, `designations`, and `users` from the HRMS database.
 *       Filters specifically for sales personnel (Sales department or Salesman/Sales designation).
 *     parameters:
 *       - in: query
 *         name: company_id
 *         description: Local ERP company ID or HRMS tenant ID
 *         schema: { type: integer, example: 1 }
 *       - in: query
 *         name: tenant_id
 *         description: HRMS tenant ID filter
 *         schema: { type: integer, example: 1 }
 *       - in: query
 *         name: search
 *         description: Search text across employee code, name, email, or mobile
 *         schema: { type: string, example: EMP0006 }
 *       - in: query
 *         name: designation_only
 *         description: When true, only includes employees whose designation contains 'sale' (e.g. Salesman)
 *         schema: { type: boolean, default: false }
 *       - in: query
 *         name: codes_only
 *         description: When true, returns a string array of employee codes e.g. ["EMP0002", "EMP0006"]
 *         schema: { type: boolean, default: false }
 *       - in: query
 *         name: branch_id
 *         description: Filter by HRMS branch ID
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         description: Status filter (default active)
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *     responses:
 *       200:
 *         description: List of sales person employees or employee codes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/HrmsSalesPerson'
 */
router.get('/sales-persons', async (req, res) => {
  try {
    res.json(await listHrmsSalesPersons(req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/salespersons', async (req, res) => {
  try {
    res.json(await listHrmsSalesPersons(req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/hrms/sales-person-codes:
 *   get:
 *     tags: [02 HRMS, 02 Companies, 08 Sales]
 *     summary: Quick fetch array of only sales person employee codes from HRMS DB
 *     description: Returns only a string array of sales person employee codes (e.g. ["EMP0002", "EMP0006"]).
 *     parameters:
 *       - in: query
 *         name: company_id
 *         description: Local ERP company ID or HRMS tenant ID
 *         schema: { type: integer, example: 1 }
 *       - in: query
 *         name: tenant_id
 *         description: HRMS tenant ID
 *         schema: { type: integer, example: 1 }
 *       - in: query
 *         name: search
 *         description: Search text across code, name, email
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of employee code strings
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *                 example: EMP0006
 */
router.get('/sales-person-codes', async (req, res) => {
  try {
    res.json(await listHrmsSalesPersons(req.user, req.authSource, { ...req.query, codes_only: true }));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
