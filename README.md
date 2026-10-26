# inventory-app API

Node.js + Express + MySQL + Swagger inventory API for **inventory-app**.

**No demo data** — empty masters; enter live data via Swagger or API.

## Login (dual — inventory + portal)

### 1) Inventory local login
| Field | Value |
|-------|-------|
| Username | admin |
| Password | admin123 |

`POST /api/auth/login` → inventory JWT

### 2) Portal login (tenant users — shared database)
`POST /api/auth/portal-login` with `{ "login": "email or mobile", "password": "..." }`

Or after app redirect, send Sanctum token:
```
Authorization: Bearer 123|plainToken
```

Shared DB: `SHARED_DB_NAME=hrms_db` in `.env`

**All other APIs require token** in header.

Inventory local passwords are AES encrypted (reversible). Portal passwords use `visible_password` in shared DB.

## Quick start

```bash
npm install
npm run init-db   # safe — never drops live data
npm start
```

**Database commands**

| Command | What it does |
|---------|----------------|
| `npm run init-db` | Creates missing tables + runs migrations. **Live data is preserved.** |
| `npm run migrate-db` | Same as init-db (alias) |
| `npm run reset-db -- --confirm` | **Destructive** — drops all tables and recreates empty schema |

- API: http://localhost:4000  
- Swagger: http://localhost:4000/api-docs  
- Frontend (separate Next.js project): `d:\inventory-frontend` → http://localhost:3000  

## Database

| Key | Value |
|-----|-------|
| Host | localhost |
| User | root |
| Password | sa.1 |
| Database | inventory_db |
| Port | 4000 |

## Modules

### 1) Company (`/api/companies`)

| API | Purpose |
|-----|---------|
| `GET /api/companies/hrms/status` | Is "Auto Fetch from HRMS" available for this user? |
| `GET /api/companies/hrms/tenants` | HRMS companies dropdown |
| `GET /api/companies/hrms/tenants/:id` | Prefill form from HRMS (incl. Company Admin name/email) |
| `GET /api/companies?as_of=YYYY-MM-DD` | List — details effective on that date (default today) |
| `GET /api/companies/:id` | Detail + full effective-date history |
| `POST /api/companies` | Add (multipart with `logo`, or JSON) — also creates the company admin login |
| `PUT /api/companies/:id` | Edit with `effective_date` |
| `DELETE /api/companies/:id/versions/:versionId` | Cancel a scheduled (future-dated) change |

**Effective date:** every add/edit stores a version in `company_versions` (`effective_from` → `effective_to`).
- Edit dated after the latest version → new version; previous one ends the day before.
- Edit on the same date as the latest version → corrects that version.
- Edit dated before the latest version → rejected.
- Future-dated edits stay scheduled; `GET` shows them as `upcoming_change`.

**Auto Fetch from HRMS:** send `hrms_tenant_id` on add; blank company fields and logo are taken from HRMS.
Admin password is never copied from HRMS — it must be entered. Disable with `HRMS_ENABLED=false`;
set `HRMS_PUBLIC_URL` so HRMS logos resolve to a URL.

**Who can do what**

| User | Add | Edit | Subscription dates |
|------|-----|------|--------------------|
| Local `ADMIN`, portal Super Admin | ✔ | all companies | ✔ |
| Portal Group Admin | from HRMS only | own HRMS companies | ✔ |
| Local `COMPANY_ADMIN`, portal Company Admin | ✘ | own company | ✘ |

Uploaded logos are saved in `uploads/company-logos/` and served at `/uploads/...`.

### 2) Branch (`/api/branches`)

| API | Purpose |
|-----|---------|
| `GET /api/branches/states` | Indian states / UTs (State dropdown) |
| `GET /api/branches/location/search?q=` | Map search box — places in India with lat/lng, address, city, state, pincode |
| `GET /api/branches/location/reverse?lat=&lng=` | Address for a dropped/dragged map pin (India only) |
| `GET /api/branches/hrms/status?company_id=` | Is "Auto Fetch from HRMS" available for the selected company? |
| `GET /api/branches/hrms/branches?company_id=` | HRMS branches of that company (with `already_added`) |
| `GET /api/branches/hrms/branches/:hrmsBranchId?company_id=` | Prefill form from HRMS |
| `GET /api/branches?company_id=&as_of=&status=&search=` | List — details effective on that date |
| `GET /api/branches/:id` | Detail + full effective-date history |
| `POST /api/branches` | Add (`company_id`, `name`, `code`, `city`, `state` required) |
| `PUT /api/branches/:id` | Edit with `effective_date` |
| `DELETE /api/branches/:id/versions/:versionId` | Cancel a scheduled change |

- Same effective-date rules as Company. `status` is versioned too — `status=INACTIVE` with a future
  `effective_date` schedules closing a branch. Branch effective date cannot be before the company's.
- `code` is unique per company, stored uppercase, and changes immediately (not versioned).
- Auto Fetch works only for companies added from HRMS (`hrms_tenant_id`); send `hrms_branch_id` on add.
- Anyone who can see a company can add/edit its branches (company admins: own company only).
- Map search uses OpenStreetMap Nominatim (`GEOCODER_URL`); frontend should debounce typing (~1 request/second).

### 3) Client Master (`/api/clients`) and Vendor Master (`/api/vendors`)

Two **separate modules** — own tables (`client_*` / `vendor_*`), permissions (`clients.*` / `vendors.*`),
validations, audit logs and approval queues. They share only engine code (`src/services/party/`)
driven by the specs in `src/config/partyModules.js`. Both have identical APIs (shown for clients):

| API | Purpose |
|-----|---------|
| `GET /api/clients/meta` | Form metadata — fields, enums, GST state codes, your permissions |
| `GET /api/clients?company_id=&as_of=&category=&status=&search=` | List (details effective on `as_of`) |
| `POST /api/clients` | Add — profile + `financial` + `addresses`, `gst_registrations`, `bank_accounts`, `upi_ids`, `contacts` |
| `GET /api/clients/:id?as_of=` | Detail with all sections, upcoming changes, pending approvals |
| `PUT /api/clients/:id` | Edit profile (GST, tax, sales / purchase settings, status, hold) with `effective_date` |
| `PUT /api/clients/:id/financial` | Edit credit limit / period, terms, opening balance, payment mode |
| `GET /api/clients/:id/versions` | Profile + financial version history |
| `GET\|POST /api/clients/:id/{section}` | Sections: `addresses`, `gst-registrations`, `bank-accounts`, `upi-ids`, `contacts`, `documents` |
| `PUT /api/clients/:id/{section}/:rootId` | Edit a section record with `effective_date` |
| `POST …/{section}/:rootId/deactivate\|reactivate\|default\|verify` | Dated (de)activation, default selection, verification |
| `GET …/{section}/:rootId/history` | Old / new values of a section record |
| `POST /api/clients/:id/approval`, `/kyc`, `/merge` | Record approval, KYC status, merge duplicate into another record |
| `GET /api/clients/approvals`, `POST /approvals/:id/decision` | Approval queue for sensitive changes |
| `GET /api/clients/audit-logs`, `GET /api/clients/:id/audit-logs` | History viewer — filter by date, field, user, company, FY |
| `GET /api/clients/duplicates`, `POST /api/clients/check-duplicates` | Duplicate scan / live check |
| `GET /api/clients/:id/snapshot?date=` | Details as on a date — store on invoices / vouchers |
| `GET /api/clients/:id/transactions` | Linked sales vouchers (clients) / purchase vouchers (vendors) |

- **Effective date** on every add / edit (profile, financial and each section record), same rules as Company.
  Nothing is deleted: addresses, bank accounts, UPI IDs etc. are deactivated from a date and kept in history.
- **Validation:** GSTIN checksum; state code and PAN derived from GSTIN and must match; GSTIN required for
  REGULAR / COMPOSITION / SEZ / … and not allowed for UNREGISTERED / CONSUMER / OVERSEAS; PAN, IFSC, UPI,
  mobile, pincode formats; map location must be in India.
- **Duplicates:** same GSTIN in the company = blocked (409). Same PAN / mobile / email / name = warning (409 with
  `details`) — resend with `acknowledge_duplicates=true`.
- **Approvals:** changes to GSTIN, PAN, registration type, state, tax treatment, credit / payment hold, credit
  limit, opening balance, GST registrations, bank accounts and UPI IDs by users without `.approve` return
  **202 PENDING_APPROVAL** and apply when approved. Records created by such users start as `PENDING`.
- **Audit:** field-level old / new values, effective date, financial year, reason, user, role and approval in
  `client_audit_logs` / `vendor_audit_logs`; address and bank history in separate tables. These are append-only
  (database triggers block UPDATE / DELETE).
- **Permissions** (`src/config/permissions.js`): Admin / Super Admin / Group Admin / Company Admin = all;
  Manager = view, create, edit, audit; Sales = clients view / create / edit, vendors view;
  Department Head = view (bank account numbers masked).
- KYC documents (PDF / PNG / JPG / WEBP, max 5 MB, multipart field `file`) are stored privately in
  `storage/party-documents/` and downloaded only through the API.
- `outstanding_balance` / `advance_balance` are read-only here — maintained by the sales / purchase modules.

### 4) Product & Item Master (`/api/products`) — sections A–K

Company-scoped item master (`products.*`) covering master data, UOM, GST, inventory, pricing, tracking,
BOM/production, attributes, and append-only history.

| Section | APIs |
|---------|------|
| **A Master** | `meta`, categories, tags, products CRUD, variants, media |
| **B UOM** | `/uoms`, `/:id/conversions` — predefined + custom units, product-specific factors, dual qty on stock txns |
| **C GST** | `/:id/gst` — HSN/SAC, rates 0/5/12/18/28, tax type, effective-dated history |
| **D Inventory** | `/warehouses`, `/stock`, `/stock/ledger`, `/stock/opening`, `/adjust`, `/transfer`, `/:id/reorder` |
| **E Pricing** | `/:id/prices`, `/:id/vendors` — purchase/retail/wholesale/commercial/standard cost + vendor maps |
| **F Tracking** | `tracking_type` / `warranty_months` on product; batches & serials on opening stock; warranty table |
| **G BOM** | `/boms`, `/production-orders` + issue / return / complete (+ scrap) |
| **H Attributes** | `/attribute-defs`, `/:id/attributes`, `/bulk-update`, `/check-duplicates`, `/tags/seed-suggested` |
| **I–K** | `product_audit_logs` + `inventory_transactions` / `inventory_audit_logs` append-only; unique SKU rules |

- Stock **balances** (`inventory_stock`) are separate from the immutable **ledger** (`inventory_transactions`).
- Unit conversions are **product-specific** (e.g. 1 Roll ≠ always 100 m); incompatible UOMs blocked without a factor.
- Posted stock / production rows keep qty and UOM snapshots; master edits do not rewrite history.
- **Permissions:** Admin = all; Manager = view / create / edit / audit; Sales & Department Head = view.

### 5) Accounting (`/api/accounting`), Sales (`/api/sales`), Purchases (`/api/purchases`)

**Order of use:** set up books → (optional) adjust ledgers / mapping / numbering → opening bills → vouchers → reports.

Company books (`accounting.*` permissions):

| API | Purpose |
|-----|---------|
| `POST /api/accounting/companies/:companyId/setup` | One-time: books start date, FY start month, company GSTIN / state / address; seeds ledgers, mapping, numbering |
| `GET\|PUT /api/accounting/companies/:companyId/settings` | Company GST & invoice settings (round-off, e-way bill threshold, credit-limit BLOCK / WARN) with `effective_date` |
| `GET\|POST /api/accounting/companies/:companyId/financial-years`, `POST /financial-years/:id/close\|reopen` | Financial years (auto-created); closed years accept no entries |
| `GET\|POST /api/accounting/ledgers`, `GET\|PUT /ledgers/:id`, `GET /ledgers/:id/statement` | Chart of accounts — name / group / status versioned by `effective_date` |
| `GET\|PUT /api/accounting/companies/:companyId/ledger-mappings` | Which ledger each posting uses (Sales, Output CGST, Bank …) from an `effective_date` |
| `GET\|POST /api/accounting/voucher-series`, `PUT /voucher-series/:id`, `GET /:id/preview` | Voucher numbering per type / branch — tokens `{FY}` `{FYFULL}` `{YYYY}` `{YY}` `{MM}` `{SEQ}`, format versioned |
| `GET /api/accounting/trial-balance`, `/reconciliation`, `/bank-reconciliation`, `/audit-logs` | Reports and checks |

Sales (linked only to Client Master, `sales.*`) and Purchases (linked only to Vendor Master, `purchases.*`) have
separate tables and the same API shape:

| API | Purpose |
|-----|---------|
| `POST /api/sales/vouchers` | `SALES_INVOICE`, `RECEIPT`, `REFUND`, `SALES_RETURN`, `CREDIT_NOTE` |
| `POST /api/purchases/vouchers` | `PURCHASE_INVOICE`, `PAYMENT`, `PURCHASE_RETURN`, `DEBIT_NOTE` |
| `GET /vouchers/:id`, `PUT /vouchers/:id` (amend, `reason` required), `POST /vouchers/:id/cancel`, `GET /vouchers/:id/revisions` | Voucher life-cycle |
| `POST /allocations`, `POST /allocations/:id/reverse`, `POST /vouchers/:id/auto-allocate` | Bill-wise adjustment (FIFO auto) |
| `GET\|PUT /{clients\|vendors}/:partyId/opening-bills`, `GET /{clients\|vendors}/:partyId/statement` | Bill-wise opening balance, party ledger statement |
| `POST\|PUT /vouchers/:id/eway-bill`, `POST /vouchers/:id/eway-bill/cancel`, `GET /vouchers/:id/eway-bill/json` | E-way bill record, Part-B update, cancel (24 h), portal JSON |
| `GET /outstanding`, `/receivables` (sales) or `/payables` (purchases), `/ageing`, `/register`, `/gst-report`, `/eway-bills/pending`, `/audit-logs` | Reports |

- **Transaction-time details:** each voucher stores the party snapshot (name, GSTIN, state, addresses, terms) and
  company GST details effective on the voucher date. GST reports read these stored values, so later master edits
  never change past returns. Ledger mapping, ledger status and numbering format are also taken as of the voucher date.
- **GST:** CGST + SGST when company state = place of supply, else IGST; SEZ / export always IGST; exempt / nil /
  zero-rated handled; composition / unregistered vendors without tax unless reverse charge (RCM → RCM payable
  + input credit); `itc_eligible=false` lines add tax to cost. Sales GST report = GSTR-1 sections (B2B, B2CL > ₹1 lakh,
  B2CS, EXP, CDNR, CDNUR, nil / exempt, HSN, documents); purchase report = ITC summary.
- **General ledger:** double entry in `ledger_entries`, append-only. Amend / cancel post reversal rows and re-post;
  previous revisions are kept in `*_voucher_revisions`. Voucher date must stay in the same financial year.
- **Bill-wise:** receipts / payments / returns adjust bills (manual, `against_voucher_id`, or `auto_allocate`);
  unadjusted amounts are advances. Opening bills post on the books start date against "Opening Balance Difference".
- **Controls:** credit hold / payment hold and credit limit (override needs `sales.approve`); duplicate supplier
  invoice number blocked per FY; cash receipt ≥ ₹2 lakh (269ST) and cash payment > ₹10,000 (40A(3)) warnings;
  e-way bill warning above the threshold.
- **Permissions:** Admin roles = all; Manager = sales / purchases view, create, edit, cancel, audit and accounting
  view; Sales = sales view / create / edit; Department Head = view.
- **Not included yet:** stock / inventory movements, quotations / orders / goods receipt, live NIC e-way bill and e-invoice
  (IRN) APIs, TDS / TCS, multi-currency.
