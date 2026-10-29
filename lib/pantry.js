import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeUnit } from './units.js';

// A tiny JSON-file pantry store: { [userId]: { [ingredient]: { quantity, unit } } }.
// Fine for one server process; swap for a database if you scale out.
export function createPantry(file) {
  let data = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // no pantry file yet
  }

  function save() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file); // atomic replace so a crash can't corrupt it
  }

  const key = (name) => String(name).trim().toLowerCase();

  return {
    list: (userId) => data[userId] ?? {},
    get: (userId, name) => data[userId]?.[key(name)],
    set(userId, name, quantity, unit) {
      (data[userId] ??= {})[key(name)] = { quantity: Number(quantity), unit: normalizeUnit(unit) };
      save();
    },
    remove(userId, name) {
      if (data[userId]) delete data[userId][key(name)];
      save();
    },
  };
}
