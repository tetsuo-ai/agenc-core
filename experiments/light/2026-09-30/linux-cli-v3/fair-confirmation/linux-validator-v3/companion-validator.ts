/** Trusted, single-main-call diagnostic join; NOT a generic runner or authority.
 * All agenc-selected imports MUST resolve inside the foreground's one Core graph.
 * No producer rerun, ambient Session fallback, provider wrapper or new ID.
 */
import { types as utilTypes } from "node:util";
import { peekScopedRuntimeSession } from "agenc-selected/session/current-session.js";
import { preparedSemanticDigest as digest, type PreparedSamplingEvidence,
  type PreparedSamplingValidator } from "agenc-selected/session/prepared-sampling-evidence.js";
import type { Session } from "agenc-selected/session/session.js";
import type { AdmissionJournalEvent } from "agenc-selected/budget/admission-types.js";

type Details = NonNullable<PreparedSamplingEvidence["details"]>;
export interface IndependentMaterial {
  readonly version: 1;
  readonly task: string;
  readonly instructions: string;
  readonly tools: readonly unknown[];
  readonly assembly: Details["assembly"];
  readonly semantic: Readonly<Pick<Details, "instructionsDigest" | "messages" | "tools" | "fields">>;
  readonly wireTemplate: Readonly<Record<string, unknown>>;
  readonly generatedSlots: readonly string[];
  readonly equivalence: "fresh-empty-resource-only";
  readonly selectedOrWireObserved: false;
}
export interface SelectedBinding {
  readonly conversationId: string;
  readonly rootTurnId: string;
  readonly managedRequestId: string;
  readonly admissionRunId: string;
  readonly independentMaterialDigest: string;
  /** Independent wire template plus source-owned conversation identity ONLY. */
  readonly wire: Readonly<Record<string, unknown>>;
}
export interface CompanionValidatorInput {
  readonly material: IndependentMaterial;
  readonly independentMaterialDigest: string;
  readonly workspace: string;
  /** Trusted synchronous metadata/contract publisher. Expected values come
   * from the preflight template, never a request/report. A throw or non-undefined
   * return refuses the selected call. This does not create parent authority.
   * Its implementation and durable publication are still a launcher dependency.
   */
  readonly publishInitialBinding: (binding: SelectedBinding) => undefined;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_.-]{1,240}$/;
const HEX = /^[a-f0-9]{64}$/;
// Canonical repository listJournal accepts at most 1,000 rows. Ask for one
// sentinel row so a truncated inventory is refused, not treated as complete.
const MAX_JOURNAL = 999;
const SCOPE = "one-selected-main-call-fresh-empty-resources";
const CALL_CAP = 1;
const nativeThen = Promise.prototype.then;
const PRODUCERS = ["plan_mode", "verify_plan_reminder", "auto_mode", "swarm_mode",
  "deferred_tools_delta", "requested_tools", "agent_listing_delta", "mcp_instructions_delta",
  "date_change", "instruction_update", "critical_reminder", "output_style", "relevant_memories",
  "changed_files", "lsp_diagnostics", "agent_mentions", "mcp_resources", "file_mentions", "skill_listing"];
function need(value: unknown): asserts value {
  if (!value) throw new Error("cli_prepared_join_refused");
}
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function createCompanionValidator(input: CompanionValidatorInput) {
  // Validate bounded plain data with the canonical descriptor-only codec BEFORE
  // copying. Do not retain mutable caller-owned material across any await.
  const sealedDigest = input.independentMaterialDigest;
  const workspace = input.workspace;
  const publish = input.publishInitialBinding;
  const suppliedMaterial = input.material;
  need(HEX.test(sealedDigest) && typeof workspace === "string" && workspace.startsWith("/") &&
    typeof publish === "function" && digest(suppliedMaterial) === sealedDigest);
  const material = freezeTree(structuredClone(suppliedMaterial));
  need(material.version === 1 && material.selectedOrWireObserved === false &&
    material.equivalence === "fresh-empty-resource-only" &&
    digest(material.generatedSlots) === digest(["conversationId/prompt_cache_key", "rootTurnId", "managedRequestId", "user-initial-threadId"]));
  need(typeof material.task === "string" && material.task.length > 0 &&
    material.semantic.instructionsDigest === digest(material.instructions) &&
    digest(material.semantic.messages) === digest([{ role: "user", contentForm: "text", digest: digest({ role: "user", content: material.task }) }]));
  const ordinary = material.assembly;
  need(ordinary.schemaVersion === 1 && ordinary.inventory === "complete" && ordinary.collection === "ordinary" &&
    ordinary.unknownReason === null && digest(ordinary.outcomes) === digest(PRODUCERS.map(producer =>
      ({ producer, status: "fulfilled", outputCount: 0, outputKinds: [] }))));
  need(!Object.hasOwn(material.wireTemplate, "prompt_cache_key"));

  // Fixed scalar-only rejection evidence; never serializes material/report values.
  let stage = "idle";
  let rejectionStage: string | null = null;
  let activeFacts: Readonly<Record<string, boolean | null>> | null = null;
  let rootFacts: Readonly<Record<string, boolean | null>> | null = null;
  let reportFacts: Readonly<Record<string, boolean>> | null = null;
  let countFacts: Readonly<Record<string, number | boolean | null>> | null = null;
  let matchFacts: Readonly<Record<string, boolean | number | null>> | null = null;
  let journalFacts: Readonly<Record<string, number | boolean>> | null = null;
  const boundedCount = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
  let failed = false, closed = false, selected = false, fetchEntered = false;
  let actual: Session | null = null;
  let binding: SelectedBinding | null = null;
  let dispatch: Readonly<{ reservationId: string; stepId: string; sequence: number }> | null = null;
  function journal(session: Session): readonly AdmissionJournalEvent[] {
    const client = session.services.executionAdmission;
    need(client !== undefined && typeof client.replayJournal === "function");
    const rows = client.replayJournal({ limit: MAX_JOURNAL + 1 });
    journalFacts = Object.freeze({ rowCount: rows.length, withinLimit: rows.length <= MAX_JOURNAL,
      modelTurnCount: rows.filter(row => row.kind === "model_turn").length });
    need(rows.length <= MAX_JOURNAL);
    // A full bounded run inventory, not a most-recent-row heuristic.
    let prior = 0;
    for (const row of rows) {
      need(Number.isSafeInteger(row.sequence) && row.sequence > prior && row.runId === client.scope.runId);
      prior = row.sequence;
    }
    return rows;
  }
  function active(): Session {
    stage = "active";
    activeFacts = Object.freeze({ priorFailed: failed, priorClosed: closed, sessionPresent: null,
      workspaceMatches: null, admissionRequired: null, admissionPresent: null,
      lightMode: null, nonInteractive: null, defaultPermission: null, sameSession: null });
    need(!failed && !closed);
    const session = peekScopedRuntimeSession();
    activeFacts = Object.freeze({ ...activeFacts, sessionPresent: session !== null,
      workspaceMatches: session === null ? null : session.sessionConfiguration.cwd === workspace,
      admissionRequired: session === null ? null : session.services.admissionRequired === true,
      admissionPresent: session === null ? null : session.services.executionAdmission !== undefined,
      lightMode: session === null ? null : session.services.runtimeOptions?.lightMode === true,
      nonInteractive: session === null ? null : session.services.runtimeOptions?.nonInteractive === true,
      sameSession: actual === null || actual === session });
    need(session !== null && session.sessionConfiguration.cwd === workspace &&
      session.services.admissionRequired === true && session.services.executionAdmission !== undefined &&
      session.services.runtimeOptions?.lightMode === true && session.services.runtimeOptions?.nonInteractive === true &&
      ((activeFacts = Object.freeze({ ...activeFacts,
        defaultPermission: session.permissionModeRegistry.current().mode === "default" })).defaultPermission === true));
    need(actual === null || actual === session);
    return session;
  }
  const validatePreparedSampling: PreparedSamplingValidator = report => {
    try {
      stage = "selected_guard";
      need(!selected);
      const session = active();
      stage = "root";
      const root = session.currentRootHumanTurn();
      const client = session.services.executionAdmission!;
      rootFacts = Object.freeze({ present: root !== null,
        turnIdValid: root === null ? null : ID.test(root.turnId),
        taskMatches: root === null ? null : root.text === material.task,
        conversationIdValid: ID.test(session.conversationId), admissionRunIdValid: ID.test(client.scope.runId),
        admissionSessionMatches: client.scope.sessionId === session.conversationId });
      need(root !== null && ID.test(root.turnId) && root.text === material.task &&
        ID.test(session.conversationId) && ID.test(client.scope.runId) &&
        client.scope.sessionId === session.conversationId);
      stage = "report";
      reportFacts = Object.freeze({ schemaVersionMatches: report.schemaVersion === 1,
        codecMatches: report.digestCodec === "prepared-semantic-v1", inventoryComplete: report.inventory === "complete",
        unknownReasonAbsent: report.unknownReason === null, detailsPresent: report.details !== null,
        managedRequestIdValid: typeof report.managedRequestId === "string" && UUID.test(report.managedRequestId) });
      need(report.schemaVersion === 1 && report.digestCodec === "prepared-semantic-v1" &&
        report.inventory === "complete" && report.unknownReason === null && report.details !== null &&
        typeof report.managedRequestId === "string" && UUID.test(report.managedRequestId));
      const details = report.details;
      stage = "report_root";
      need(digest(details.root) === digest({ present: true, matchesActiveTurn: true,
        turnDigest: digest(root.turnId), textDigest: digest(material.task) }));
      stage = "counts";
      countFacts = Object.freeze({ sourceMessages: boundedCount(details.counts.sourceMessages),
        preAttachmentMessages: boundedCount(details.counts.preAttachmentMessages),
        retainedBlocks: boundedCount(details.counts.retainedBlocks), retainedMessages: boundedCount(details.counts.retainedMessages),
        rawAttachmentOutputs: boundedCount(details.counts.rawAttachmentOutputs) });
      need(digest(details.counts) === digest({ sourceMessages: 1, preAttachmentMessages: 1,
        retainedBlocks: 0, retainedMessages: 0, rawAttachmentOutputs: 0 }));
      stage = "matching";
      matchFacts = Object.freeze({ assembly: digest(details.assembly) === digest(material.assembly),
        instructions: details.instructionsDigest === material.semantic.instructionsDigest,
        messages: digest(details.messages) === digest(material.semantic.messages),
        tools: digest(details.tools) === digest(material.semantic.tools),
        fields: digest(details.fields) === digest(material.semantic.fields),
        actualMessageCount: boundedCount(details.messages.length), expectedMessageCount: boundedCount(material.semantic.messages.length),
        actualToolCount: boundedCount(details.tools.length), expectedToolCount: boundedCount(material.semantic.tools.length),
        actualFieldCount: boundedCount(details.fields.length), expectedFieldCount: boundedCount(material.semantic.fields.length) });
      need(digest(details.assembly) === digest(material.assembly) &&
        details.instructionsDigest === material.semantic.instructionsDigest &&
        digest(details.messages) === digest(material.semantic.messages) &&
        digest(details.tools) === digest(material.semantic.tools) &&
        digest(details.fields) === digest(material.semantic.fields));
      // Earlier auxiliary work is not relabeled selected/free. This narrow
      // first-call diagnostic refuses any prior model admission attempt.
      stage = "journal";
      need(!journal(session).some(row => row.kind === "model_turn"));
      actual = session;
      binding = freezeTree({ conversationId: session.conversationId, rootTurnId: root.turnId,
        managedRequestId: report.managedRequestId, admissionRunId: client.scope.runId,
        independentMaterialDigest: sealedDigest,
        wire: { ...material.wireTemplate, prompt_cache_key: session.conversationId } });
      selected = true; // A callback failure cannot be retried or overwrite its metadata.
      stage = "publish";
      const returned: unknown = publish(binding);
      if (utilTypes.isPromise(returned)) {
        // Trusted callback/intrinsics boundary; never await or assimilate thenables.
        Reflect.apply(nativeThen, returned, [undefined, () => {}]);
        throw new Error("cli_prepared_join_refused");
      }
      need(returned === undefined);
      stage = "validated";
      return undefined;
    } catch { rejectionStage ??= stage; failed = true; throw new Error("cli_prepared_join_refused"); }
  };
  function assertDispatched(): void {
    try {
      const session = active();
      stage = "dispatch_selected";
      need(selected && binding !== null && !fetchEntered);
      const root = session.currentRootHumanTurn();
      need(root !== null && root.turnId === binding.rootTurnId && root.text === material.task &&
        session.conversationId === binding.conversationId &&
        session.services.executionAdmission!.scope.runId === binding.admissionRunId);
      stage = "dispatch_journal";
      const rows = journal(session);
      const calls = rows.filter(row => row.kind === "model_turn" && row.event === "dispatched");
      need(calls.length === 1);
      const row = calls[0]!;
      need(row.details?.managedRequestId === binding.managedRequestId && row.details.boundary === "provider_wire" && row.model === "gpt-6-luna" &&
        row.provider === "openai" && typeof row.reservationId === "string" && row.reservationId.length > 0 &&
        row.reservationId.length <= 240 && typeof row.stepId === "string" && row.stepId.length > 0 && row.stepId.length <= 1024);
      const allowed = rows.filter(event => event.event === "allowed" && event.reservationId === row.reservationId);
      need(allowed.length === 1 && allowed[0]!.kind === "model_turn" && allowed[0]!.stepId === row.stepId && allowed[0]!.sequence < row.sequence);
      need(!rows.some(event => event.sequence > row.sequence && event.reservationId === row.reservationId));
      dispatch = Object.freeze({ reservationId: row.reservationId, stepId: row.stepId, sequence: row.sequence });
      fetchEntered = true;
      stage = "dispatched";
    } catch { rejectionStage ??= stage; failed = true; throw new Error("cli_dispatch_join_refused"); }
  }
  return Object.freeze({
    validatePreparedSampling,
    assertDispatched,
    close(): void { closed = true; },
    snapshot() {
      // Scalars only. No prompt, credentials, arguments, settlement or score claim.
      return Object.freeze({ scope: SCOPE, callCap: CALL_CAP, selected, fetchEntered, failed, closed,
        conversationId: binding?.conversationId ?? null, rootTurnId: binding?.rootTurnId ?? null,
        managedRequestId: binding?.managedRequestId ?? null, admissionRunId: binding?.admissionRunId ?? null,
        independentMaterialDigest: sealedDigest, dispatch,
        diagnostic: Object.freeze({ stage, rejectionStage, active: activeFacts, root: rootFacts,
          report: reportFacts, counts: countFacts, matching: matchFacts, journal: journalFacts }) });
    },
  });
}

