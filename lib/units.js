// Unit conversion within a family (volume, weight, count). Volume and weight
// are never converted into each other: that needs per-ingredient density.
const FAMILIES = {
  volume: { // base: millilitre
    ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, 'fl oz': 29.5735,
    cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41,
  },
  weight: { // base: gram
    g: 1, kg: 1000, oz: 28.3495, lb: 453.592,
  },
  count: { each: 1 },
};

const ALIASES = {
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', mls: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp', ts: 'tsp', tspn: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tb: 'tbsp', tbs: 'tbsp',
  'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz', floz: 'fl oz',
  cups: 'cup', c: 'cup', pints: 'pint', pt: 'pint', pts: 'pint',
  quarts: 'quart', qt: 'quart', qts: 'quart',
  gallons: 'gallon', gal: 'gallon', gals: 'gallon',
  gram: 'g', grams: 'g', gs: 'g', kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb',
  unit: 'each', units: 'each',
};

export function normalizeUnit(unit) {
  const u = String(unit ?? 'each').trim().toLowerCase();
  return ALIASES[u] ?? u;
}

function familyOf(unit) {
  return Object.entries(FAMILIES).find(([, units]) => unit in units)?.[0] ?? null;
}

// Returns the quantity in the family's base unit, or null for unknown units.
function toBase(quantity, unit) {
  const family = familyOf(unit);
  return family ? { family, base: quantity * FAMILIES[family][unit] } : null;
}

export function convert(quantity, fromUnit, toUnit) {
  const from = toBase(quantity, normalizeUnit(fromUnit));
  const to = normalizeUnit(toUnit);
  if (!from || familyOf(to) !== from.family) return null;
  return from.base / FAMILIES[from.family][to];
}

const round = (n) => Math.round(n * 100) / 100;

// How much of `need` is still missing given `have`, in need's unit.
// Incomparable units (e.g. cups vs grams) can't be subtracted, so the whole
// amount is treated as missing and the user can skip it on Instacart's page.
export function shortfall(need, have) {
  if (!have) return need;
  const haveInNeedUnit = convert(have.quantity, have.unit, need.unit);
  if (haveInNeedUnit == null) return need;
  const missing = need.quantity - haveInNeedUnit;
  return missing > 0.001 ? { quantity: round(missing), unit: need.unit } : null;
}

// Alternative ways to measure the same amount, so Instacart can choose the
// one that best matches a purchasable size. The requested unit comes first.
// Only weights get alternates: a volume of a dry good (a cup of flour) isn't
// meaningfully a fluid-ounce or millilitre amount.
const ALTERNATES = { weight: ['g', 'oz', 'lb'] };

export function measurementsFor({ quantity, unit }) {
  const primary = normalizeUnit(unit);
  const measurements = [{ quantity: round(quantity), unit: primary }];
  const family = familyOf(primary);
  for (const alt of ALTERNATES[family] ?? []) {
    if (alt !== primary) measurements.push({ quantity: round(convert(quantity, primary, alt)), unit: alt });
  }
  return measurements;
}
