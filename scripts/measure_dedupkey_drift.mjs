/**
 * Would STEP 9's normaliser change the dedup key of rows that already have one?
 *
 * `phoneKey()` was a stand-in: 10 digits -> "+1" + digits, 11 starting with 1 ->
 * "+" + digits, 8 or more -> "+" + digits. The new normaliser is
 * libphonenumber-js. `dedup_key` carries a UNIQUE index and is how every future
 * ingest recognises a business it already holds, so if the two disagree on a row
 * that is already stored, the next import of that business inserts a SECOND row
 * instead of matching — a duplicate created by the act of improving the parser.
 *
 * This prints how many rows would move, and shows a few, before anything writes.
 *
 * Usage: node scripts/measure_dedupkey_drift.mjs /tmp/s9/pkeys.clean.json
 */
import { readFileSync } from 'node:fs';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));

// The pre-STEP-9 stand-in, copied verbatim from imports.ts so the comparison is
// against what actually ran, not against a paraphrase of it.
function phoneKey(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8) return `+${digits}`;
  return null;
}

let same = 0;
let differs = 0;
let oldNullNewValue = 0;
let oldValueNewNull = 0;
const examples = [];

for (const row of rows) {
  const oldKey = phoneKey(row.phone_raw);
  const p = parsePhoneNumberFromString(String(row.phone_raw ?? ''), row.country_code === 'US' ? 'US' : undefined);
  const newKey = p && p.isValid() ? p.number : null;

  if (oldKey === newKey) same += 1;
  else {
    differs += 1;
    if (!oldKey && newKey) oldNullNewValue += 1;
    else if (oldKey && !newKey) oldValueNewNull += 1;
    if (examples.length < 8) {
      examples.push({ raw: row.phone_raw, stored: row.dedup_key, oldKey, newKey });
    }
  }
}

console.log(`phone-keyed rows examined   ${rows.length}`);
console.log(`key unchanged               ${same}`);
console.log(`key WOULD change            ${differs}`);
console.log(`  old produced nothing      ${oldNullNewValue}`);
console.log(`  old produced, new does not ${oldValueNewNull}`);
console.log('');
console.log('examples of drift (stored dedup_key vs the two calculators):');
for (const e of examples) {
  console.log(`  raw=${JSON.stringify(e.raw).padEnd(20)} stored=${e.stored.padEnd(20)} old=${String(e.oldKey).padEnd(20)} new=${e.newKey}`);
}
