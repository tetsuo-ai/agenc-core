// Actual successor entry, synthetic module dependencies. No Core/observer/native
// client launch, financial journal or network; this is wrapper-ordering evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { isDeniedModelsLookup } from '../linux-preflight-v2/fetch-classifier.mjs';

test('denied classification is exact; near matches are not silently exempt', () => {
  const url = 'https://api.openai.com/v1/models';
  assert.equal(isDeniedModelsLookup(url), true);
  assert.equal(isDeniedModelsLookup(new URL(url)), true);
  assert.equal(isDeniedModelsLookup(new Request(url)), true);
  assert.equal(isDeniedModelsLookup(url, { method: 'GET', body: null }), true);
  for (const [input, init] of [
    [url + '?x=1'], [url + '/'], [url + '#x'], ['http://api.openai.com/v1/models'],
    ['https://example.invalid/v1/models'], ['https://user@api.openai.com/v1/models'],
    [url, { method: 'POST' }], [url, { method: 'get' }],
    [url, { method: 'GET', body: '' }],
    [new Request(url, { method: 'POST', body: 'x' }), { method: 'GET' }],
  ]) assert.equal(isDeniedModelsLookup(input, init), false);
});

test('denied health lookup cannot poison selected dispatch; POST remains joined and unknown routes refuse', async () => {
  const target = new URL('./owner-entry.ts', import.meta.url).href;
  const digest = 'a'.repeat(64);
  const selection = {
    acceptedCompanion: 'synthetic', acceptedBuildTuple: {}, acceptedCliClosure: {},
    acceptedIndependentMaterial: { workspace: '/synthetic-workspace', semanticDigest: digest },
    acceptedObserver: 'synthetic-observer', acceptedLinuxAdapter: {}, acceptedContainment: {},
    acceptedInitialLayout: {}, acceptedCoreRoot: '/synthetic-core', platform: 'linux',
    scope: 'one-selected-main-call-fresh-empty-resources', callCap: 1,
    expectedLifecycleMessages: 0, inspectedProductRevision: 'synthetic-revision',
    selectedBindingProfile: 'synthetic-binding',
  };
  const state = { selected: false, poisoned: false, dispatchChecks: 0, observed: 0,
    fixtureCalls: 0, closes: 0, sourceChecks: 0, observerPins: 0, foregroundCalls: 0 };
  const key = '__light_linux_owner_v2_ordering_fixture__';
  assert.equal(Object.hasOwn(globalThis, key), false);
  const responseInput = new Request('https://api.openai.com/v1/responses', {
    method: 'POST', body: '{"synthetic":true}',
  });
  const responseInit = { redirect: 'manual' };
  const modules = {
    '../current-cli-observer-v1/selection.mjs': `export const EXECUTION_APPROVED=true;export const selection=${JSON.stringify(selection)};`,
    '../current-cli-observer-v1/compatibility-selection.mjs': `export const compatibility={productRevision:'synthetic-revision',observerSha256:'synthetic-observer',bindingProfile:'synthetic-binding'};export const observerSourcePath='/synthetic-observer';export function verifyCompatibleSources(root){globalThis.${key}.verify(root);}`,
    '../current-cli-observer-v1/empty-resources.mjs': `export function pinnedBytes(file,hash){globalThis.${key}.pin(file,hash);}`,
    '../current-cli-observer-v1/companion-validator.js': `export function createCompanionValidator(input){return globalThis.${key}.validator(input);}`,
    '../luna-observer-v6/direct.mjs': `const fixture=globalThis.fetch;globalThis.fetch=(input,init)=>globalThis.${key}.observe(fixture,input,init);`,
    'agenc-selected/app-server/daemon-cli.js': `export async function runAgenCDaemonForeground(host,stdio,options){return globalThis.${key}.foreground(host,options);}`,
    'agenc-selected/app-server/daemon-control.js': `export function createNodeDaemonCliHost(){return {syntheticHost:true};}`,
  };
  globalThis[key] = {
    verify(root) { assert.equal(root, '/synthetic-core'); state.sourceChecks++; },
    pin(file, hash) { assert.equal(file, '/synthetic-observer'); assert.equal(hash, 'synthetic-observer'); state.observerPins++; },
    validator(input) {
      assert.equal(input.independentMaterialDigest, digest);
      return {
        assertDispatched() {
          state.dispatchChecks++;
          if (!state.selected) { state.poisoned = true; throw Error('dispatch_before_selection'); }
          if (state.poisoned) throw Error('sticky_invalid');
        },
        validatePreparedSampling() { assert.equal(state.poisoned, false); state.selected = true; },
        close() { state.closes++; },
        snapshot() { return { ...state }; },
      };
    },
    async observe(fixture, input, init) {
      state.observed++;
      // Synthetic observer route boundary; unknown routes never reach even the
      // fake fixture. Existing real observer/finance tests are not replaced.
      if (!(input instanceof Request) || input.url !== 'https://api.openai.com/v1/responses' || input.method !== 'POST')
        throw Error('observer_route_refused');
      return fixture(input, init);
    },
    async foreground(host, options) {
      state.foregroundCalls++;
      assert.equal(host.syntheticHost, true);
      assert.equal(options.enterDaemonHome, true);
      for (const input of ['https://api.openai.com/v1/models', new URL('https://api.openai.com/v1/models'), new Request('https://api.openai.com/v1/models')])
        await assert.rejects(globalThis.fetch(input), { message: 'cli_metadata_lookup_denied' });
      assert.equal(state.dispatchChecks, 0);
      assert.equal(state.poisoned, false);
      assert.equal(state.observed, 0);
      assert.equal(state.fixtureCalls, 0);
      options.validatePreparedSampling();
      const response = await globalThis.fetch(responseInput, responseInit);
      assert.equal(await response.text(), 'synthetic response');
      for (const [input, init] of [
        ['https://api.openai.com/v1/models?x=1'],
        ['https://api.openai.com/v1/models', { method: 'POST' }],
        ['https://example.invalid/v1/responses'],
      ]) await assert.rejects(globalThis.fetch(input, init), { message: 'observer_route_refused' });
      assert.equal(state.fixtureCalls, 1);
      assert.equal(state.dispatchChecks, 4);
      assert.equal(state.observed, 4);
      return 0;
    },
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === target && Object.hasOwn(modules, specifier))
      return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
    return next(specifier, context);
  } });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  const cap = process.env.LUNA_TASK_CALL_CAP, originalFetch = globalThis.fetch;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'connected', { value: true, configurable: true });
    process.env.LUNA_TASK_CALL_CAP = '1';
    const { runOwnedForeground } = await import(target);
    const result = await runOwnedForeground({ material: {}, independentMaterialDigest: digest,
      workspace: '/synthetic-workspace', publishInitialBinding() {},
      fakeNativeFetch: async (input, init) => {
        state.fixtureCalls++;
        assert.equal(input, responseInput); assert.equal(init, responseInit);
        return new Response('synthetic response');
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.evidence.poisoned, false);
    assert.equal(state.sourceChecks, 1); assert.equal(state.observerPins, 1);
    assert.equal(state.foregroundCalls, 1); assert.equal(state.closes, 2);
    await assert.rejects(globalThis.fetch('https://api.openai.com/v1/models'), { message: 'cli_owner_closed' });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', platform);
    if (connected) Object.defineProperty(process, 'connected', connected); else delete process.connected;
    if (cap === undefined) delete process.env.LUNA_TASK_CALL_CAP; else process.env.LUNA_TASK_CALL_CAP = cap;
    hooks.deregister(); delete globalThis[key];
  }
});
