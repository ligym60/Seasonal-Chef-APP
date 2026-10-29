import { createHash } from 'node:crypto';
import express from 'express';
import { createPantry } from './lib/pantry.js';
import { measurementsFor, normalizeUnit, shortfall } from './lib/units.js';

const {
  INSTACART_API_KEY,
  INSTACART_BASE_URL = 'https://connect.dev.instacart.tools',
  PARTNER_LINKBACK_URL = 'http://localhost:3000',
  PANTRY_FILE = './data/pantry.json',
  PORT = 3000,
} = process.env;

// Links expire after LINK_EXPIRES_IN_DAYS (recipes default to 30, shopping lists
// have no default so we set it). Reuse them until shortly before that, and only
// regenerate when the content changes.
const LINK_EXPIRES_IN_DAYS = 30;
const CACHE_TTL_MS = (LINK_EXPIRES_IN_DAYS - 1) * 24 * 60 * 60 * 1000;
const urlCache = new Map(); // endpoint + payload hash -> { url, expiresAt }

// Drop expired entries so the cache doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, { expiresAt }] of urlCache) if (expiresAt <= now) urlCache.delete(key);
}, 60 * 60 * 1000).unref();

const pantry = createPantry(PANTRY_FILE);

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
    urlCache.set(cacheKey, { url: data.products_link_url, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json({ url: data.products_link_url, skipped });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Instacart', details: String(err) });
  }
}

const isValidItem = (i) => i && typeof i.name === 'string' && i.name.trim() !== '';

// Subtracts what the user already has from what the recipe/list needs.
// Items with no quantity can't be compared, so they are always kept.
function subtractPantry(userId, items) {
  const needed = [];
  const skipped = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!userId || !(quantity > 0)) {
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
// between the recipe and shopping-list endpoints.
function toLineItem({ name, quantity, unit }, measurementsKey) {
  const q = Number(quantity);
  const hasQuantity = q > 0;
  return {
    name,
    display_text: [hasQuantity && q, hasQuantity && unit, name].filter(Boolean).join(' '),
    ...(hasQuantity && { [measurementsKey]: measurementsFor({ quantity: q, unit }) }),
  };
}

// Pantry: what the user already has at home.
// PUT body: { quantity, unit }
app.get('/api/pantry/:userId', (req, res) => res.json(pantry.list(req.params.userId)));

app.put('/api/pantry/:userId/:name', (req, res) => {
  const { quantity, unit } = req.body ?? {};
  if (!(Number(quantity) >= 0)) return res.status(400).json({ error: 'quantity must be a number >= 0' });
  pantry.set(req.params.userId, req.params.name, quantity, unit);
  res.json(pantry.get(req.params.userId, req.params.name));
});

app.delete('/api/pantry/:userId/:name', (req, res) => {
  pantry.remove(req.params.userId, req.params.name);
  res.status(204).end();
});

// Builds an Instacart recipe page for a recipe and returns its link.
// Body: { userId?, title, servings?, imageUrl?, instructions?: string[],
//         ingredients: [{ name, quantity?, unit? }] }
// With a userId, ingredients already in that user's pantry are left out.
app.post('/api/instacart/recipe', (req, res) => {
  const { userId, title, servings, imageUrl, instructions, ingredients } = req.body ?? {};
  if (!title || !Array.isArray(ingredients) || ingredients.length === 0 || !ingredients.every(isValidItem)) {
    return res.status(400).json({ error: 'title and ingredients ({ name, quantity?, unit? }) are required' });
  }

  const { needed, skipped } = subtractPantry(userId, ingredients);
  if (needed.length === 0) return res.json({ url: null, skipped });

  respondWithLink(res, '/idp/v1/products/recipe', {
    title,
    servings,
    image_url: imageUrl,
    instructions,
    ingredients: needed.map((item) => toLineItem(item, 'measurements')),
    landing_page_configuration: { partner_linkback_url: PARTNER_LINKBACK_URL, enable_pantry_items: true },
  }, skipped);
});

// Builds an Instacart shopping list page (e.g. a whole meal-plan cart) and returns its link.
// Body: { userId?, title?, imageUrl?, items: [{ name, quantity?, unit? }] }
// With a userId, items already in that user's pantry are left out.
app.post('/api/instacart/shopping-list', (req, res) => {
  const { userId, title = 'Seasonal Chef shopping list', imageUrl, items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0 || !items.every(isValidItem)) {
    return res.status(400).json({ error: 'items must be a non-empty array of { name, quantity?, unit? }' });
  }

  const { needed, skipped } = subtractPantry(userId, items);
  if (needed.length === 0) return res.json({ url: null, skipped });

  respondWithLink(res, '/idp/v1/products/products_link', {
    title,
    image_url: imageUrl,
    link_type: 'shopping_list',
    expires_in: LINK_EXPIRES_IN_DAYS,
    line_items: needed.map((item) => toLineItem(item, 'line_item_measurements')),
    landing_page_configuration: { partner_linkback_url: PARTNER_LINKBACK_URL },
  }, skipped);
});

app.listen(PORT, () => console.log(`Seasonal Chef listening on :${PORT}`));
