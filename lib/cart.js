// Matching a shopping list to Kroger products. Kept apart from the route so it can be tested
// without a server: the route passes in the search function.

const DEFAULT_CONCURRENCY = 5;

// Looks every item up with at most `concurrency` searches in flight (a 40-item list must not burst
// into Kroger's rate limit), and never lets one failed lookup lose the others. Each result is
// { item, product } where product is null for "no match", or { item, product: null, error } when the
// lookup itself failed (timeout, 429, 5xx) so the caller can tell "not sold here" from "try again".
// An item that already carries a upc skips the search.
export async function matchItems(items, search, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        results[i] = { item, product: item.upc ? { upc: String(item.upc) } : await search(item) };
      } catch (error) {
        results[i] = { item, product: null, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Cart lines from the matched results. Two ingredients can resolve to the same product ("milk" and
// "whole milk"); they become one line with the quantities added, in the order first seen.
export function cartLines(results, quantityFor) {
  const byUpc = new Map();
  for (const { item, product } of results) {
    if (!product) continue;
    const quantity = quantityFor(item);
    const line = byUpc.get(product.upc);
    if (line) {
      line.quantity += quantity;
      line.names.push(item.name);
    } else {
      byUpc.set(product.upc, { ...product, name: item.name, names: [item.name], quantity });
    }
  }
  return [...byUpc.values()];
}

// Splits results into what the route reports: matched lines, items with no match, and items whose
// lookup failed. If every lookup failed the cause is systemic (bad credentials, Kroger down), so the
// first error is thrown for the route to report instead of pretending nothing is sold here.
export function summarize(results, quantityFor) {
  const failed = results.filter((r) => r.error);
  if (results.length > 0 && failed.length === results.length) throw failed[0].error;
  return {
    matched: cartLines(results, quantityFor),
    unmatched: results.filter((r) => !r.product && !r.error).map((r) => r.item.name),
    failed: failed.map((r) => r.item.name),
  };
}
