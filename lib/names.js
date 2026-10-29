import { convert, normalizeUnit } from './units.js';

// Instacart matches on `name`, so it should be the generic product: no
// quantity, weight or brand, and no preparation ("diced onion" -> "onion").
const UNIT_WORDS = '(?:cups?|c|tablespoons?|tbsp?|tbs|teaspoons?|tsp|ounces?|oz|pounds?|lbs?|grams?|g|kg|kilograms?|ml|milliliters?|liters?|l|pints?|quarts?|gallons?|cans?|bunch(?:es)?|cloves?|pinch(?:es)?)';
const LEADING_QUANTITY = new RegExp(`^\\s*(?:\\d+(?:[./]\\d+)?|[¼½¾⅓⅔])\\s*(?:-\\s*\\d+(?:[./]\\d+)?\\s*)?(?:${UNIT_WORDS}\\b\\.?\\s*)?(?:of\\s+)?`, 'i');
const PREP_WORDS = /^(?:finely |roughly |thinly |freshly )?(?:chopped|diced|minced|sliced|grated|shredded|crushed|sifted|melted|softened|peeled|cubed|halved|rinsed|drained|beaten|packed|divided|room temperature|to taste|optional)\b/i;

// Returns { name, displayText? }. displayText is set only when preparation
// was stripped, so the recipe page can still show "onion, diced".
export function cleanName(raw, displayText) {
  const original = String(raw).replace(LEADING_QUANTITY, '').trim();
  let name = original.replace(/\([^)]*\)/g, ' ');

  const [head, ...rest] = name.split(',');
  const tail = rest.join(',').trim();
  if (rest.length && PREP_WORDS.test(tail)) name = head;

  // "diced onion" -> "onion"
  const lead = name.trim().match(new RegExp(`^(${PREP_WORDS.source.slice(1).replace(/\\b$/, '')})\\s+(.+)$`, 'i'));
  if (lead) name = lead[2];

  name = name.replace(/\s+/g, ' ').trim() || original;
  const changed = name.toLowerCase() !== original.toLowerCase();
  return { name, ...(displayText ? { displayText } : changed && { displayText: original }) };
}

// Instacart wants each ingredient name once. Merge repeats when their units
// are comparable (1 cup + 8 fl oz milk); otherwise keep them separate.
export function mergeDuplicates(items) {
  const merged = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    const match = merged.find((m) => {
      if (m.name.toLowerCase() !== item.name.toLowerCase()) return false;
      if (!(quantity > 0) || !(Number(m.quantity) > 0)) return true;
      return convert(quantity, item.unit, m.unit) != null;
    });
    if (!match) {
      merged.push({ ...item });
    } else if (quantity > 0 && Number(match.quantity) > 0) {
      match.quantity = Number(match.quantity) + convert(quantity, item.unit, match.unit);
      match.unit = normalizeUnit(match.unit);
    }
  }
  return merged;
}
