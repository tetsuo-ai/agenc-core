// Read-only exact review inventory; never executes runtime or the root runner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const rootRunner = readFileSync('/private/tmp/light-takeover/truncated-recovery-validation/run.mjs');
assert.equal(hash(rootRunner), '98badc62853440d8c0dc0a9a6b4db84c39cdf19a6bbaa7a2ba1f959f17dfc3cc');
const pins = Object.fromEntries([...rootRunner.toString().matchAll(/'((?:src|tests)\/[^']+)': '([a-f0-9]{64})'/g)].map(m => [m[1], m[2]]));
assert.equal(Object.keys(pins).length, 14);
Object.assign(pins, {
  'src/llm/wire/incomplete-tool-calls.ts': 'f7eb6c63af4a4456f9deadca4e90d180234cd4cb27562329ef32aa33941d3420',
  'tests/llm/wire/incomplete-tool-calls.test.ts': '350589c39a28a3ec66b0d91f5d1efb8a797cb26c6707c31af7f8102de0e9cd26',
  'src/llm/providers/openai/adapter.ts': '8f10b5931e53ad503a89b506f719ac875289ee18e0199842e93ef605cf6af4a3',
  'tests/llm/providers/openai/adapter.incomplete-identities.test.ts': '2a948405111f30623647ff55a93303e9720933ec60cfaa96d3173c0836404e77',
  'package.json': '2df33a01ebf17b7d285d73b0862af5be26251c53485d1fdac42e6a7ed7b9f086',
  'tsconfig.light-test-support.json': '5fbde682ff788d173c71295e1288cf5df28320a952609dd5c69f293bbb089c73',
});
for (const [path, expected] of Object.entries(pins)) {
  assert.equal(hash(readFileSync('/private/tmp/light-takeover/startup-core/runtime/' + path)), expected, path);
}
console.log(JSON.stringify({ base: '28e21d055fa052f0f27810bd65f76fd8f6b1ce15', exact_reviewed_files: Object.keys(pins).length, all_match: true }));
