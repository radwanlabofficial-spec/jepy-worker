import assert from 'node:assert/strict';
import {
  PASS1_BATCH_SIZE,
  buildAiLeadInput,
  parseAiBatch,
  parseManifestCredential,
  selectPass1Candidates,
} from '../src/scoring/pass1.ts';

function check(label: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, label);
  console.log(`  PASS  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

const now = 1_800_000_000;

console.log('1. server-side gate');
const gate = selectPass1Candidates(
  [
    { id: 'a', rule_score: 70, is_provisional: 0, deleted_at: null, ai_scored_at: null },
    { id: 'b', rule_score: 54, is_provisional: 0, deleted_at: null, ai_scored_at: null },
    { id: 'c', rule_score: 20, is_provisional: 0, deleted_at: null, ai_scored_at: null },
    { id: 'd', rule_score: 80, is_provisional: 1, deleted_at: null, ai_scored_at: null },
    { id: 'e', rule_score: 90, is_provisional: 0, deleted_at: null, ai_scored_at: now - 10 },
  ],
  55,
  10,
  now,
);
check('threshold and top-20% candidates are selected', gate.candidates.map((row) => row.id), ['a']);
check('provisional lead is rejected', gate.decisions.find((row) => row.id === 'd')?.reason, 'provisional');
check('24-hour AI cooldown is rejected', gate.decisions.find((row) => row.id === 'e')?.reason, 'ai_cooldown');

console.log('\n2. expired signals and Yelp sanitisation');
const input = buildAiLeadInput({
  id: 'lead-1',
  name: 'Example Business',
  city: 'Austin',
  niche: 'dental',
  website_url: 'https://example.test',
  employee_estimate: 12,
  geo_priority: 1,
  source_confidence: 0.9,
  phone_e164: '+15551234567',
  now,
  signals: [
    { signal_key: 'psi_mobile', signal_value_num: 82, signal_value_text: null, expires_at: null },
    { signal_key: 'funding_news', signal_value_num: 1, signal_value_text: 'recent', expires_at: now - 1 },
    { signal_key: 'yelp_rating', signal_value_num: 5, signal_value_text: '5 stars', expires_at: null },
  ],
});
check('expired funding is null', input.signals.funding_recent, null);
check('Yelp-derived signal is null', input.signals.review_trend, null);
check('phone is included only as a boolean', input.signals.has_phone, true);

console.log('\n3. strict output contract');
const outputs = parseAiBatch(
  JSON.stringify(Array.from({ length: PASS1_BATCH_SIZE }, (_, index) => ({
    id: `lead-${index}`,
    ai_score: 50 + index,
    reason: 'Concrete signals support a cautious qualification decision.',
    angle: 'Visible digital weakness and active buying signals.',
    confidence: 'medium',
  }))),
  Array.from({ length: PASS1_BATCH_SIZE }, (_, index) => `lead-${index}`),
);
check('exact ten outputs accepted', outputs.length, PASS1_BATCH_SIZE);
assert.throws(
  () => parseAiBatch(JSON.stringify([{ id: 'lead-0', ai_score: 1, reason: 'x', angle: 'y', confidence: 'low', extra: true }]), ['lead-0']),
  /AI output must contain exactly 1 objects|Unrecognized key/,
);
console.log('  PASS  extra output fields rejected');

console.log('\n4. Vault credential shape');
check('JSON endpoint credential accepted', parseManifestCredential('{"endpoint":"https://llm.example.test/v1/chat/completions","api_key":"secret","model":"model-1"}')?.endpoint, 'https://llm.example.test/v1/chat/completions');
check('plain key rejected until configured with endpoint', parseManifestCredential('secret-key'), null);
check('http remote endpoint rejected', parseManifestCredential('{"endpoint":"http://llm.example.test","api_key":"secret"}'), null);

console.log('\nALL PASS 1 CHECKS PASSED');
