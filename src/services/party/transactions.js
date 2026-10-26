/**
 * Transaction-history registry. Sales / purchase modules register a fetcher per document type:
 *
 *   registerTransactionSource('clients', 'SALES_INVOICE', async (clientIds, { from, to }) => ({ count, items }))
 *
 * Fetchers receive the record id plus ids of records merged into it, so history survives merges.
 */
const SOURCES = { clients: new Map(), vendors: new Map() };

function registerTransactionSource(moduleKey, type, fetcher) {
  if (!SOURCES[moduleKey]) throw new Error(`Unknown module ${moduleKey}`);
  SOURCES[moduleKey].set(type, fetcher);
}

async function collectTransactions(cfg, partyIds, filters = {}) {
  const result = {};
  for (const type of cfg.transactionTypes) {
    const fetcher = SOURCES[cfg.key].get(type);
    result[type] = fetcher
      ? { available: true, ...(await fetcher(partyIds, filters)) }
      : { available: false, count: 0, items: [] };
  }
  return result;
}

module.exports = { registerTransactionSource, collectTransactions };
