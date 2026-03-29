import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_COMPLETION_COMPATIBILITY_CLASSES } from "../llm/chat-executor-contract-flow.js";
import { DELEGATION_OUTPUT_VALIDATION_CODES } from "../utils/delegation-validation.js";
import { WORKFLOW_COMPLETION_STATES } from "./completion-state.js";
import {
  mapDelegationValidationCodeToPlannerVerifierIssue,
  PHASE0_MUST_PASS_INCIDENT_FIXTURES,
  PHASE0_OPEN_FAILURE_CLASSES,
  PLANNER_CLEANUP_COMPATIBILITY_OVERRIDE_FLAGS,
  PLANNER_DELEGATION_VERIFIER_CLEANUP_MODE,
  PLANNER_VERIFIER_LITERAL_ISSUE_CODES,
} from "./cleanup-mode.js";
import {
  EXECUTION_ENVELOPE_COMPATIBILITY_SOURCES,
} from "./execution-envelope.js";
import {
  EXECUTION_KERNEL_NODE_OUTCOME_STATUSES,
  EXECUTION_KERNEL_STEP_STATES,
} from "./execution-kernel-types.js";
import { RUNTIME_VERIFICATION_CHANNEL_NAMES } from "./verification-results.js";

const VERIFIER_SOURCE_PATH = fileURLToPath(
  new URL("../llm/chat-executor-verifier.ts", import.meta.url),
);
const CONTRACT_FLOW_SOURCE_PATH = fileURLToPath(
  new URL("../llm/chat-executor-contract-flow.ts", import.meta.url),
);
const DELEGATION_ADMISSION_SOURCE_PATH = fileURLToPath(
  new URL("../gateway/delegation-admission.ts", import.meta.url),
);
const INCIDENT_FIXTURE_DIR = fileURLToPath(
  new URL("../../benchmarks/v1/incidents", import.meta.url),
);

describe("workflow cleanup mode", () => {
  it("declares the phase 0 planner/delegation/verifier cleanup freeze", () => {
    expect(PLANNER_DELEGATION_VERIFIER_CLEANUP_MODE).toMatchObject({
      id: "phase0_freeze_semantics",
      active: true,
      scope: "planner_delegation_verifier",
    });
  });

  it("freezes the current completion and execution status families", () => {
    expect(WORKFLOW_COMPLETION_STATES).toEqual([
      "completed",
      "partial",
      "blocked",
      "needs_verification",
    ]);
    expect(EXECUTION_KERNEL_STEP_STATES).toEqual([
      "queued",
      "ready",
      "running",
      "blocked_on_approval",
      "blocked_on_dependency",
      "retry_pending",
      "completed",
      "failed",
      "resumed",
      "compensated",
    ]);
    expect(EXECUTION_KERNEL_NODE_OUTCOME_STATUSES).toEqual([
      "completed",
      "failed",
      "halted",
    ]);
  });

  it("freezes the current validation and compatibility registries", () => {
    expect(DELEGATION_OUTPUT_VALIDATION_CODES).toEqual([
      "empty_output",
      "empty_structured_payload",
      "expected_json_object",
      "acceptance_count_mismatch",
      "acceptance_evidence_missing",
      "acceptance_probe_failed",
      "missing_behavior_harness",
      "forbidden_phase_action",
      "blocked_phase_output",
      "contradictory_completion_claim",
      "missing_successful_tool_evidence",
      "low_signal_browser_evidence",
      "missing_workspace_inspection_evidence",
      "missing_file_mutation_evidence",
      "missing_required_source_evidence",
      "missing_file_artifact_evidence",
    ]);
    expect(RUNTIME_VERIFICATION_CHANNEL_NAMES).toEqual([
      "artifact_state",
      "placeholder_stub",
      "executable_outcome",
      "rubric",
    ]);
    expect(LEGACY_COMPLETION_COMPATIBILITY_CLASSES).toEqual([
      "docs",
      "research",
      "plan_only",
    ]);
    expect(EXECUTION_ENVELOPE_COMPATIBILITY_SOURCES).toEqual([
      "legacy_context_requirements",
      "legacy_persisted_checkpoint",
    ]);
  });

  it("requires every delegated validation code to map into a frozen planner verifier issue family", () => {
    expect(
      DELEGATION_OUTPUT_VALIDATION_CODES.map((code) =>
        mapDelegationValidationCodeToPlannerVerifierIssue(code)
      ),
    ).toEqual([
      "empty_child_output",
      "contract_violation_expected_json_output",
      "contract_violation_expected_json_output",
      "contract_violation_acceptance_criteria_count",
      "acceptance_criteria_not_evidenced",
      "contract_violation_acceptance_probe_failed",
      "contract_violation_missing_behavior_harness",
      "contract_violation_forbidden_phase_action",
      "contract_violation_blocked_phase_output",
      "child_claimed_completion_with_unresolved_work",
      "missing_successful_tool_evidence",
      "low_signal_browser_evidence",
      "missing_workspace_inspection_evidence",
      "contract_violation_missing_file_mutation_evidence",
      "missing_required_source_evidence",
      "missing_or_unauthorized_target_artifact_evidence",
    ]);
  });

  it("fails if chat-executor-verifier grows new literal issue codes outside the cleanup registry", async () => {
    const source = await readFile(VERIFIER_SOURCE_PATH, "utf8");
    const pushedIssues = [...source.matchAll(/issues\.push\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );
    const unexpected = [...new Set(pushedIssues)].filter(
      (issue) =>
        !PLANNER_VERIFIER_LITERAL_ISSUE_CODES.includes(
          issue as (typeof PLANNER_VERIFIER_LITERAL_ISSUE_CODES)[number],
        ),
    );

    expect(unexpected).toEqual([]);
  });

  it("fails if delegation admission adds new compatibility override flags without updating cleanup mode", async () => {
    const source = await readFile(DELEGATION_ADMISSION_SOURCE_PATH, "utf8");
    const overrideFlags = [...source.matchAll(/\b([A-Za-z]+CompatibilityOverride)\b/g)]
      .map((match) => match[1])
      .sort();

    expect([...new Set(overrideFlags)]).toEqual([
      ...PLANNER_CLEANUP_COMPATIBILITY_OVERRIDE_FLAGS,
    ].sort());
  });

  it("fails if legacy completion compatibility classes expand without updating the frozen registry", async () => {
    const source = await readFile(CONTRACT_FLOW_SOURCE_PATH, "utf8");
    const classes = [...source.matchAll(/compatibilityClass:\s*"([^"]+)"/g)]
      .map((match) => match[1]);
    const unexpected = [...new Set(classes)].filter(
      (compatibilityClass) =>
        !LEGACY_COMPLETION_COMPATIBILITY_CLASSES.includes(
          compatibilityClass as (typeof LEGACY_COMPLETION_COMPATIBILITY_CLASSES)[number],
        ),
    );

    expect(unexpected).toEqual([]);
  });

  it("tracks the phase 0 must-pass incident fixtures in the replay corpus", async () => {
    const entries = await readdir(INCIDENT_FIXTURE_DIR, { withFileTypes: true });
    const traceFixtures = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".trace.json"))
      .map((entry) => entry.name.replace(/\.trace\.json$/u, ""))
      .sort();

    expect(traceFixtures).toEqual(
      expect.arrayContaining([...PHASE0_MUST_PASS_INCIDENT_FIXTURES]),
    );
  });

  it("documents the currently open cleanup failure classes", () => {
    expect(PHASE0_OPEN_FAILURE_CLASSES).toEqual([
      "reviewer_writer_contract_collapse",
      "needs_verification_child_deadlock",
      "tool_routing_fail_open",
      "follow_up_tool_schema_suppression",
      "request_tree_budget_reset_across_retries",
    ]);
  });
});
