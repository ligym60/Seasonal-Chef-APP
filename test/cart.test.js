import test from 'node:test';
import assert from 'node:assert/strict';
import { matchItems, cartLines, summarize } from '../lib/cart.js';

const items = (...names) => names.map((name) => ({ name }));
const qty = () => 1;

test('never runs more searches at once than the limit', async () => {
  let inFlight = 0;
  let max = 0;
  const search = async () => {
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return { upc: 'u' };
  };
  await matchItems(items(...Array.from({ length: 20 }, (_, i) => `item${i}`)), search, { concurrency: 3 });
  assert.equal(max, 3);
});

test('one failed lookup does not lose the others', async () => {
  const search = async ({ name }) => {
    if (name === 'bad') throw Object.assign(new Error('429'), { status: 429 });
    return name === 'ghost' ? null : { upc: `upc-${name}` };
  };
  const r = summarize(await matchItems(items('milk', 'bad', 'ghost', 'eggs'), search), qty);
  assert.deepEqual(r.matched.map((m) => m.upc), ['upc-milk', 'upc-eggs']);
  assert.deepEqual(r.failed, ['bad']);
  assert.deepEqual(r.unmatched, ['ghost']); // not sold here, as opposed to a lookup that errored
});

test('if every lookup fails, the cause is thrown instead of reported as unmatched', async () => {
  const err = Object.assign(new Error('Kroger is down'), { status: 502 });
  const search = async () => {
    throw err;
  };
  await assert.rejects(async () => summarize(await matchItems(items('a', 'b'), search), qty), err);
});

test('an item with a upc skips the search', async () => {
  let searches = 0;
  const r = await matchItems([{ name: 'milk', upc: 123 }], async () => {
    searches++;
    return { upc: 'x' };
  });
  assert.equal(searches, 0);
  assert.equal(r[0].product.upc, '123');
});

test('two ingredients that match the same product become one line with the quantities added', () => {
  const results = [
    { item: { name: 'milk' }, product: { upc: 'U1' } },
    { item: { name: 'eggs' }, product: { upc: 'U2' } },
    { item: { name: 'whole milk' }, product: { upc: 'U1' } },
  ];
  const lines = cartLines(results, () => 1);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.upc, l.quantity]), [['U1', 2], ['U2', 1]]);
  assert.deepEqual(lines[0].names, ['milk', 'whole milk']);
});

test('quantities follow the quantity function', () => {
  const lines = cartLines([{ item: { name: 'eggs', quantity: 3 }, product: { upc: 'U' } }], (i) => i.quantity);
  assert.equal(lines[0].quantity, 3);
});

test('an empty list is fine', async () => {
  assert.deepEqual(summarize(await matchItems([], async () => null), qty), { matched: [], unmatched: [], failed: [] });
});
