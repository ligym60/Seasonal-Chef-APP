# Seasonal-Chef-APP
Healthy recipe provider

## Instacart + pantry

- `POST /api/instacart/recipe` and `POST /api/instacart/shopping-list` return an Instacart page link.
  Pass `userId` to leave out anything already in that user's pantry (only the shortfall is sent).
- `GET /api/pantry/:userId`, `PUT /api/pantry/:userId/:name` (`{ quantity, unit }`), `DELETE /api/pantry/:userId/:name`.
- Config is in `.env.example`; pantry data is stored in `PANTRY_FILE` (default `./data/pantry.json`).
- Units convert within volume or weight only. Cups vs grams can't be compared, so the full amount is sent.
