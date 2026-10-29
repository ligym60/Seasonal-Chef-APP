import { createHash } from 'node:crypto';
import express from 'express';

const {
  INSTACART_API_KEY,
  INSTACART_BASE_URL = 'https://connect.dev.instacart.tools',
  PARTNER_LINKBACK_URL = 'http://localhost:3000',
  PORT = 3000,
} = process.env;

// Links expire after LINK_EXPIRES_IN_DAYS (recipes default to 30, shopping lists
// have no default so we set it). Reuse them until shortly before that, and only
// regenerate when the content changes.
const LINK_EXPIRES_IN_DAYS = 30;
const CACHE_TTL_MS = (LINK_EXPIRES_IN_DAYS - 1) * 24 * 60 * 60 * 1000;
const urlCache = new Map(); // endpoint + payload hash -> { url, expiresAt }

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Posts payload to an Instacart IDP endpoint and responds with the page link,
// serving a cached link when the same payload was sent before.
async function respondWithLink(res, path, payload) {
  if (!INSTACART_API_KEY) {
    return res.status(500).json({ error: 'INSTACART_API_KEY is not configured' });
  }

  const cacheKey = createHash('sha256').update(path + JSON.stringify(payload)).digest('hex');
  const cached = urlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ url: cached.url, cached: true });
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
    res.json({ url: data.products_link_url });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Instacart', details: String(err) });
  }
}

// Builds an Instacart recipe page for a recipe and returns its link.
// Body: { title, servings?, imageUrl?, instructions?: string[],
//         ingredients: [{ name, quantity?, unit? }] }
app.post('/api/instacart/recipe', (req, res) => {
  const { title, servings, imageUrl, instructions, ingredients } = req.body ?? {};
  if (!title || !Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'title and ingredients are required' });
  }

  respondWithLink(res, '/idp/v1/products/recipe', {
    title,
    servings,
    image_url: imageUrl,
    instructions,
    ingredients: ingredients.map(({ name, quantity, unit }) => ({
      name,
      display_text: [quantity, unit, name].filter(Boolean).join(' '),
      ...(quantity && unit && { measurements: [{ quantity: Number(quantity), unit }] }),
    })),
    landing_page_configuration: { partner_linkback_url: PARTNER_LINKBACK_URL },
  });
});

// Builds an Instacart shopping list page (e.g. a whole meal-plan cart) and returns its link.
// Body: { title?, imageUrl?, items: [{ name, quantity?, unit? }] }
app.post('/api/instacart/shopping-list', (req, res) => {
  const { title = 'Seasonal Chef shopping list', imageUrl, items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0 || items.some((i) => !i?.name)) {
    return res.status(400).json({ error: 'items must be a non-empty array of { name, quantity?, unit? }' });
  }

  respondWithLink(res, '/idp/v1/products/products_link', {
    title,
    image_url: imageUrl,
    link_type: 'shopping_list',
    expires_in: LINK_EXPIRES_IN_DAYS,
    line_items: items.map(({ name, quantity, unit }) => ({
      name,
      display_text: [quantity, unit, name].filter(Boolean).join(' '),
      ...(quantity && unit && { line_item_measurements: [{ quantity: Number(quantity), unit }] }),
    })),
    landing_page_configuration: { partner_linkback_url: PARTNER_LINKBACK_URL },
  });
});

app.listen(PORT, () => console.log(`Seasonal Chef listening on :${PORT}`));
