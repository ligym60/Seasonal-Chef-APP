# Seasonal Chef: handover

Branch: `claude/intelligent-allen-5sifmv` (not merged, no pull request opened). Repo: `ligym60/Seasonal-Chef-APP`.
`main` is still just the README. Everything below lives on this branch.

## What this is

A small Node/Express service that connects a recipe app to grocery providers. Given a recipe or shopping list it:

1. Cleans ingredient names (`2 cups flour, sifted` -> `flour`).
2. Subtracts what the user already has in their pantry (only the shortfall is sent).
3. Hands the rest to a provider: Instacart pages, Kroger carts, or a plain-text list.

It is meant to be called by your own backend or trusted app, not directly by browsers. The demo page in `public/` is for local testing only.

## Status at a glance

| Piece | State |
|---|---|
| Instacart recipe and shopping-list pages | Built, tested against a fake server only. **Blocked: Instacart is not accepting new Developer Platform applications** (no waitlist) |
| Pantry store and subtraction | Built, tested |
| Name cleanup, duplicate merging | Built, tested (rule-based, spot-check on real recipes) |
| Auth (bearer token) and rate limiting | Built, tested |
| Plain-text list export (Copy / Share / Print) | Built, tested in a browser. Works with no partner key |
| Kroger (stores, sign-in, product match, add to cart) | Built against Kroger's published API specs, tested against a fake server only. Needs your client secret and a real shopper sign-in to verify |
| Zinc / Walmart | **Not built.** Research only, see below |
| Tests | `npm test` (20 tests, Node's built-in runner): Kroger client (token refresh race, timeouts, cart), cart matching (concurrency, partial failure, duplicates) and the cart route end to end, all against a fake Kroger server in `test/`. Pantry math, name cleanup, auth and rate limits are **not** covered yet |

## Run it locally

Needs Node 18+ (tested on Node 22).

```bash
npm install
cp .env.example .env   # then fill it in
node --env-file=.env server.js
```

Then open http://localhost:3000. The demo page prompts for `APP_API_TOKEN`.

## Configuration (`.env.example`)

| Variable | Purpose |
|---|---|
| `APP_API_TOKEN` | Shared secret. Every `/api` route needs `Authorization: Bearer <token>`. If unset, the API answers 503 to everything. Generate with `openssl rand -hex 32` |
| `TRUST_PROXY` | Set to `1` behind nginx so rate limits use real client IPs |
| `PARTNER_LINKBACK_URL` | Where Instacart pages link back to, and where shoppers land after Kroger sign-in |
| `PANTRY_FILE` | JSON pantry store, default `./data/pantry.json` (git-ignored) |
| `INSTACART_API_KEY`, `INSTACART_BASE_URL` | Instacart Developer Platform. Dev server `https://connect.dev.instacart.tools`, production `https://connect.instacart.com` |
| `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_REDIRECT_URI`, `KROGER_BASE_URL`, `KROGER_TOKEN_FILE` | Kroger Public APIs. Redirect must exactly match one registered on the Kroger app and end in `/kroger/callback`. Never commit the secret |

## Files

- `server.js`: all routes, auth, rate limiting, the Instacart call + URL cache, Kroger routes.
- `lib/units.js`: unit conversion within volume or weight (never between them), pantry shortfall, extra measurements for Instacart.
- `lib/names.js`: ingredient name cleanup and duplicate merging.
- `lib/pantry.js`: JSON-file pantry store (atomic writes).
- `lib/kroger.js`: Kroger client: OAuth (client credentials and authorization code with PKCE), locations, products, cart, token storage (file mode 600).
- `public/index.html`: demo page (Instacart button only shows when a key is set, plus Copy / Share / Print).
- `README.md`: short endpoint reference.

## Endpoints (all under `/api` need the bearer token, except the Kroger callback)

- `GET /api/config` returns `{ instacartEnabled, krogerEnabled }`.
- `GET|PUT|DELETE /api/pantry/:userId[/:name]` manages the pantry (`PUT` body `{ quantity, unit }`).
- `POST /api/instacart/recipe` and `POST /api/instacart/shopping-list` return `{ url, skipped }`.
- `POST /api/shopping-list/export` returns a Markdown checklist (`text`), no partner needed.
- `POST /api/kroger/stores`, `POST /api/kroger/connect`, `GET /api/kroger/status/:userId`, `POST /api/kroger/cart`.
- `GET /kroger/callback` is Kroger's redirect target, with no bearer token. It is protected by a one-time `state` plus PKCE.

Shared pantry options on the Instacart, export and Kroger-cart endpoints: `userId` (subtract that user's pantry), `keep: ["flour"]` (put a skipped item back), `preview: true` (return `{ needed, skipped }` or the Kroger matches without acting).

## Key decisions and why

- **Send needed amounts, not package sizes.** Instacart turns the quantity into a purchasable size; we send e.g. 2 cups or 100 g.
- **Several measurements per ingredient** (first one drives the quantity), per Instacart's guidance. Volumes get fl oz and ml; weights get g, oz, lb.
- **Expiry:** pages with a `userId` expire in 14 days (custom pages); others in 60 (static recipes). Cached links are dropped a day early. `name` is only the generic product; `display_text` is only for prep notes.
- **Kroger quantities:** Kroger carts hold whole product units, so "2 cups milk" becomes 1 milk. Only `each` ingredients use the count.
- **Cache and pantry are single-process:** the Instacart URL cache is in memory (resets on restart). The pantry and Kroger tokens are JSON files. Move to a database or Redis if you run several instances.
- **Auth model:** one shared app token. This service trusts the `userId` it is given; deciding who a user is belongs to your main app.

## Research findings (as of 2026-10-29)

- **Instacart:** the Developer Platform page says "We are currently not accepting new applications. There is no waitlist." Docs mention a 30 to 40 day path to production after access. Recipe page endpoint `POST /idp/v1/products/recipe`, shopping list `POST /idp/v1/products/products_link`, bearer API key. Unclear whether the recipe page is reachable without being invited. Suggested next step: contact Instacart's Enterprise service desk / technical support and ask to be added when applications reopen.
- **Instacart Connect Fulfillment API:** for retailers, not app developers. Not a fit.
- **Publix / Winn-Dixie:** no developer API found. They sell through Instacart (older sources), so the Instacart integration is the likely route.
- **Zinc** (zinc.com): places orders from product URLs. Costco is "observed" (no completed order yet), BJ's, Publix and Winn-Dixie are "untested" (check `GET https://api.zinc.com/retailers/check?url=...`). Walmart is "active" but Zinc says it cannot buy groceries (Amazon Fresh, Whole Foods named) and caps orders at 10 products. Pricing: $1 per successful order plus item cost, $0.01 per product search, wallet top-up fees. Not built because it is a poor fit for fresh groceries. If revisited, start with Zinc's no-account sandbox (`POST /sandbox/keys`, free test key); that call was blocked by this session's safety check, so mint the key yourself.
- **Other providers:** MealMe (custom pricing, sales meeting and license) and Pepesto were found but not researched in depth. Kroger covers Kroger-family stores only.
- **Kroger:** your app is registered as **Seasonal chef** (Production environment). Use the four **Public** APIs: Authorization Endpoints, Product, Location, Cart. Scopes: `product.compact` (products, client credentials), `cart.basic:write` (cart, shopper sign-in). Public limits per day: 10,000 product, 1,600 location, 5,000 cart. Certification environment is `https://api-ce.kroger.com`. Cart-add is the only cart operation in the Public API; checkout happens in Kroger's app or site.

## Next steps

1. Add `KROGER_CLIENT_SECRET` and `KROGER_REDIRECT_URI` to `.env`, enable the Public APIs on the Kroger app, and run a real shopper sign-in plus one add-to-cart. Check the redirect URL matches exactly.
2. Add a Kroger store picker and "Add to Kroger cart" button to the front end (the demo page has none yet), showing the `preview` matches before adding.
3. Email Instacart (see above) and recheck their developer page periodically. When a key arrives, set `INSTACART_API_KEY` and run a dev-server test order with 2 cups milk and 100 g flour.
4. Replace the demo front end with your real app, and have your backend (not the browser) hold `APP_API_TOKEN`.
5. Extend the automated tests to pantry math, name cleanup, auth and rate limits (the Kroger client and cart route are covered; see `test/`).
6. If you deploy to the VPS: set `TRUST_PROXY=1`, keep `data/` out of git, and back up the pantry and token files.
7. Open a pull request for this branch when you are ready to merge into `main`.

## Kroger fixes after review (branch `fix/kroger-cart-reliability`)

Fixed and tested: concurrent token refresh no longer signs a shopper out (one shared refresh per user); one failed product lookup no longer loses the cart (`failed` is reported, at most 5 lookups at once, all-failed is a 502); every Kroger call has a 10 s timeout; duplicate UPCs merge into one line; tokens are kept in a `Map`.

Still open from the review: matching takes the first in-stock result (rank results and let the shopper swap a match); the sign-in `state` is not bound to the browser that started it (add a short-lived cookie); non-`each` items always add quantity 1 (show this in the preview). None of it has run against the real Kroger service yet.

## Gotchas from this session

- The cloud session blocks outbound hosts that are not allow-listed. Hosts that had to be added: `docs.instacart.com`, `company.instacart.com`, `www.zinc.com`, `api.zinc.com`, `zinc.com`, `developer.kroger.com`, `api.kroger.com`, `api-ce.kroger.com`. This does not apply to your own machine.
- Kroger's developer site is a JavaScript app, so plain `curl` shows no docs. The API definitions were read by rendering the pages in a headless browser.
- No secrets are in the repo. Keep `.env` and `data/` out of git (both are in `.gitignore`).
