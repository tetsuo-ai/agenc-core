/** Optional, bounded invocation evidence. No attachment payload or authority. */
import { types as utilTypes } from "node:util";
import type { AttachmentProducerId } from "./orchestrator.js";
import type { Attachment } from "./types.js";

export const MAX_ATTACHMENT_EVIDENCE_PRODUCERS = 64;
export const MAX_ATTACHMENT_EVIDENCE_OUTPUTS = 256;

// Exhaustive closed labels: unknown runtime values never become raw metadata.
const KINDS = Object.freeze({
  nested_memory: true, relevant_memories: true, plan_mode: true,
  plan_mode_reentry: true, plan_mode_exit: true, verify_plan_reminder: true,
  auto_mode: true, auto_mode_exit: true, date_change: true,
  critical_system_reminder: true, output_style: true, token_usage: true,
  budget_usd: true, output_token_usage: true, compaction_reminder: true,
  deferred_tools_delta: true, requested_tools: true, agent_listing_delta: true,
  mcp_instructions_delta: true, edited_text_file: true, edited_image_file: true,
  agent_mention: true, file_mention: true, image_mention: true,
  pdf_mention: true, mcp_resource: true, skill_listing: true,
  skill_relevance: true, instruction_update: true, lsp_diagnostics: true,
} satisfies Record<Attachment["kind"], true>);

export interface AttachmentProducerOutcome {
  readonly producer: AttachmentProducerId;
  /** Fulfillment is not proof that the producer's internal operations succeeded. */
  readonly status: "fulfilled" | "rejected";
  /** Null means the bounded inventory is unknown, never a truncated count. */
  readonly outputCount: number | null;
  readonly outputKinds: readonly Attachment["kind"][] | null;
}

export interface AttachmentAssemblyEvidence {
  readonly schemaVersion: 1;
  readonly collection: "ordinary" | "local_read_only";
  readonly inventory: "complete" | "unknown";
  readonly unknownReason: "output_inventory_limit" | "invalid_output_inventory" | null;
  readonly outcomes: readonly AttachmentProducerOutcome[];
}

export type AttachmentEvidenceCollector = (report: AttachmentAssemblyEvidence) => undefined;

/** Trusted registry IDs and the one settled array; never runs producers. */
export function buildAttachmentAssemblyEvidence(
  collection: AttachmentAssemblyEvidence["collection"],
  producerIds: readonly AttachmentProducerId[],
  settled: readonly PromiseSettledResult<readonly Attachment[]>[],
): AttachmentAssemblyEvidence {
  const report = (
    unknownReason: AttachmentAssemblyEvidence["unknownReason"],
    outcomes: readonly AttachmentProducerOutcome[],
  ): AttachmentAssemblyEvidence => Object.freeze({
    schemaVersion: 1, collection,
    inventory: unknownReason === null ? "complete" : "unknown",
    unknownReason, outcomes: Object.freeze(outcomes.map(outcome => Object.freeze(outcome))),
  });
  if (producerIds.length > MAX_ATTACHMENT_EVIDENCE_PRODUCERS) {
    return report("output_inventory_limit", []);
  }
  if (producerIds.length !== settled.length ||
      (collection === "local_read_only" && producerIds.length !== 0)) {
    return report("invalid_output_inventory", []);
  }
  let total = 0;
  let unknownReason: AttachmentAssemblyEvidence["unknownReason"] = null;
  // Bound lengths before allocating any per-output arrays.
  for (const result of settled) {
    if (result.status === "rejected") continue;
    if (!Array.isArray(result.value)) { unknownReason = "invalid_output_inventory"; break; }
    total += result.value.length;
    if (total > MAX_ATTACHMENT_EVIDENCE_OUTPUTS) { unknownReason = "output_inventory_limit"; break; }
  }
  const outcomes = producerIds.map((producer, index): AttachmentProducerOutcome => {
    const result = settled[index]!;
    if (result.status === "rejected") {
      return { producer, status: "rejected", outputCount: 0, outputKinds: Object.freeze([]) };
    }
    const value = result.value;
    const outputCount = Array.isArray(value) && value.length <= MAX_ATTACHMENT_EVIDENCE_OUTPUTS
      ? value.length : null;
    if (unknownReason !== null) return { producer, status: "fulfilled", outputCount, outputKinds: null };
    const kinds: Attachment["kind"][] = [];
    for (const attachment of value) {
      let kind: unknown;
      try {
        kind = attachment !== null && typeof attachment === "object"
          ? Object.getOwnPropertyDescriptor(attachment, "kind")?.value : undefined;
      } catch {
        // Unsupported metadata is unknown; never export a thrown payload.
        kind = undefined;
      }
      if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) {
        unknownReason = "invalid_output_inventory";
        return { producer, status: "fulfilled", outputCount, outputKinds: null };
      }
      kinds.push(kind as Attachment["kind"]);
    }
    return { producer, status: "fulfilled", outputCount, outputKinds: Object.freeze(kinds) };
  });
  // Do not present a partially complete kind inventory as whole-report success.
  return report(unknownReason, unknownReason === null ? outcomes : outcomes.map(outcome =>
    outcome.status === "fulfilled" ? { ...outcome, outputKinds: null } : outcome));
}

const nativePromiseThen = Promise.prototype.then;

export class AttachmentEvidenceError extends Error {
  readonly code = "attachment_evidence_collector_failed";
  constructor() { super("Attachment evidence collector failed"); this.name = "AttachmentEvidenceError"; }
}

/** No awaiting, thenable assimilation, error-string inspection or recollection. */
export function deliverAttachmentAssemblyEvidence(
  report: AttachmentAssemblyEvidence,
  collector: AttachmentEvidenceCollector,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  try {
    const returned: unknown = collector(report);
    if (utilTypes.isPromise(returned)) {
      // Trusted intrinsics/species boundary. Bypass overridden .then and never
      // invoke arbitrary thenables. Containment cannot undo an async side effect.
      Reflect.apply(nativePromiseThen, returned, [undefined, () => {}]);
      throw new AttachmentEvidenceError();
    }
    if (returned !== undefined) throw new AttachmentEvidenceError();
  } catch {
    signal.throwIfAborted(); // Original cancellation takes priority over callback errors.
    throw new AttachmentEvidenceError();
  }
  signal.throwIfAborted();
}
