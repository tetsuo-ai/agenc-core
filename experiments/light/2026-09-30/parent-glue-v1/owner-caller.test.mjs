// Ordering unit only. Synthetic platform/selection; never Linux or runtime proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

test('source refusal precedes callback imports and consumes the one-shot attempt', async () => {
  const target = new URL('./owner-caller.ts', import.meta.url).href;
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
  const modules = {
    './selection.mjs': `export const EXECUTION_APPROVED=true;export const selection=${JSON.stringify(selection)};`,
    './compatibility-selection.mjs': `export const compatibility={productRevision:'synthetic-revision',observerSha256:'synthetic-observer',bindingProfile:'synthetic-binding'};export function verifyCompatibleSources(root){if(root!=='/synthetic-core')throw Error('wrong_root');throw Error('synthetic_source_pin_refusal');}`,
  };
  const unexpectedImports = [];
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === target) {
      if (Object.hasOwn(modules, specifier)) return {
        url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true,
      };
      unexpectedImports.push(specifier);
      throw Error('unexpected_runtime_import');
    }
    return next(specifier, context);
  } });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  const cap = process.env.LUNA_TASK_CALL_CAP;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'connected', { value: true, configurable: true });
    process.env.LUNA_TASK_CALL_CAP = '1';
    const { runPreacceptedOwner } = await import(target);
    const input = { workspace: '/synthetic-workspace', callbacks: { independentMaterialDigest: digest } };
    await assert.rejects(runPreacceptedOwner(input), { message: 'synthetic_source_pin_refusal' });
    assert.deepEqual(unexpectedImports, []);
    await assert.rejects(runPreacceptedOwner(input), { message: 'cli_owner_caller_already_attempted' });
    assert.deepEqual(unexpectedImports, []);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (connected) Object.defineProperty(process, 'connected', connected);
    else delete process.connected;
    if (cap === undefined) delete process.env.LUNA_TASK_CALL_CAP;
    else process.env.LUNA_TASK_CALL_CAP = cap;
    hooks.deregister();
  }
});
