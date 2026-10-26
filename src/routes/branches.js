const express = require('express');
const router = express.Router();
const { sendError } = require('../services/common');
const { INDIA_STATES, searchLocations, reverseLocation } = require('../services/locationService');
const {
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  cancelScheduledVersion,
  getBranchHrmsStatus,
  listHrmsBranchesForCompany,
  getHrmsBranchPrefill,
} = require('../services/branchService');

/**
 * @swagger
 * tags:
 *   - name: 03 Branches
 *     description: Company-wise branches — effective date, map location (India), auto-fetch from HRMS
 *
 * components:
 *   schemas:
 *     BranchForm:
 *       type: object
 *       properties:
 *         company_id: { type: integer, description: Required on add (company dropdown = GET /api/companies) }
 *         hrms_branch_id:
 *           type: integer
 *           description: Optional (add only). HRMS branch id — blank fields are auto-filled from HRMS
 *         name: { type: string, example: Head Office }
 *         code: { type: string, example: HO, description: Unique per company (saved in uppercase) }
 *         address: { type: string, example: Simada Naka }
 *         city: { type: string, example: Surat }
 *         state: { type: string, example: Gujarat, description: Indian state / UT (GET /api/branches/states) }
 *         pincode: { type: string, example: '395006' }
 *         phone: { type: string, example: '9876543210' }
 *         email: { type: string, example: surat@company.com }
 *         contact_person_name: { type: string, example: Ravi Patel }
 *         status: { type: string, enum: [ACTIVE, INACTIVE], default: ACTIVE }
 *         latitude: { type: number, example: 21.220868 }
 *         longitude: { type: number, example: 72.898151 }
 *         location_label: { type: string, description: Place name picked from map search }
 *         effective_date:
 *           type: string
 *           format: date
 *           description: Date from which these details apply (default today). Future date = scheduled change
 *         remarks: { type: string }
 */

/**
 * @swagger
 * /api/branches/states:
 *   get:
 *     tags: [03 Branches]
 *     summary: Indian states / UTs (State dropdown)
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/states', (req, res) => res.json(INDIA_STATES));

/**
 * @swagger
 * /api/branches/location/search:
 *   get:
 *     tags: [03 Branches]
 *     summary: Search location in India (map search box)
 *     description: Returns places with lat/lng and parsed address, city, state, pincode. Debounce typing (~1 request/second).
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, example: Simada Surat }
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/location/search', async (req, res) => {
  try {
    res.json(await searchLocations(req.query.q));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches/location/reverse:
 *   get:
 *     tags: [03 Branches]
 *     summary: Address for a map pin (India only)
 *     parameters:
 *       - in: query
 *         name: lat
 *         required: true
 *         schema: { type: number, example: 21.220868 }
 *       - in: query
 *         name: lng
 *         required: true
 *         schema: { type: number, example: 72.898151 }
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/location/reverse', async (req, res) => {
  try {
    res.json(await reverseLocation(req.query.lat, req.query.lng));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches/hrms/status:
 *   get:
 *     tags: [03 Branches]
 *     summary: Is "Auto Fetch from HRMS" available (optionally for a selected company)?
 *     parameters:
 *       - in: query
 *         name: company_id
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: "{ available: boolean, reason: string|null }"
 */
router.get('/hrms/status', async (req, res) => {
  try {
    res.json(await getBranchHrmsStatus(req.query.company_id, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches/hrms/branches:
 *   get:
 *     tags: [03 Branches]
 *     summary: HRMS branches of the selected company (dropdown, with already_added flag)
 *     parameters:
 *       - in: query
 *         name: company_id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/hrms/branches', async (req, res) => {
  try {
    res.json(await listHrmsBranchesForCompany(req.query.company_id, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches/hrms/branches/{hrmsBranchId}:
 *   get:
 *     tags: [03 Branches]
 *     summary: Fetch one HRMS branch mapped to the Branch form
 *     parameters:
 *       - in: path
 *         name: hrmsBranchId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: company_id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Prefill data
 */
router.get('/hrms/branches/:hrmsBranchId', async (req, res) => {
  try {
    res.json(await getHrmsBranchPrefill(req.params.hrmsBranchId, req.query.company_id, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches:
 *   get:
 *     tags: [03 Branches]
 *     summary: List branches (company-wise) with details effective on a date
 *     parameters:
 *       - in: query
 *         name: company_id
 *         schema: { type: integer }
 *       - in: query
 *         name: as_of
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE, INACTIVE] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/', async (req, res) => {
  try {
    res.json(await listBranches(req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches/{id}:
 *   get:
 *     tags: [03 Branches]
 *     summary: Branch detail + full effective-date history
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: as_of
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/:id', async (req, res) => {
  try {
    res.json(await getBranch(req.params.id, req.user, req.authSource, req.query));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches:
 *   post:
 *     tags: [03 Branches]
 *     summary: Add branch to a company
 *     description: |
 *       Required: company_id, name, code, city, state (with hrms_branch_id, blanks are filled from HRMS).
 *       effective_date (default today) cannot be before the company's effective date.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/BranchForm' }
 *     responses:
 *       201:
 *         description: Created
 *       409:
 *         description: Duplicate code / name in company, or HRMS branch already added
 */
router.post('/', async (req, res) => {
  try {
    res.status(201).json(await createBranch(req.body, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches/{id}:
 *   put:
 *     tags: [03 Branches]
 *     summary: Edit branch with effective date
 *     description: |
 *       Send only fields that change, plus effective_date (default today).
 *       - effective_date = latest version date → corrects that version
 *       - effective_date after latest version → new version; previous one ends the day before
 *       - effective_date before latest version → rejected
 *       Use status=INACTIVE with a future effective_date to schedule closing a branch.
 *       `code` changes apply immediately (not versioned). Send latitude/longitude = null to clear location.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/BranchForm' }
 *     responses:
 *       200:
 *         description: Updated
 */
router.put('/:id', async (req, res) => {
  try {
    res.json(await updateBranch(req.params.id, req.body, req.user, req.authSource));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * @swagger
 * /api/branches/{id}/versions/{versionId}:
 *   delete:
 *     tags: [03 Branches]
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
