import { createHash } from 'node:crypto';
import express from 'express';

const {
  INSTACART_API_KEY,
  INSTACART_BASE_URL = 'https://connect.dev.instacart.tools',
  PARTNER_LINKBACK_URL = 'http://localhost:3000',
  PORT = 3000,
} = process.env;

// Instacart recipe links expire after 30 days by default; reuse them until
// shortly before that, and only regenerate when the recipe changes.
const CACHE_TTL_MS = 29 * 24 * 60 * 60 * 1000;
const urlCache = new Map(); // payload hash -> { url, expiresAt }

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Builds an Instacart recipe page for a recipe and returns its link.
// Body: { title, servings?, imageUrl?, instructions?: string[],
//         ingredients: [{ name, quantity?, unit? }] }
app.post('/api/instacart/recipe', async (req, res) => {
  const { title, servings, imageUrl, instructions, ingredients } = req.body ?? {};
  if (!title || !Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'title and ingredients are required' });
  }
  if (!INSTACART_API_KEY) {
    return res.status(500).json({ error: 'INSTACART_API_KEY is not configured' });
  }

  const payload = {
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
  };

  const cacheKey = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const cached = urlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ url: cached.url, cached: true });
  }

  try {
    const upstream = await fetch(`${INSTACART_BASE_URL}/idp/v1/products/recipe`, {
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
});

app.listen(PORT, () => console.log(`Seasonal Chef listening on :${PORT}`));
