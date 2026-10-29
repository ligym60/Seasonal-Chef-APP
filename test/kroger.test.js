import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKroger } from '../lib/kroger.js';
import { startFakeKroger } from './fake-kroger.js';

const tokenFileWith = (tokens) => {
  const file = join(mkdtempSync(join(tmpdir(), 'kroger-')), 'tokens.json');
  writeFileSync(file, JSON.stringify(tokens));
  return file;
};
const client = (fake, tokenFile, extra = {}) =>
  createKroger({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://x/kroger/callback', baseUrl: fake.url, tokenFile, ...extra });
const expired = (refreshToken) => ({ accessToken: 'old', refreshToken, expiresAt: Date.now() - 1000 });

test('two requests for one shopper at the same moment share a single refresh and stay signed in', async () => {
  const fake = await startFakeKroger();
  try {
    fake.allowRefresh('r0'); // Kroger refresh tokens are single use
    const file = tokenFileWith({ shopper: expired('r0') });
    const kroger = client(fake, file);
    const [a, b, c] = await Promise.all([kroger.isConnected('shopper'), kroger.isConnected('shopper'), kroger.isConnected('shopper')]);
    assert.deepEqual([a, b, c], [true, true, true]);
    assert.equal(fake.log.tokenCalls.filter((t) => t.grant_type === 'refresh_token').length, 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).shopper.refreshToken, 'refresh-1'); // the new one was saved
  } finally {
    await fake.close();
  }
});

test('a refresh token Kroger rejects signs the shopper out, and only that shopper', async () => {
  const fake = await startFakeKroger();
  try {
    fake.allowRefresh('good');
    const kroger = client(fake, tokenFileWith({ revoked: expired('nope'), fine: expired('good') }));
    assert.equal(await kroger.isConnected('revoked'), false);
    assert.equal(await kroger.isConnected('fine'), true);
  } finally {
    await fake.close();
  }
});

test('a call that never gets an answer fails with 504 instead of hanging', async () => {
  const fake = await startFakeKroger({ hang: ['/v1/locations'] });
  try {
    const kroger = client(fake, tokenFileWith({}), { timeoutMs: 150 });
    const started = Date.now();
    await assert.rejects(kroger.findStores('45202'), (err) => err.status === 504 && /timed out/.test(err.message));
    assert.ok(Date.now() - started < 3000);
  } finally {
    await fake.close();
  }
});

test('an unreachable Kroger is a 502, not a crash', async () => {
  const fake = await startFakeKroger();
  const url = fake.url;
  await fake.close();
  const kroger = createKroger({ clientId: 'i', clientSecret: 's', redirectUri: 'http://x/c', baseUrl: url, tokenFile: tokenFileWith({}), timeoutMs: 500 });
  await assert.rejects(kroger.findStores('45202'), (err) => err.status === 502);
});

test('user ids like __proto__ are ordinary keys', async () => {
  const fake = await startFakeKroger();
  try {
    const kroger = client(fake, tokenFileWith({}));
    assert.equal(await kroger.isConnected('__proto__'), false);
    assert.equal(await kroger.isConnected('constructor'), false);
    assert.equal({}.accessToken, undefined);
  } finally {
    await fake.close();
  }
});

test('a signed-in shopper adds to the cart with their own token', async () => {
  const fake = await startFakeKroger();
  try {
    const kroger = client(fake, tokenFileWith({ shopper: { accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } }));
    await kroger.addToCart('shopper', [{ upc: '111', quantity: 2 }], 'PICKUP');
    assert.equal(fake.log.cartAdds[0].auth, 'Bearer live');
    assert.deepEqual(fake.log.cartAdds[0].body.items, [{ upc: '111', quantity: 2, modality: 'PICKUP' }]);
  } finally {
    await fake.close();
  }
});

test('adding to the cart without signing in says so (401)', async () => {
  const fake = await startFakeKroger();
  try {
    await assert.rejects(client(fake, tokenFileWith({})).addToCart('nobody', [{ upc: '1', quantity: 1 }]), (e) => e.status === 401);
  } finally {
    await fake.close();
  }
});
