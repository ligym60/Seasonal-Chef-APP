import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { cleanName, mergeDuplicates } from './lib/names.js';
import { createPantry } from './lib/pantry.js';
import { measurementsFor, normalizeUnit, shortfall } from './lib/units.js';

const {
  INSTACART_API_KEY,
  INSTACART_BASE_URL = 'https://connect.dev.instacart.tools',
  PARTNER_LINKBACK_URL = 'http://localhost:3000',
  APP_API_TOKEN,
  TRUST_PROXY, // e.g. 1 when behind nginx, so rate limits see real client IPs
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

app.listen(PORT, () => console.log(`Seasonal Chef listening on :${PORT}`));
