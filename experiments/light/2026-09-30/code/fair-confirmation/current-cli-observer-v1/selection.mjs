import { compatibility } from './compatibility-selection.mjs';

// Source selection is explicit; every deployment authority remains absent.
// No environment/RPC/config flag can activate this draft.
export const EXECUTION_APPROVED = false;
export const selection = Object.freeze({
  inspectedProductRevision: compatibility.productRevision,
  platform: 'linux',
  scope: 'one-selected-main-call-fresh-empty-resources',
  callCap: 1,
  // No lifecycle sentinel is emitted by this entry. Parent must explicitly use
  // expectedMessages: 0; canonical sidecar/OS/auth remains the readiness proof.
  expectedLifecycleMessages: 0,
  /** @type {string | null} */
  acceptedCoreRoot: null,
  acceptedBuildTuple: null,
  acceptedCompanion: null,
  acceptedCliClosure: null,
  acceptedLinuxAdapter: null,
  acceptedContainment: null,
  // Must contain the independent preflight's material semanticDigest and
  // declared workspace, accepted before the measured daemon is started.
  /** @type {Readonly<{semanticDigest: string, workspace: string}> | null} */
  acceptedIndependentMaterial: null,
  selectedBindingProfile: compatibility.bindingProfile,
  acceptedInitialLayout: null,
  /** @type {string | null} */
  acceptedObserver: null,
  referenceObserverV6: compatibility.observerSha256,
});
