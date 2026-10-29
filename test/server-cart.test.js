// The cart route end to end: the real server, talking to the fake Kroger.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeKroger } from './fake-kroger.js';

const TOKEN = 'test-app-token';
let fake;
let child;
let base;

async function waitFor(url, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > end) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

before(async () => {
  fake = await startFakeKroger({ products: { milk: 'U-MILK', 'whole milk': 'U-MILK', eggs: 'U-EGGS', flaky: 'error' } });
  const dir = mkdtempSync(join(tmpdir(), 'cart-'));
  const tokenFile = join(dir, 'tokens.json');
  writeFileSync(tokenFile, JSON.stringify({ shopper: { accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } }));
  const port = 3300 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      APP_API_TOKEN: TOKEN,
      KROGER_CLIENT_ID: 'id',
      KROGER_CLIENT_SECRET: 'secret',
      KROGER_REDIRECT_URI: `${base}/kroger/callback`,
      KROGER_BASE_URL: fake.url,
      KROGER_TOKEN_FILE: tokenFile,
      PANTRY_FILE: join(dir, 'pantry.json'),
    },
    stdio: 'ignore',
  });
  await waitFor(`${base}/api/config`);
});

after(async () => {
  child?.kill();
  await fake?.close();
});

const post = (items, extra = {}) =>
  fetch(`${base}/api/kroger/cart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ userId: 'shopper', locationId: '01400943', items, ...extra }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('a failing lookup is reported as failed; the rest still go in the cart', async () => {
  const { status, body } = await post([{ name: 'milk' }, { name: 'flaky' }, { name: 'eggs' }, { name: 'unicorn' }]);
  assert.equal(status, 200);
  assert.deepEqual(body.added.map((a) => a.upc).sort(), ['U-EGGS', 'U-MILK']);
  assert.deepEqual(body.failed, ['flaky']);
  assert.deepEqual(body.unmatched, ['unicorn']);
  const sent = fake.log.cartAdds.at(-1).body.items;
  assert.equal(sent.length, 2);
});

test('two ingredients matching one product are one cart line', async () => {
  const before = fake.log.cartAdds.length;
  const { body } = await post([{ name: 'milk' }, { name: 'whole milk' }]);
  assert.equal(body.added.length, 1);
  assert.equal(body.added[0].quantity, 2);
  const line = fake.log.cartAdds[before].body.items;
  assert.deepEqual(line.map((l) => [l.upc, l.quantity]), [['U-MILK', 2]]);
});

test('preview shows matches and failures without touching the cart', async () => {
  const before = fake.log.cartAdds.length;
  const { body } = await post([{ name: 'eggs' }, { name: 'flaky' }], { preview: true });
  assert.equal(body.matched.length, 1);
  assert.deepEqual(body.failed, ['flaky']);
  assert.equal(fake.log.cartAdds.length, before);
});

test('when every lookup fails it is a 502, not a quiet "nothing matched"', async () => {
  const { status, body } = await post([{ name: 'flaky' }]);
  assert.equal(status, 502);
  assert.equal(body.error, 'Kroger request failed');
});

test('a 40-item list searches no more than 5 at a time', async () => {
  fake.log.maxInFlight = 0;
  await post(Array.from({ length: 40 }, (_, i) => ({ name: i % 2 ? 'milk' : 'eggs' })), { preview: true });
  assert.ok(fake.log.maxInFlight <= 5, `max in flight was ${fake.log.maxInFlight}`);
  assert.ok(fake.log.maxInFlight >= 2);
});
