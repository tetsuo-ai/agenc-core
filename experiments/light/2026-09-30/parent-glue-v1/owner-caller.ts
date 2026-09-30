/** Thin, one-shot trusted-parent composition; NOT a CLI or launch authority.
 * No Core import, observer install, financial I/O or foreground start at import.
 * Build this in the same selected split graph as owner-entry/companion-validator.
 */
import type { FixtureCallbacksInput } from "./fixture-callbacks.js";
import { EXECUTION_APPROVED, selection } from "./selection.mjs";
import { compatibility, verifyCompatibleSources } from "./compatibility-selection.mjs";

/** Supplied directly by reviewed owner code, never parsed from env/RPC/ACK or
 * captured wire. Parent owns bounded private-file loading, prior preflight
 * shutdown/close and acceptance of this complete tuple. No supplied digest
 * independently authorizes itself. Inputs must be ordinary structured-cloneable
 * data, not hostile JS objects/accessors/proxies or injectable functions.
 */
export interface PreacceptedOwnerInputs {
  readonly workspace: string;
  readonly callbacks: FixtureCallbacksInput;
}

let attempted = false;
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export async function runPreacceptedOwner(input: PreacceptedOwnerInputs) {
  // Mirror the existing owner selection before loading its callback module:
  // otherwise the factory could read financial files before the owner refuses.
  // These are the existing literal authorities, not new environment switches.
  if (!EXECUTION_APPROVED || selection.acceptedCompanion === null ||
      selection.acceptedBuildTuple === null || selection.acceptedCliClosure === null ||
      selection.acceptedIndependentMaterial === null || selection.acceptedObserver === null ||
      selection.acceptedLinuxAdapter === null || selection.acceptedContainment === null ||
      selection.acceptedInitialLayout === null || selection.acceptedCoreRoot === null ||
      selection.platform !== "linux" || process.platform !== "linux" ||
      selection.scope !== "one-selected-main-call-fresh-empty-resources" || selection.callCap !== 1 ||
      selection.expectedLifecycleMessages !== 0 || process.env.LUNA_TASK_CALL_CAP !== "1" ||
      selection.inspectedProductRevision !== compatibility.productRevision ||
      selection.acceptedObserver !== compatibility.observerSha256 ||
      selection.selectedBindingProfile !== compatibility.bindingProfile || !process.connected) {
    throw new Error("cli_fixture_selection_not_accepted");
  }
  if (attempted) throw new Error("cli_owner_caller_already_attempted");
  attempted = true; // Failure is retained; this process never retries the owner.
  // Actual mutation boundary: dynamic imports yield. Detach the parent's plain
  // material/config synchronously so later mutation cannot swap either consumer.
  // Clone errors propagate; do not serialize private input or replace its cause.
  const accepted = freezeTree(structuredClone(input));
  const materialSelection = selection.acceptedIndependentMaterial;
  if (accepted.workspace !== materialSelection.workspace ||
      accepted.callbacks.independentMaterialDigest !== materialSelection.semanticDigest) {
    throw new Error("cli_fixture_material_not_accepted");
  }
  // Preserve the foreground entry's source-check ordering before the factory
  // imports the canonical codec or reads the independently selected ledger.
  verifyCompatibleSources(selection.acceptedCoreRoot);
  const [{ createFixtureCallbacks }, { runOwnedForeground }] = await Promise.all([
    import("./fixture-callbacks.js"),
    import("./owner-entry.js"),
  ]);
  // Existing factory validates the codec/material, 60-source inventory, private
  // directory identities, preserved journal prefix, explicit policy and pins.
  // Parent must already establish its exact synthetic environment/directories;
  // this caller neither creates a ledger nor fills any missing configuration.
  const callbacks = createFixtureCallbacks(accepted.callbacks);
  const foreground = await runOwnedForeground({
    material: accepted.callbacks.material,
    independentMaterialDigest: accepted.callbacks.independentMaterialDigest,
    workspace: accepted.workspace,
    publishInitialBinding: callbacks.publishInitialBinding,
    fakeNativeFetch: callbacks.fakeNativeFetch,
  });
  // Scalars only; no fabricated IPC/ACK, provider success, cleanup/quiescence,
  // financial settlement or finalization claim. Parent still owns sibling CLI,
  // authenticated readiness/shutdown, all child-close checks and reconciliation.
  // Foreground failures propagate unchanged; its existing finally owns fetch
  // closure. There is no callback dispose API and none is invented here.
  return Object.freeze({ foreground, callbacks: callbacks.snapshot() });
}
