import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const bytes = readFileSync(new URL('./cold-cli-smoke.json', import.meta.url));
const data = JSON.parse(bytes);
assert.equal(data.rows.length, 18);
const normalizedRoots = [];
function inventory(text, arm) {
  const value = JSON.parse(text);
  assert.deepEqual(value.errors, []);
  for (const row of value.skills) {
    // Source: bundled-extraction-registry.ts uses a randomBytes(16) nonce
    // per process. Normalize only that exact path component of builtin roots.
    if (row.origin === 'built-in' && /^\/tmp\/agenc-bundled-skills-0\.18\.0-[0-9a-f]{32}\//.test(row.root)) {
      normalizedRoots.push({ arm, name: row.name, root: row.root });
      row.root = row.root.replace(/^(\/tmp\/agenc-bundled-skills-0\.18\.0-)[0-9a-f]{32}(\/)/, '$1<NONCE>$2');
    }
  }
  return value;
}
for (let index = 0; index < 9; index++) {
  const c = data.rows.find(r => r.arm === 'control' && r.commandIndex === index);
  const t = data.rows.find(r => r.arm === 'treatment' && r.commandIndex === index);
  for (const row of [c, t]) {
    assert.equal(row.status, [4,8].includes(index) ? 1 : 0);
    assert.equal(row.signal, null);
    assert.equal(row.errorCode, null);
  }
  assert.equal(t.stderr, c.stderr);
  if (index === 6) assert.deepEqual(inventory(t.stdout, 'treatment'), inventory(c.stdout, 'control'));
  else assert.equal(t.stdout, c.stdout);
  if (index === 4) assert.equal(c.stderr, 'agenc: project is not trusted: <TEMP>\n');
  if (index === 8) assert.match(c.stderr, /^agenc: no trajectories survived curation/);
}
console.log(JSON.stringify({ rawSha256: createHash('sha256').update(bytes).digest('hex'),
  matchedPairs: 9, normalizedRootCount: normalizedRoots.length,
  originalRunner: 'failed: incorrect all-zero exit expectation',
  baselineRefusals: ['unsupported skills --help falls through to trust preflight', 'empty trajectory input'],
  scope: 'same observed behavior; no performance or task-quality claim' }, null, 2));
