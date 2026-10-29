import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const EXPIRY_MARGIN_MS = 60 * 1000;

const base64url = (buf) => buf.toString('base64url');

// Client for Kroger's Public APIs: Authorization (OAuth2), Locations, Products, Cart.
// Product and location lookups use an app-level client-credentials token; the
// cart needs a shopper's own token from the authorization-code flow
// (scope cart.basic:write), which we keep per userId.
export function createKroger({ clientId, clientSecret, redirectUri, baseUrl, tokenFile, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const basicAuth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  let appToken = null; // { accessToken, expiresAt }
  const pendingStates = new Map(); // state -> { userId, verifier, expiresAt }
  // A Map, not a plain object: a userId such as "__proto__" or "constructor" is just a key here.
  let userTokens = new Map();
  try {
    userTokens = new Map(Object.entries(JSON.parse(readFileSync(tokenFile, 'utf8'))));
  } catch {
    // no tokens saved yet
  }
  // userId -> in-flight refresh. Kroger refresh tokens are single use, so two requests refreshing the
  // same shopper at once would make the second fail and wrongly sign them out. They share one refresh.
  const refreshing = new Map();

  function saveTokens() {
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(`${tokenFile}.tmp`, JSON.stringify(Object.fromEntries(userTokens)), { mode: 0o600 });
    renameSync(`${tokenFile}.tmp`, tokenFile);
  }

  async function request(path, { method = 'GET', headers = {}, body, query } = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
    // Every Kroger call has a deadline: a stalled response must not hang the caller.
    let res;
    try {
      res = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
      throw Object.assign(new Error(`Kroger ${method} ${url.pathname} ${timedOut ? `timed out after ${timeoutMs} ms` : 'could not be reached'}`), {
        status: timedOut ? 504 : 502,
        cause,
      });
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = new Error(`Kroger ${method} ${url.pathname} failed with ${res.status}`);
      err.status = res.status;
      err.details = data;
      throw err;
    }
    return data;
  }

  const tokenRequest = (form) =>
    request('/v1/connect/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth },
      body: new URLSearchParams(form).toString(),
    });

  async function getAppToken() {
    if (appToken && appToken.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return appToken.accessToken;
    const data = await tokenRequest({ grant_type: 'client_credentials', scope: 'product.compact' });
    appToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return appToken.accessToken;
  }

  const withAppToken = async (path, query) =>
    request(path, { query, headers: { Authorization: `Bearer ${await getAppToken()}` } });

  // Nearby Kroger-family stores. Products and prices are per store.
  async function findStores(zipCode, limit = 5) {
    const { data = [] } = await withAppToken('/v1/locations', {
      'filter.zipCode.near': zipCode,
      'filter.limit': limit,
    });
    return data.map((l) => ({
      locationId: l.locationId,
      name: l.name,
      chain: l.chain,
      address: l.address,
    }));
  }

  // Best in-stock match for an ingredient name at a store, or null.
  async function searchProduct(term, locationId) {
    const { data = [] } = await withAppToken('/v1/products', {
      'filter.term': term,
      'filter.locationId': locationId,
      'filter.limit': 10,
    });
    for (const product of data) {
      const item = product.items?.[0];
      if (!product.upc || !item || item.inventory?.stockLevel === 'TEMPORARILY_OUT_OF_STOCK') continue;
      const image = product.images?.find((i) => i.default) ?? product.images?.[0];
      return {
        upc: product.upc,
        description: product.description,
        brand: product.brand,
        size: item.size,
        price: item.price?.promo || item.price?.regular || null,
        imageUrl: image?.sizes?.[0]?.url,
      };
    }
    return null;
  }

  // Starts the shopper sign-in. Returns the Kroger URL to send the user to.
  function startConnect(userId) {
    for (const [s, v] of pendingStates) if (v.expiresAt <= Date.now()) pendingStates.delete(s);
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48)); // PKCE (S256)
    pendingStates.set(state, { userId, verifier, expiresAt: Date.now() + STATE_TTL_MS });
    const url = new URL('/v1/connect/oauth2/authorize', baseUrl);
    url.search = new URLSearchParams({
      scope: 'cart.basic:write',
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  // Finishes sign-in from Kroger's redirect. Returns the userId it was started for.
  async function finishConnect(code, state) {
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) throw Object.assign(new Error('Unknown or expired state'), { status: 400 });
    const data = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: pending.verifier,
    });
    storeUserToken(pending.userId, data);
    return pending.userId;
  }

  function storeUserToken(userId, data) {
    userTokens.set(userId, {
      accessToken: data.access_token,
      // Refresh tokens are only granted with the authorization-code flow; keep the old one if none returned.
      refreshToken: data.refresh_token ?? userTokens.get(userId)?.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    saveTokens();
  }

  async function getUserToken(userId) {
    const t = userTokens.get(userId);
    if (!t) return null;
    if (t.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return t.accessToken;
    if (!t.refreshToken) return null;
    // Join a refresh already under way for this shopper instead of starting a second one.
    if (!refreshing.has(userId)) {
      const refresh = (async () => {
        try {
          storeUserToken(userId, await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken }));
          return userTokens.get(userId).accessToken;
        } catch (err) {
          if (err.status === 400 || err.status === 401) {
            userTokens.delete(userId); // refresh token revoked or expired: shopper must sign in again
            saveTokens();
            return null;
          }
          throw err;
        } finally {
          refreshing.delete(userId);
        }
      })();
      refreshing.set(userId, refresh);
    }
    return refreshing.get(userId);
  }

  const isConnected = async (userId) => Boolean(await getUserToken(userId));

  // items: [{ upc, quantity }]. Kroger answers 204 with no body.
  async function addToCart(userId, items, modality = 'PICKUP') {
    const token = await getUserToken(userId);
    if (!token) throw Object.assign(new Error('Shopper is not connected to Kroger'), { status: 401 });
    await request('/v1/cart/add', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: items.map(({ upc, quantity }) => ({ upc, quantity, modality })) }),
    });
  }

  return { findStores, searchProduct, startConnect, finishConnect, isConnected, addToCart };
}
