import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeniedModelsLookup, createPreflightFetchGuard } from './fetch-classifier.mjs';

const models = 'https://api.openai.com/v1/models';
test('exact official bodyless GET is denied metadata, including canonical URL arguments', async () => {
  for (const input of [models, new URL(models), new Request(models)]) {
    for (const init of [undefined, {}, { method: 'GET' }, { method: 'GET', body: null, redirect: 'manual' }]) {
      const guard = createPreflightFetchGuard();
      assert.equal(isDeniedModelsLookup(input, init), true);
      await assert.rejects(guard.fetchImpl(input, init), { message: 'preflight_metadata_lookup_denied' });
      assert.deepEqual(guard.snapshot(), { deniedMetadataRequests: 1, forbiddenFetches: 0 });
    }
  }
});
test('sampling routes and all other origins, paths, methods and bodies remain forbidden', async () => {
  const cases = [
    ['https://api.openai.com/v1/responses', { method: 'POST', body: '{}' }],
    ['https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }],
    ['https://models.dev/api.json', undefined],
    ['https://api.openai.com/v1/models?x=1', undefined],
    ['https://api.openai.com/v1/models#fragment', undefined],
    ['https://api.openai.com/v1/models/', undefined],
    ['https://api.openai.com:444/v1/models', undefined],
    ['http://api.openai.com/v1/models', undefined],
    ['https://api.openai.com.example/v1/models', undefined],
    [models, { method: 'POST' }], [models, { method: 'HEAD' }], [models, { method: null }],
    [models, { method: 'get' }], [models, { method: 'GET', body: '' }],
    [models, { method: 'GET', body: '{}' }],
    [new Request(models, { method: 'POST', body: '{}' }), { method: 'GET', body: null }],
  ];
  for (const [input, init] of cases) {
    const guard = createPreflightFetchGuard();
    assert.equal(isDeniedModelsLookup(input, init), false);
    await assert.rejects(guard.fetchImpl(input, init), { message: 'preflight_network_forbidden' });
    assert.deepEqual(guard.snapshot(), { deniedMetadataRequests: 0, forbiddenFetches: 1 });
  }
});
test('malformed inputs are refused without emitting caller content', async () => {
  const guard = createPreflightFetchGuard();
  for (const input of [undefined, null, {}, { url: models }, 0]) {
    await assert.rejects(guard.fetchImpl(input), { message: 'preflight_network_forbidden' });
  }
  assert.deepEqual(guard.snapshot(), { deniedMetadataRequests: 0, forbiddenFetches: 5 });
});
test('counters remain distinct, snapshots are detached and immutable, every call rejects', async () => {
  const guard = createPreflightFetchGuard(), before = guard.snapshot();
  await assert.rejects(guard.fetchImpl(models));
  await assert.rejects(guard.fetchImpl('https://api.openai.com/v1/responses', { method: 'POST' }));
  assert.deepEqual(before, { deniedMetadataRequests: 0, forbiddenFetches: 0 });
  assert.ok(Object.isFrozen(before)); assert.ok(Object.isFrozen(guard));
  assert.deepEqual(guard.snapshot(), { deniedMetadataRequests: 1, forbiddenFetches: 1 });
});
test('classifier has no ambient fetch delegation', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected_native_fetch'); };
  try {
    const guard = createPreflightFetchGuard();
    await assert.rejects(guard.fetchImpl(models));
    await assert.rejects(guard.fetchImpl('https://api.openai.com/v1/responses'));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test('frozen predecessor is unchanged; successor routes only transport classification and scalar diagnostics', () => {
  const old = fs.readFileSync(new URL('../current-cli-observer-v1/preflight.ts', import.meta.url));
  assert.equal(createHash('sha256').update(old).digest('hex'), 'fad448e9bff8199ab5881669558a8fc6651f5d96ed69e929c1506059bd69df4f');
  const current = fs.readFileSync(new URL('./preflight.ts', import.meta.url), 'utf8');
  assert.match(current, /fetchImpl:fetchGuard.fetchImpl/);
  assert.match(current, /fetchGuard.snapshot\(\).forbiddenFetches===0&&state.validations===0/);
  assert.match(current, /preflightDiagnostics/);
  assert.match(current, /preflight_sampling_forbidden/);
});
