# Seasonal-Chef-APP
Healthy recipe provider

## Instacart + pantry

- `POST /api/instacart/recipe` and `POST /api/instacart/shopping-list` return an Instacart page link.
  Pass `userId` to leave out anything already in that user's pantry (only the shortfall is sent).
  Add `preview: true` to get `{ needed, skipped }` without calling Instacart, then call again with
  `keep: ["flour"]` to put a skipped item back. Items take an optional `displayText` for prep notes ("diced onion").
- Pages with a `userId` expire in 14 days; others in 60 (Instacart's guidance for custom vs static recipes).
- `GET /api/pantry/:userId`, `PUT /api/pantry/:userId/:name` (`{ quantity, unit }`), `DELETE /api/pantry/:userId/:name`.
- Config is in `.env.example`; pantry data is stored in `PANTRY_FILE` (default `./data/pantry.json`).
- Units convert within volume or weight only. Cups vs grams can't be compared, so the full amount is sent.

## Security and matching

- Every `/api` route requires `Authorization: Bearer <APP_API_TOKEN>`; with no token configured the API refuses all requests.
  This service is meant to be called by your own backend, which decides who a `userId` is. Don't ship the token to browsers
  (the demo page prompts for it only for local testing).
- Rate limits per IP: 120 requests/minute on `/api`, and 20/minute on the Instacart endpoints. Set `TRUST_PROXY=1` behind nginx.
- Ingredient names are cleaned before matching and pantry lookups ("2 cups flour, sifted" -> `flour`, with "flour, sifted" kept as display text),
  and repeated ingredients are merged when their units are comparable.

## Without Instacart access

Instacart isn't accepting new Developer Platform applications, so the app works without a key:
- `POST /api/shopping-list/export` returns the pantry-aware list as a Markdown checklist (`text`), using the same `userId`/`keep` options.
- `GET /api/config` returns `{ instacartEnabled }`; the demo page hides the Instacart button until `INSTACART_API_KEY` is set, and offers Copy / Share / Print in the meantime.
