/**
 * General-ledger posting. ledger_entries is append-only: editing or cancelling a voucher posts
 * reversal rows for the old revision. "Live" entries = not reversed.
 */
const { httpError } = require('../common');
const { resolveMapping } = require('./ledgers');
const { r2, opposite } = require('./common');

/** SQL condition for entries that are still effective (alias must be `e`). */
const LIVE_ENTRY_SQL = `e.is_reversal = 0 AND NOT EXISTS (
  SELECT 1 FROM ledger_entries r
  WHERE r.source = e.source AND r.voucher_id = e.voucher_id AND r.revision = e.revision AND r.is_reversal = 1)`;

/**
 * Builds balanced postings for a voucher.
 * v: voucher columns (party_effect, total_amount, taxes, round_off, reverse_charge, cash_bank_ledger_id, posting_date)
 * lines: computed lines with resolved ledger_id
 */
async function buildPostings(conn, side, typeCfg, v, lines) {
  const date = v.posting_date;
  const companyId = v.company_id;
  const partyLedger = await resolveMapping(conn, companyId, side.controlKey, date);
  const party = v.party_effect;
  const other = opposite(party);
  const rows = [];
  const add = (ledgerId, effect, amount, isParty = false) => {
    const a = r2(amount);
    if (!a) return;
    const eff = a < 0 ? opposite(effect) : effect;
    rows.push({ ledger_id: ledgerId, effect: eff, amount: Math.abs(a), party: isParty });
  };

  add(partyLedger.id, party, v.total_amount, true);

  if (typeCfg.opening) {
    add((await resolveMapping(conn, companyId, 'OPENING_BALANCE', date)).id, other, v.total_amount);
  } else if (typeCfg.cash) {
    add(v.cash_bank_ledger_id, other, v.total_amount);
  } else {
    const taxKeys = { cgst_amount: 'CGST', sgst_amount: 'SGST', igst_amount: 'IGST', cess_amount: 'CESS' };
    const eligibleTax = { cgst_amount: 0, sgst_amount: 0, igst_amount: 0, cess_amount: 0 };
    for (const line of lines) {
      const lineTax = line.cgst_amount + line.sgst_amount + line.igst_amount + line.cess_amount;
      const toExpense = side.key === 'purchases' && !line.itc_eligible ? lineTax : 0;
      add(line.ledger_id, other, line.taxable_value + toExpense);
      if (!toExpense) for (const f of Object.keys(eligibleTax)) eligibleTax[f] += line[f];
    }
    for (const [f, k] of Object.entries(taxKeys)) {
      if (r2(eligibleTax[f])) add((await resolveMapping(conn, companyId, `${side.taxPrefix}_${k}`, date)).id, other, eligibleTax[f]);
    }
    if (v.reverse_charge) {
      const rcm = r2(Number(v.cgst_amount) + Number(v.sgst_amount) + Number(v.igst_amount) + Number(v.cess_amount));
      if (rcm) add((await resolveMapping(conn, companyId, 'RCM_PAYABLE', date)).id, party, rcm);
    }
    if (r2(v.round_off)) add((await resolveMapping(conn, companyId, 'ROUND_OFF', date)).id, other, v.round_off);
  }

  const dr = r2(rows.filter((x) => x.effect === 'DR').reduce((s, x) => s + x.amount, 0));
  const cr = r2(rows.filter((x) => x.effect === 'CR').reduce((s, x) => s + x.amount, 0));
  if (dr !== cr) throw httpError(500, `Posting is not balanced (DR ${dr} / CR ${cr})`);
  return rows;
}

async function postEntries(conn, side, v, rows, actor) {
  const values = rows.map((x) => [
    v.company_id, v.financial_year_id, v.posting_date, side.source, v.id, v.voucher_type, v.voucher_no, v.revision,
    x.ledger_id, x.party ? side.partyType : null, x.party ? v[side.partyFk] : null,
    x.effect === 'DR' ? x.amount : 0, x.effect === 'CR' ? x.amount : 0,
    v.narration ? String(v.narration).slice(0, 500) : null, 0, actor,
  ]);
  await conn.query(
    `INSERT INTO ledger_entries
       (company_id, financial_year_id, entry_date, source, voucher_id, voucher_type, voucher_no, revision,
        ledger_id, party_type, party_id, debit, credit, narration, is_reversal, created_by)
     VALUES ?`,
    [values]
  );
}

/** Reverses all entries of one voucher revision (same dates, debit / credit swapped). */
async function reverseEntries(conn, side, voucherId, revision, actor) {
  const [rows] = await conn.query(
    'SELECT * FROM ledger_entries WHERE source = ? AND voucher_id = ? AND revision = ? AND is_reversal = 0',
    [side.source, voucherId, revision]
  );
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO ledger_entries
       (company_id, financial_year_id, entry_date, source, voucher_id, voucher_type, voucher_no, revision,
        ledger_id, party_type, party_id, debit, credit, narration, is_reversal, created_by)
     VALUES ?`,
    [rows.map((e) => [
      e.company_id, e.financial_year_id, e.entry_date, e.source, e.voucher_id, e.voucher_type, e.voucher_no, e.revision,
      e.ledger_id, e.party_type, e.party_id, e.credit, e.debit, e.narration, 1, actor,
    ])]
  );
}

module.exports = { LIVE_ENTRY_SQL, buildPostings, postEntries, reverseEntries };
