/** Draft companion entry. No top-level Core import, observer install or launch.
 * `agenc-selected` must be a root-built alias to ONE accepted Core graph,
 * including the same current-session ALS module as foreground/session/provider.
 */
import type { CompanionValidatorInput } from "../current-cli-observer-v1/companion-validator.js";
import { EXECUTION_APPROVED, selection } from "../current-cli-observer-v1/selection.mjs";
import { compatibility, observerSourcePath, verifyCompatibleSources } from "../current-cli-observer-v1/compatibility-selection.mjs";
import { pinnedBytes } from "../current-cli-observer-v1/empty-resources.mjs";

import { isDeniedModelsLookup } from "../linux-preflight-v2/fetch-classifier.mjs";

export interface OwnedForegroundInput extends CompanionValidatorInput {
  /** Root-owned hermetic response fixture, NEVER an ambient native fetch.
   * This function is trusted code; OS containment remains a separate gate.
   */
  readonly fakeNativeFetch: typeof globalThis.fetch;
}

export async function runOwnedForeground(input: OwnedForegroundInput) {
  // This draft cannot be activated with an environment/config/RPC flag.
  if (!EXECUTION_APPROVED || selection.acceptedCompanion === null ||
      selection.acceptedBuildTuple === null || selection.acceptedCliClosure === null ||
      selection.acceptedIndependentMaterial === null || selection.acceptedObserver === null ||
      selection.acceptedLinuxAdapter === null || selection.acceptedContainment === null ||
      selection.acceptedInitialLayout === null || selection.acceptedCoreRoot === null ||
      selection.platform !== "linux" || process.platform !== "linux" ||
      selection.scope !== "one-selected-main-call-fresh-empty-resources" || selection.callCap !== 1 ||
      selection.expectedLifecycleMessages !== 0 || process.env.LUNA_TASK_CALL_CAP !== "1" ||
      selection.inspectedProductRevision !== compatibility.productRevision ||
      typeof input.fakeNativeFetch !== "function" || !process.connected) {
    throw new Error("cli_fixture_selection_not_accepted");
  }
  // Root will replace the null literal selection with a reviewed immutable
  // deployment. Do not infer any of these authorities from input or environment.
  const accepted = selection.acceptedIndependentMaterial;
  if (input.independentMaterialDigest !== accepted.semanticDigest || input.workspace !== accepted.workspace ||
      selection.acceptedObserver !== compatibility.observerSha256 ||
      selection.selectedBindingProfile !== compatibility.bindingProfile) throw new Error("cli_fixture_material_not_accepted");
  verifyCompatibleSources(selection.acceptedCoreRoot);
  // Capture trusted scalar/callback fields before the first await, but do NOT
  // clone unvalidated material (structuredClone could invoke accessors). After
  // its leaf imports resolve, the canonical helper first checks the descriptor-
  // only digest against the PREACCEPTED hash, then clones synchronously. Any
  // mutation in the import gap still must match that independently sealed hash.
  const captured = { material: input.material, independentMaterialDigest: input.independentMaterialDigest,
    workspace: input.workspace, publishInitialBinding: input.publishInitialBinding };
  const fakeNativeFetch = input.fakeNativeFetch;
  const { createCompanionValidator } = await import("../current-cli-observer-v1/companion-validator.js");
  const joined = createCompanionValidator(captured);
  // Parent establishes a private explicit environment before import. No custom
  // runner/bootstrap, build-identity override, process identity override or
  // admission/kernel injection is permitted here.
  try {
    // Install the unchanged observer BEFORE Core constructs its provider. The
    // outer wrapper joins real Core dispatch before any financial admission.
    // Observer metadata may be published synchronously by selected validation;
    // its root/run/channel environment must already be selected by the parent.
    pinnedBytes(observerSourcePath, compatibility.observerSha256);
    globalThis.fetch = fakeNativeFetch;
    await import("../luna-observer-v6/direct.mjs");
    const observedFetch = globalThis.fetch;
    if (observedFetch === fakeNativeFetch) throw new Error("cli_observer_install_missing");
    globalThis.fetch = async (request, init) => {
      // Deny only the canonical bodyless models GET. Never reach observer or
      // fake/native transport, and do not poison selected-turn dispatch state.
      // Every other route retains the original dispatch-before-observer guard.
      if (isDeniedModelsLookup(request, init)) throw new Error("cli_metadata_lookup_denied");
      joined.assertDispatched();
      return observedFetch(request, init);
    };
    const [{ runAgenCDaemonForeground }, { createNodeDaemonCliHost }] = await Promise.all([
      import("agenc-selected/app-server/daemon-cli.js"),
      import("agenc-selected/app-server/daemon-control.js"),
    ]);
    const exitCode = await runAgenCDaemonForeground(createNodeDaemonCliHost(), {
      stdout: process.stdout, stderr: process.stderr,
    }, { enterDaemonHome: true, validatePreparedSampling: joined.validatePreparedSampling });
    // Deliberately no lifecycle-probe-v5 sentinel. Configure the existing
    // parent's expectedMessages=0; receipt ACKs use the separate strict v6
    // dispatcher. Neither this return nor an ACK replaces authenticated readiness.
    joined.close();
    return Object.freeze({ exitCode, evidence: joined.snapshot() });
  } finally {
    joined.close();
    // Dedicated owned process only. Never restore an ambient network-capable
    // fetch after a failed import/shutdown; pending bodies retain their observer.
    globalThis.fetch = async () => { throw new Error("cli_owner_closed"); };
  }
}
