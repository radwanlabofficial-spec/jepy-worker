/**
 * Measures what STEP 9 will actually produce, before STEP 9 writes anything.
 *
 * Reads a JSON dump of {id, phone_raw, country_code} and reports the numbers the
 * migration and the backfill design depend on: how many numbers resolve, which
 * `phone_type` values libphonenumber actually returns for THIS dataset (the
 * schema wants a CHECK, and a guessed enum is a constraint that rejects real
 * data), and — the one that decides the whole design — how many distinct leads
 * collapse onto the SAME E.164, because each collapse is a potential merge.
 *
 * Usage: node scripts/measure_normalise.mjs /tmp/s9/phones.clean.json
 */
import { readFileSync } from 'node:fs';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

const path = process.argv[2];
const rows = JSON.parse(readFileSync(path, 'utf8'));

const types = new Map();
const byE164 = new Map();
let blank = 0;
let parsed = 0;
let invalid = 0;
let changedFromRaw = 0;
const samples = { blank: [], invalid: [] };

for (const row of rows) {
  const raw = String(row.phone_raw ?? '');
  if (raw.trim() === '') {
    blank += 1;
    if (samples.blank.length < 3) samples.blank.push({ id: row.id, raw });
    continue;
  }

  const defaultCountry = row.country_code === 'US' ? 'US' : undefined;
  const p = parsePhoneNumberFromString(raw, defaultCountry);

  if (!p || !p.isValid()) {
    invalid += 1;
    if (samples.invalid.length < 5) samples.invalid.push({ id: row.id, raw, reason: p ? 'parsed but invalid' : 'not parseable' });
    continue;
  }

  parsed += 1;
  const e164 = p.number;
  if (e164 !== raw) changedFromRaw += 1;

  // getType() is the library's own vocabulary, not ours.
  const t = p.getType() ?? 'unknown';
  types.set(t, (types.get(t) ?? 0) + 1);

  const bucket = byE164.get(e164) ?? [];
  bucket.push(row.id);
  byE164.set(e164, bucket);
}

const collisions = [...byE164.entries()].filter(([, ids]) => ids.length > 1);
const collisionLeadCount = collisions.reduce((n, [, ids]) => n + ids.length, 0);
const overTwo = collisions.filter(([, ids]) => ids.length > 2);

const pct = (n) => `${((n / rows.length) * 100).toFixed(2)}%`;
console.log(`rows in dump            ${rows.length}`);
console.log(`blank phone_raw         ${blank}  ${pct(blank)}`);
console.log(`parsed + valid          ${parsed}  ${pct(parsed)}`);
console.log(`present but invalid     ${invalid}  ${pct(invalid)}`);
console.log(`E.164 differs from raw  ${changedFromRaw}`);
console.log(`distinct E.164          ${byE164.size}`);
console.log('');
console.log('phone_type values the library actually returns on THIS data:');
for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(22)} ${n}`);
}
console.log('');
console.log(`E.164 values held by >1 lead (the merge risk): ${collisions.length}`);
console.log(`  leads involved: ${collisionLeadCount}`);
console.log(`  of those, >2 leads (the R8 shared-phone demotion): ${overTwo.length}`);
for (const [e164, ids] of collisions.slice(0, 10)) {
  console.log(`    ${e164}  x${ids.length}  ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ' …' : ''}`);
}
console.log('');
console.log('blank samples   ', JSON.stringify(samples.blank));
console.log('invalid samples ', JSON.stringify(samples.invalid));
