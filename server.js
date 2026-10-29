import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { matchItems, summarize } from './lib/cart.js';
import { createKroger } from './lib/kroger.js';
import { cleanName, mergeDuplicates } from './lib/names.js';
import { createPantry } from './lib/pantry.js';
import { measurementsFor, normalizeUnit, shortfall } from './lib/units.js';

const {
  INSTACART_API_KEY,
  INSTACART_BASE_URL = 'https://connect.dev.instacart.tools',
  PARTNER_LINKBACK_URL = 'http://localhost:3000',
  APP_API_TOKEN,
  TRUST_PROXY, // e.g. 1 when behind nginx, so rate limits see real client IPs
  KROGER_CLIENT_ID,
  KROGER_CLIENT_SECRET,
  KROGER_REDIRECT_URI, // must exactly match a redirect URL registered on the Kroger app
  KROGER_BASE_URL = 'https://api.kroger.com',
  KROGER_TOKEN_FILE = './data/kroger-tokens.json',
  PANTRY_FILE = './data/pantry.json',
  PORT = 3000,
} = process.env;

// Instacart's guidance: pages tailored to one user are short-lived (under 14
// days); pages for a static recipe live longer (over 31 days) and get reused.
// Cached links are dropped a day before they expire.
const CUSTOM_EXPIRES_IN_DAYS = 14;
const STATIC_EXPIRES_IN_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const urlCache = new Map(); // endpoint + payload hash -> { url, expiresAt }

// Drop expired entries so the cache doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, { expiresAt }] of urlCache) if (expiresAt <= now) urlCache.delete(key);
}, 60 * 60 * 1000).unref();

const pantry = createPantry(PANTRY_FILE);

const krogerEnabled = Boolean(KROGER_CLIENT_ID && KROGER_CLIENT_SECRET && KROGER_REDIRECT_URI);
const kroger = krogerEnabled
  ? createKroger({
      clientId: KROGER_CLIENT_ID,
      clientSecret: KROGER_CLIENT_SECRET,
      redirectUri: KROGER_REDIRECT_URI,
      baseUrl: KROGER_BASE_URL,
      tokenFile: KROGER_TOKEN_FILE,
    })
  : null;

const app = express();
if (TRUST_PROXY) app.set('trust proxy', Number(TRUST_PROXY) || TRUST_PROXY);
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

// Every /api route needs `Authorization: Bearer <APP_API_TOKEN>`. This service
// is meant to be called by your own backend or trusted app, which is
// responsible for deciding who a `userId` is. With no token set it refuses
// everything rather than running open.
function requireToken(req, res, next) {
  if (!APP_API_TOKEN) return res.status(503).json({ error: 'APP_API_TOKEN is not configured' });
  const given = Buffer.from(req.get('authorization')?.replace(/^Bearer /i, '') ?? '');
  const expected = Buffer.from(APP_API_TOKEN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const limiter = (max) => rateLimit({
  windowMs: 60 * 1000,
  limit: max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});

// Rate limit before auth so bad-token guessing is throttled too. Routes that
// spend Instacart calls get a tighter limit on top of the general one.
app.use('/api', limiter(120), requireToken);
app.use('/api/instacart', limiter(20));
app.use('/api/kroger', limiter(30));

// Posts payload to an Instacart IDP endpoint and responds with the page link,
// serving a cached link when the same payload was sent before.
async function respondWithLink(res, path, payload, skipped = []) {
  if (!INSTACART_API_KEY) {
    return res.status(500).json({ error: 'INSTACART_API_KEY is not configured' });
  }

  const cacheKey = createHash('sha256').update(path + JSON.stringify(payload)).digest('hex');
  const cached = urlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ url: cached.url, cached: true, skipped });
  }

  try {
    const upstream = await fetch(`${INSTACART_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${INSTACART_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(502).json({ error: 'Instacart request failed', status: upstream.status, details: data });
    }
    if (!data.products_link_url) {
      return res.status(502).json({ error: 'Instacart returned no link', details: data });
    }
    urlCache.set(cacheKey, { url: data.products_link_url, expiresAt: Date.now() + (payload.expires_in - 1) * DAY_MS });
    res.json({ url: data.products_link_url, skipped });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Instacart', details: String(err) });
  }
}

const expiresInDays = (userId) => (userId ? CUSTOM_EXPIRES_IN_DAYS : STATIC_EXPIRES_IN_DAYS);

// Cleans names for Instacart matching and the pantry lookup, and merges repeats.
const normalizeItems = (items) =>
  mergeDuplicates(items.map(({ name, displayText, ...rest }) => ({ ...rest, ...cleanName(name, displayText) })));

const isValidItem = (i) => i && typeof i.name === 'string' && i.name.trim() !== '';

// Subtracts what the user already has from what the recipe/list needs.
// Items with no quantity can't be compared, so they are always kept.
// Names in `keep` are always included in full, which lets a user put back
// something the pantry said they already have.
function subtractPantry(userId, items, keep = []) {
  const kept = new Set(keep.map((n) => String(n).trim().toLowerCase()));
  const needed = [];
  const skipped = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!userId || !(quantity > 0) || kept.has(item.name.trim().toLowerCase())) {
      needed.push(item);
      continue;
    }
    const need = { quantity, unit: normalizeUnit(item.unit) };
    const missing = shortfall(need, pantry.get(userId, item.name));
    if (missing) needed.push({ ...item, ...missing });
    else skipped.push(item.name);
  }
  return { needed, skipped };
}

// Turns an item into the fields Instacart expects; `measurementsKey` differs
// between the recipe and shopping-list endpoints. `name` is used for matching,
// so keep it generic; `displayText` is only for preparation notes ("diced onion").
function toLineItem({ name, quantity, unit, displayText }, measurementsKey) {
  const q = Number(quantity);
  return {
    name,
    ...(displayText && { display_text: displayText }),
    ...(q > 0 && { [measurementsKey]: measurementsFor({ quantity: q, unit }) }),
  };
}

// Pantry: what the user already has at home.
// PUT body: { quantity, unit }
app.get('/api/pantry/:userId', (req, res) => res.json(pantry.list(req.params.userId)));

app.put('/api/pantry/:userId/:name', (req, res) => {
  const { quantity, unit } = req.body ?? {};
  if (!(Number(quantity) >= 0)) return res.status(400).json({ error: 'quantity must be a number >= 0' });
  const { name } = cleanName(req.params.name);
  pantry.set(req.params.userId, name, quantity, unit);
  res.json(pantry.get(req.params.userId, name));
});

app.delete('/api/pantry/:userId/:name', (req, res) => {
  pantry.remove(req.params.userId, cleanName(req.params.name).name);
  res.status(204).end();
});

// Builds an Instacart recipe page for a recipe and returns its link.
// Body: { userId?, keep?: string[], preview?, title, servings?, imageUrl?,
//         instructions?: string[], ingredients: [{ name, quantity?, unit?, displayText? }] }
// With a userId, ingredients already in that user's pantry are left out, except
// names in `keep`. With `preview: true`, returns { needed, skipped } and does
// not call Instacart, so the app can let the user put items back first.
app.post('/api/instacart/recipe', (req, res) => {
  const { userId, keep, preview, title, servings, imageUrl, instructions, ingredients } = req.body ?? {};
  if (!title || !Array.isArray(ingredients) || ingredients.length === 0 || !ingredients.every(isValidItem)) {
    return res.status(400).json({ error: 'title and ingredients ({ name, quantity?, unit? }) are required' });
  }

  const { needed, skipped } = subtractPantry(userId, normalizeItems(ingredients), keep);
  if (preview) return res.json({ needed, skipped });
  if (needed.length === 0) return res.json({ url: null, skipped });

  respondWithLink(res, '/idp/v1/products/recipe', {
    title,
    servings,
    image_url: imageUrl,
    expires_in: expiresInDays(userId),
    instructions,
    ingredients: needed.map((item) => toLineItem(item, 'measurements')),
    landing_page_configuration: { partner_linkback_url: PARTNER_LINKBACK_URL, enable_pantry_items: true },
  }, skipped);
});

// Builds an Instacart shopping list page (e.g. a whole meal-plan cart) and returns its link.
// Body: { userId?, keep?: string[], preview?, title?, imageUrl?,
//         items: [{ name, quantity?, unit?, displayText? }] }
// Pantry handling (userId, keep, preview) works as on the recipe endpoint.
app.post('/api/instacart/shopping-list', (req, res) => {
  const { userId, keep, preview, title = 'Seasonal Chef shopping list', imageUrl, items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0 || !items.every(isValidItem)) {
    return res.status(400).json({ error: 'items must be a non-empty array of { name, quantity?, unit? }' });
  }

  const { needed, skipped } = subtractPantry(userId, normalizeItems(items), keep);
  if (preview) return res.json({ needed, skipped });
  if (needed.length === 0) return res.json({ url: null, skipped });

  respondWithLink(res, '/idp/v1/products/products_link', {
    title,
    image_url: imageUrl,
    link_type: 'shopping_list',
    expires_in: expiresInDays(userId),
    line_items: needed.map((item) => toLineItem(item, 'line_item_measurements')),
    landing_page_configuration: { partner_linkback_url: PARTNER_LINKBACK_URL },
  }, skipped);
});

// Lets clients hide the Instacart button until a key is configured.
app.get('/api/config', (req, res) => res.json({ instacartEnabled: Boolean(INSTACART_API_KEY), krogerEnabled }));

const formatQuantity = ({ quantity, unit }) => {
  const q = Number(quantity);
  if (!(q > 0)) return '';
  const n = Math.round(q * 100) / 100;
  return unit && unit !== 'each' ? `${n} ${unit} ` : `${n} `;
};

// Plain-text shopping list that works with no partner API: the same pantry
// handling as the Instacart endpoints, returned as a Markdown checklist.
// Body: { userId?, keep?: string[], title?, items: [{ name, quantity?, unit?, displayText? }] }
app.post('/api/shopping-list/export', (req, res) => {
  const { userId, keep, title = 'Shopping list', items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0 || !items.every(isValidItem)) {
    return res.status(400).json({ error: 'items must be a non-empty array of { name, quantity?, unit? }' });
  }

  const { needed, skipped } = subtractPantry(userId, normalizeItems(items), keep);
  const lines = needed.map((i) => `- [ ] ${formatQuantity(i)}${i.displayText ?? i.name}`);
  res.json({ needed, skipped, text: [`# ${title}`, ...lines].join('\n') });
});

// ---- Kroger (Public APIs): match ingredients to products and add them to the shopper's cart ----

const requireKroger = (req, res, next) =>
  kroger ? next() : res.status(503).json({ error: 'Kroger credentials are not configured' });

const krogerError = (res, err) => {
  if (err.status === 401 && !err.details) return res.status(401).json({ error: err.message, needsConnect: true });
  console.error(err.message, err.details ?? '');
  return res.status(502).json({ error: 'Kroger request failed', status: err.status, details: err.details });
};

// Kroger carts take whole product units, not recipe measurements, so a "2 cups"
// ingredient becomes 1 product. Countable items ("3 each") use the count.
const cartQuantity = ({ quantity, unit }) =>
  Number(quantity) > 0 && normalizeUnit(unit) === 'each' ? Math.ceil(Number(quantity)) : 1;

// Nearby Kroger-family stores. Body: { zipCode }
app.post('/api/kroger/stores', requireKroger, async (req, res) => {
  const { zipCode } = req.body ?? {};
  if (!/^\d{5}$/.test(String(zipCode))) return res.status(400).json({ error: 'zipCode must be 5 digits' });
  try {
    res.json({ stores: await kroger.findStores(zipCode) });
  } catch (err) {
    krogerError(res, err);
  }
});

// Starts the shopper's Kroger sign-in. Body: { userId }. Send the user to `url`.
app.post('/api/kroger/connect', requireKroger, (req, res) => {
  const { userId } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  res.json({ url: kroger.startConnect(String(userId)) });
});

app.get('/api/kroger/status/:userId', requireKroger, async (req, res) => {
  try {
    res.json({ connected: await kroger.isConnected(req.params.userId) });
  } catch (err) {
    krogerError(res, err);
  }
});

// Kroger redirects the shopper's browser here after they approve access, so it
// can't carry our bearer token. The one-time `state` ties it to the request we started.
app.get('/kroger/callback', requireKroger, async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) return res.status(400).send('Kroger sign-in was cancelled or failed.');
  try {
    await kroger.finishConnect(String(code), String(state));
    res.redirect(PARTNER_LINKBACK_URL);
  } catch (err) {
    console.error(err.message, err.details ?? '');
    res.status(err.status === 400 ? 400 : 502).send('Could not complete Kroger sign-in. Please try again.');
  }
});

// Matches ingredients to Kroger products at a store and adds them to the shopper's cart.
// Body: { userId, locationId, modality?: 'PICKUP'|'DELIVERY', keep?: string[], preview?,
//         items: [{ name, quantity?, unit?, upc? }] }
// Pantry handling matches the other endpoints. With `preview: true` it only returns
// the matches, so the app can show them before anything is added. Pass `upc` on an
// item to skip the search (e.g. a product the user already picked).
app.post('/api/kroger/cart', requireKroger, async (req, res) => {
  const { userId, locationId, modality = 'PICKUP', keep, preview, items } = req.body ?? {};
  if (!userId || !/^\d{8}$/.test(String(locationId))) {
    return res.status(400).json({ error: 'userId and an 8-digit locationId are required' });
  }
  if (!['PICKUP', 'DELIVERY'].includes(modality)) return res.status(400).json({ error: 'modality must be PICKUP or DELIVERY' });
  if (!Array.isArray(items) || items.length === 0 || items.length > 40 || !items.every(isValidItem)) {
    return res.status(400).json({ error: 'items must be 1-40 entries of { name, quantity?, unit?, upc? }' });
  }

  try {
    const { needed, skipped } = subtractPantry(userId, normalizeItems(items), keep);
    const results = await matchItems(needed, (item) => kroger.searchProduct(item.name, locationId));
    // `failed` = lookups that errored (timeout, rate limit): worth retrying, unlike `unmatched`.
    const { matched, unmatched, failed } = summarize(results, cartQuantity);

    if (preview || matched.length === 0) return res.json({ matched, unmatched, failed, skipped });
    await kroger.addToCart(userId, matched, modality);
    res.json({ added: matched, unmatched, failed, skipped });
  } catch (err) {
    krogerError(res, err);
  }
});

app.listen(PORT, () => console.log(`Seasonal Chef listening on :${PORT}`));
