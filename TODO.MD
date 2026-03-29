# TODO: Architectural Cleanup Plan for Planner/Delegation/Verifier

## Scope

This document covers the architectural cleanup required to make AgenC's
planner-driven multi-agent workflow correct, predictable, and provider-safe.

Primary failing workflow class:

- read planning artifact (`PLAN.md`, `TODO.MD`, similar docs)
- spawn multiple reviewer agents
- synthesize their findings
- run one bounded writer/update step
- complete only when the executed graph and evidence match the request

This is not a single bug. It is a cross-layer contract failure spanning:

- planner prompting and graph validation
- delegation admission and artifact economics
- subagent orchestration and execution kernel semantics
- dependency summarization and synthesis handoff
- deterministic and model-based verification
- Grok/xAI provider capability routing

## Sources Used

Runtime and repo sources:

- `runtime/src/llm/chat-executor.ts`
- `runtime/src/llm/chat-executor-planner.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`
- `runtime/src/llm/chat-executor-planner-verifier-loop.ts`
- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/gateway/subagent-orchestrator.ts`
- `runtime/src/gateway/sub-agent.ts`
- `runtime/src/gateway/delegation-admission.ts`
- `runtime/src/gateway/delegation-economics.ts`
- `runtime/src/gateway/subagent-prompt-builder.ts`
- `runtime/src/gateway/subagent-dependency-summarization.ts`
- `runtime/src/workflow/execution-intent.ts`
- `runtime/src/workflow/execution-envelope.ts`
- `runtime/src/workflow/execution-kernel.ts`
- `runtime/src/workflow/execution-kernel-policy.ts`
- `runtime/src/workflow/completion-state.ts`
- `runtime/src/workflow/verification-obligations.ts`
- `runtime/src/workflow/verification-contract.ts`
- `runtime/src/workflow/workspace-inspection-evidence.ts`
- `runtime/src/workflow/subagent-orchestration-requirements.ts`
- `docs/architecture/flows/subagent-orchestration.md`
- `docs/architecture/guides/delegated-workspace-semantics.md`
- `runtime/benchmarks/v1/incidents/*.json`
- `runtime/src/eval/orchestration-scenarios.ts`

xAI docs:

- `/developers/model-capabilities/text/multi-agent`
- `/developers/tools/function-calling`
- `/developers/tools/tool-usage-details`
- `/developers/tools/advanced-usage`

Research used for architecture direction:

- OSWorld: execution-based evaluation matters for agent reliability
- SWE-Gym: explicit state and verifier correctness matter more than prose self-report

## Executive Diagnosis

The runtime is modeling the same workflow differently in different layers.

Today, the system has no single canonical workflow contract carried from:

1. planner intent extraction
2. planner graph validation
3. delegation admission
4. child execution envelope
5. dependency state propagation
6. parent synthesis
7. deterministic verification
8. model-based verifier pass
9. final completion-state resolution

Instead, each layer reconstructs or mutates semantics from partial state or
prompt text. That creates circular failures:

- planner asks for `6 reviewers + 1 writer`
- admission treats reviewers as conflicting artifact owners
- execution allows fallback to unblock downstream work
- verifier treats the same fallback as terminal failure
- reviewer children are graded as if they were implementation owners
- parent or synthesis layers attempt recovery writes that violate ownership
- provider routing silently mutates or drops tool contracts

The result is exactly what the traces show: localized fixes keep exposing the
next contradiction.

## End-to-End Path Map

Current relevant path:

1. `ChatExecutor.executeRequest()`
2. `executePlannerPath()`
3. `extractRequiredSubagentOrchestrationRequirements()`
4. `buildPlannerMessages()`
5. planner graph/schema validation
6. delegation utility + admission checks
7. `executePlannerPipelineWithVerifierLoop()`
8. `SubAgentOrchestrator.execute()`
9. execution kernel schedules reviewer/writer nodes
10. `executeSubagentStep()` -> `executeSubagentAttempt()` -> child spawn
11. child returns output + tool evidence + completion state
12. dependency summarization feeds downstream steps
13. parent deterministic verifier reconstructs work items
14. optional model-based verifier loop runs
15. workflow completion state is resolved

The critical problem is that step metadata is not preserved intact across this
full path.

## Required Architectural Invariants

The cleanup is not done until these invariants are true.

### I1. One Canonical Workflow Contract

Every delegated step must carry one typed contract from planner to completion.
No layer may reconstruct core semantics from prose once the contract exists.

Minimum fields:

- `stepRole`: `reviewer | writer | validator | researcher | synthesizer`
- `stepKind`: runtime execution shape
- `verificationMode`: `none | grounded_read | mutation_required | deterministic_followup`
- `artifactRelations`
- `requiredEvidence`
- `toolScope`
- `dependencyPolicy`
- `completionPolicy`

### I2. Artifact Relations Must Be Typed

The system must stop treating every artifact mention as ownership.

Required relation types:

- `read_dependency`
- `write_owner`
- `verification_subject`
- `context_input`
- `handoff_artifact`

Read-only reviewers are not artifact owners.

### I3. One Admission Authority

Planner-time and runtime-time policy must use the same decision model.

If a workflow shape is invalid, it must be invalid once, in one place, with one
reason code.

### I4. One Dependency-State Lattice

`delegation_fallback`, `blocked`, `noop_success`, `needs_verification`,
`completed`, and `failed` must have one shared meaning across kernel,
orchestrator, verifier, and completion-state logic.

### I5. Reviewer and Writer Contracts Must Diverge

A reviewer succeeds by producing grounded findings.
A writer succeeds by mutating or correctly no-oping the target artifact.

These are different completion contracts and must never be collapsed.

### I6. Provider Capability Routing Must Fail Closed

If requested tool/structured-output semantics cannot be honored on a model or
route, the runtime must reject or reroute explicitly. Silent mutation is not
acceptable.

For xAI specifically:

- undocumented field or behavior plus `HTTP 200` is not evidence of support
- only publicly documented fields or semantically proven behavior should shape
  runtime assumptions
- OpenAI-compat acceptance must be treated as untrusted until confirmed

### I7. Verification Must Judge the Executed Graph

The parent completion gate must verify the actual executed child graph,
including required reviewer cardinality, required evidence classes, and writer
ownership, not just the final prose summary.

## Complete Issue Inventory

### A. Contract and Typing Failures

#### A1. Reviewer children are treated as artifact owners

Symptoms:

- read-only `PLAN.md` reviewers collide with one final writer
- shared-artifact economics veto a workflow the planner was asked to create

Key files:

- `runtime/src/gateway/delegation-economics.ts`
- `runtime/src/gateway/delegation-admission.ts`
- `runtime/src/llm/chat-executor-planner.ts`

Required fix:

- move from artifact-name heuristics to typed artifact relations
- make reviewer reads non-owning by construction

#### A2. Policy authority is fragmented

Symptoms:

- planner can emit or refine a shape that runtime later rejects
- local repair logic can override earlier vetoes inconsistently

Key files:

- `runtime/src/llm/chat-executor-planner.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`
- `runtime/src/gateway/delegation-admission.ts`
- `runtime/src/gateway/subagent-orchestrator.ts`

Required fix:

- one canonical admission engine shared by planner and runtime

#### A3. Reviewer typing is lost before parent verification

Symptoms:

- reviewer steps get rebuilt from text-only work items
- `delegated_review` and `grounded_read` semantics disappear

Key files:

- `runtime/src/llm/chat-executor-types.ts`
- `runtime/src/llm/chat-executor-verifier.ts`

Required fix:

- preserve full execution contract in verifier work items
- remove text-based re-derivation for core step semantics

#### A4. Mixed reviewer/writer plans collapse into writer semantics

Symptoms:

- any writer in the graph escalates verification mode for the whole workflow
- reviewer children are judged as implementation/documentation owners

Key files:

- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/workflow/execution-intent.ts`

Required fix:

- workflow-level classification must not erase per-step role contracts

### B. Dependency and Completion-State Failures

#### B1. `delegation_fallback` has dual truth

Symptoms:

- execution kernel treats fallback as dependency-satisfied
- verifier treats the same status as unresolved failure

Existing incident fixture:

- `runtime/benchmarks/v1/incidents/delegation-fallback-dual-truth.*`

Key files:

- `runtime/src/workflow/execution-kernel-policy.ts`
- `runtime/src/workflow/execution-kernel.ts`
- `runtime/src/gateway/subagent-orchestrator.ts`
- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/llm/chat-executor-planner.ts`

Required fix:

- define one shared dependency-state lattice
- stop using `delegation_fallback` as both success-enough and failure

#### B2. `needs_verification` is treated as child failure

Symptoms:

- child completes work
- child correctly returns nonterminal `needs_verification`
- orchestrator maps it to failed/malformed child before parent verifier runs

Key files:

- `runtime/src/workflow/completion-state.ts`
- `runtime/src/gateway/sub-agent.ts`
- `runtime/src/gateway/subagent-orchestrator.ts`

Required fix:

- nonterminal completion states must propagate as nonterminal, not failure

#### B3. Mandatory verification can be marked performed without actually running

Symptoms:

- deterministic heuristics can stand in for mandatory verifier execution
- completion model records verifier pass semantics too loosely

Key files:

- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`
- `runtime/src/llm/chat-executor-planner-verifier-loop.ts`
- `runtime/src/workflow/completion-state.ts`

Required fix:

- split `verified`, `deterministically_admitted`, and `accepted_without_verifier`

### C. Evidence and Verification Failures

#### C1. Workspace-grounding rules overfire on reviewer children

Symptoms:

- reviewer child only needs grounded review of the planning artifact
- verifier demands non-target workspace inspection anyway

Key files:

- `runtime/src/workflow/workspace-inspection-evidence.ts`
- `runtime/src/utils/delegation-validation.ts`
- `runtime/src/workflow/verification-obligations.ts`
- `runtime/src/workflow/verification-contract.ts`

Required fix:

- attach workspace-inspection obligations to explicitly designated auditors or
  final workspace-grounded writers, not all reviewers

#### C2. Reviewer rubric is implementation-shaped

Symptoms:

- reviewer outputs fail for `acceptance_criteria_not_evidenced`
- unresolved future work is treated as contradictory completion

Key files:

- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/workflow/verification-contract.ts`

Required fix:

- define reviewer success as grounded findings, gap identification, and
  evidence-backed assessment, not “fully implemented”

#### C3. No-op and already-correct outcomes are not first-class enough

Symptoms:

- grounded no-op updates can still fail for missing mutation evidence

Existing incident fixture:

- `runtime/benchmarks/v1/incidents/noop-success-rejected.*`

Key files:

- `runtime/src/workflow/verification-contract.ts`
- `runtime/src/workflow/verification-obligations.ts`

Required fix:

- first-class `noop_success` contract with explicit evidence requirements

### D. Handoff and Ownership Failures

#### D1. Reviewer-to-writer handoff is lossy

Symptoms:

- writer receives summaries or partial dependency context instead of a typed,
  complete handoff artifact
- synthesis feedback can be missing or dropped under prompt pressure

Key files:

- `runtime/src/gateway/subagent-prompt-builder.ts`
- `runtime/src/gateway/subagent-context-curation.ts`
- `runtime/src/gateway/subagent-dependency-summarization.ts`

Required fix:

- introduce explicit handoff artifacts with typed schema and provenance

#### D2. Parent fallback writes can violate child ownership

Symptoms:

- writer child blocks or fails
- parent attempts inline recovery write against child-owned artifact

Key files:

- `runtime/src/llm/chat-executor-planner-execution.ts`
- `runtime/src/gateway/subagent-orchestrator.ts`

Required fix:

- fail closed once a child owns a write artifact
- allow only explicitly modeled ownership transfer

#### D3. Successful child writes are not authoritative enough

Symptoms:

- file mutation happened
- parent/verifier/synthesis can still treat the write as non-authoritative due
  to role confusion

Key files:

- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/workflow/verification-contract.ts`
- `runtime/src/workflow/completion-state.ts`

Required fix:

- child-owned mutation evidence must be reconciled against typed contract, not
  discarded by workflow-level reclassification

### E. Planner and Budgeting Failures

#### E1. Repair/refinement logic is mismatched to artifact-update workflows

Symptoms:

- planner repair logic steers toward the wrong workflow class
- artifact-update paths and implementation paths share repair logic poorly

Key files:

- `runtime/src/llm/chat-executor-planner.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`

Required fix:

- route repair/refinement by canonical workflow class, not inferred prose

#### E2. Required reviewer cardinality is enforced too weakly at completion

Symptoms:

- user asks for N actual reviewer agents
- one child can synthesize N perspectives
- run can still pass if verifier path is not using strict executed-child checks

Key files:

- `runtime/src/workflow/subagent-orchestration-requirements.ts`
- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`

Required fix:

- completion gate must inspect actual child session graph and required role set

#### E3. Timeout hints are dropped

Symptoms:

- planner computes `maxBudgetHint`
- orchestrator parses it
- child spawn still gets `timeoutMs: 0`

Key files:

- `runtime/src/gateway/subagent-orchestrator.ts`

Required fix:

- propagate parsed per-step timeout budget into child spawn and retry logic

#### E4. Request-tree budgets reset across retries

Symptoms:

- verifier loops and planner retries recreate a fresh request-tree budget
- named “per request tree” limits do not span the actual request lifecycle

Key files:

- `runtime/src/gateway/subagent-orchestrator.ts`
- `runtime/src/llm/chat-executor-planner-verifier-loop.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`

Required fix:

- persist budget tracker identity across the whole parent request lifecycle

### F. Provider and Model-Capability Failures

Provider rule for this cleanup:

- xAI compatibility must be modeled from documented capabilities first
- undocumented OpenAI-surface fields that merely return `200` must not be used
  as architecture assumptions

#### F1. Tool routing can fail open

Symptoms:

- requested tool subset cannot be resolved
- provider falls back to full tool catalog instead of failing closed

Key files:

- `runtime/src/llm/grok/adapter.ts`
- `runtime/src/llm/chat-executor.ts`

Required fix:

- if routed tools cannot be realized, reject or reroute; never widen scope

#### F2. xAI multi-agent is modeled too loosely

Symptoms:

- code treats broad `grok-4*` family as compatible with custom tools and local
  structured-output expectations
- xAI docs state multi-agent does not support client-side/custom tools

Key files:

- `runtime/src/llm/provider-native-search.ts`
- `runtime/src/llm/structured-output.ts`
- `runtime/src/llm/grok/adapter.ts`
- `runtime/src/gateway/context-window.ts`

Required fix:

- explicit capability registry by exact model family
- hard block client-side/custom tools on xAI multi-agent models

#### F3. Follow-up tool schemas can be silently dropped

Symptoms:

- after first client-side tool checkpoint
- follow-up request can suppress all tools due to local schema-size cap
- xAI function-calling loop then breaks mid-run

Key files:

- `runtime/src/llm/grok/adapter.ts`
- `runtime/src/llm/chat-executor-tool-loop.ts`

Required fix:

- fail closed when follow-up tool loop cannot preserve required tools
- shrink schema deterministically or reroute to a compatible path

#### F4. Structured-output compatibility is checked too late

Symptoms:

- executor routes a planner/verifier turn assuming structured output
- adapter silently strips tools or structured-output-related params later

Key files:

- `runtime/src/llm/chat-executor.ts`
- `runtime/src/llm/model-routing-policy.ts`
- `runtime/src/llm/grok/adapter.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`
- `runtime/src/llm/chat-executor-planner-verifier-loop.ts`

Required fix:

- planner/verifier routing must use model-specific capability checks before the
  request is shaped

#### F5. Local defaults diverge from xAI documented defaults

Symptoms:

- parallel function calling is disabled locally by default even though xAI
  documents parallel function calling as the default behavior

Key files:

- `runtime/src/llm/grok/adapter.ts`

Required fix:

- make local defaults explicit and intentional by workflow class
- do not masquerade local policy as provider behavior

### G. Documentation, Fixtures, and Test Drift

#### G1. Architecture docs describe rules the runtime violates

Symptoms:

- docs say shared-artifact multi-writer delegation is denied by default
- runtime still allows contradictory planner/admission/verifier behavior around
  that rule

Key files:

- `docs/architecture/flows/subagent-orchestration.md`
- `docs/architecture/guides/delegated-workspace-semantics.md`

Required fix:

- align docs, runtime, and incident fixtures after refactor

#### G2. Incident coverage exists but is incomplete

Symptoms:

- some known failures are already codified
- other failures from recent logs are not yet captured as deterministic incidents

Key files:

- `runtime/src/eval/orchestration-scenarios.ts`
- `runtime/benchmarks/v1/incidents/*.json`

Required fix:

- add incident fixtures for:
  - reviewer/writer contract collapse
  - `needs_verification` child deadlock
  - tool-routing fail-open
  - follow-up tool-schema suppression
  - request-tree budget reset across retries

## Target Architecture

### 1. Canonical `WorkflowContract`

Introduce a typed workflow contract object created once during planner
normalization and carried end-to-end.

Suggested structure:

```ts
interface WorkflowContract {
  workflowClass:
    | "artifact_review_and_rewrite"
    | "implementation_with_verification"
    | "read_only_review"
    | "validation_only"
    | "research_and_synthesis";
  requiredChildren: {
    cardinality: number;
    roles: readonly string[];
    exactNames?: readonly string[];
  };
  steps: readonly WorkflowStepContract[];
  dependencyPolicy: WorkflowDependencyPolicy;
  completionPolicy: WorkflowCompletionPolicy;
  providerConstraints: ProviderConstraintSet;
}

interface WorkflowStepContract {
  name: string;
  role: "reviewer" | "writer" | "validator" | "researcher" | "synthesizer";
  stepKind: ExecutionStepKind;
  verificationMode: ExecutionVerificationMode;
  artifactRelations: readonly ArtifactRelation[];
  requiredEvidence: RequiredEvidencePolicy;
  toolScope: ToolScopeContract;
  completionPolicy: StepCompletionPolicy;
}
```

### 2. Typed Artifact Graph

Replace ad hoc ownership logic with:

- `read_dependency`
- `write_owner`
- `verification_subject`
- `handoff_artifact`

This must become the source of truth for:

- admission safety
- child tool scoping
- fallback eligibility
- verifier evidence expectations

### 3. Shared Dependency-State Lattice

Replace ad hoc status interpretation with one shared state model:

- `pending`
- `running`
- `completed_unverified`
- `completed_verified`
- `noop_success`
- `blocked_retryable`
- `blocked_nonretryable`
- `fallback_applied`
- `failed`
- `cancelled`

Then define exactly:

- which states satisfy downstream dependencies
- which states can feed synthesis
- which states can lead to terminal acceptance

### 4. Reviewer/Writer Split

Reviewer contract:

- grounded findings
- cited evidence
- unresolved gaps allowed
- no mutation required

Writer contract:

- grounded artifact update or grounded no-op
- mutation or explicit no-op evidence
- consumes handoff artifacts from reviewers

### 5. Provider Capability Registry

Create one explicit capability registry keyed by provider + exact model family.

Must decide up front:

- custom client-side tools allowed?
- structured outputs allowed with tools?
- follow-up tool loop safe?
- server-side multi-agent compatible?
- parallel tool calls desired?

No later silent adapter mutation.

## Detailed Remediation Plan

### Phase 0: Freeze Semantics and Add Safety Rails

Goal:

- stop adding local fixes that deepen contradictions

Tasks:

- declare planner/delegation/verifier path in temporary cleanup mode
- block new ad hoc status codes or verifier issue codes without contract mapping
- document current incident fixtures as must-pass cleanup targets

Files:

- `runtime/src/workflow/*`
- `runtime/src/llm/*`
- `runtime/src/gateway/*`
- `docs/architecture/*`

Exit criteria:

- issue inventory accepted
- cleanup branch protected from unrelated refactors

### Phase 1: Introduce Canonical Workflow and Step Contracts

Goal:

- one typed contract survives from planner to completion

Tasks:

- add `WorkflowContract` and `WorkflowStepContract`
- carry full execution/verification context in planner work items
- deprecate text-only verifier reconstruction paths
- add explicit `role` and `artifactRelations`

Files:

- `runtime/src/llm/chat-executor-types.ts`
- `runtime/src/llm/chat-executor-planner.ts`
- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/workflow/execution-envelope.ts`
- `runtime/src/workflow/subagent-orchestration-requirements.ts`

Exit criteria:

- reviewer and writer contracts remain distinct in verifier work items
- planner and verifier tests assert full contract preservation

### Phase 2: Replace Ownership Heuristics with Typed Artifact Relations

Goal:

- read-only reviewers stop colliding with final writer ownership

Tasks:

- add typed artifact-relation model
- migrate admission and economics to relation-aware decisions
- eliminate inference that “mentions target artifact” implies ownership

Files:

- `runtime/src/gateway/delegation-admission.ts`
- `runtime/src/gateway/delegation-economics.ts`
- `runtime/src/workflow/execution-envelope.ts`
- `runtime/src/llm/chat-executor-planner.ts`

Exit criteria:

- `N reviewers + 1 writer` on one planning artifact is admissible when reviewer
  relations are read-only
- shared multi-writer conflict still fails closed

### Phase 3: Unify Dependency and Completion-State Semantics

Goal:

- stop `fallback`, `needs_verification`, and `noop` from meaning different
  things in different layers

Tasks:

- define single dependency-state lattice
- refactor execution kernel policy to use it
- refactor orchestrator result mapping to use it
- make `needs_verification` nonterminal, not failure
- make fallback semantics explicit and non-contradictory

Files:

- `runtime/src/workflow/execution-kernel.ts`
- `runtime/src/workflow/execution-kernel-policy.ts`
- `runtime/src/workflow/completion-state.ts`
- `runtime/src/gateway/sub-agent.ts`
- `runtime/src/gateway/subagent-orchestrator.ts`

Exit criteria:

- no code path treats one status as both dependency-satisfied and verifier-failed
- child nonterminal states can survive to parent verifier loop

### Phase 4: Refactor Verification Around Step Roles

Goal:

- reviewers are graded as reviewers, writers as writers

Tasks:

- split verifier templates/prompts by role
- split deterministic checks by role
- attach workspace-grounding only to steps that truly require it
- formalize no-op success
- formalize required reviewer cardinality against actual child sessions

Files:

- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/workflow/verification-obligations.ts`
- `runtime/src/workflow/verification-contract.ts`
- `runtime/src/utils/delegation-validation.ts`

Exit criteria:

- grounded reviewer output with findings passes reviewer verification
- writer must mutate or grounded-no-op appropriately
- run cannot succeed if required reviewer child sessions are missing or failed

### Phase 5: Make Handoff Explicit and Lossless

Goal:

- writer consumes concrete reviewer artifacts, not best-effort summaries

Tasks:

- introduce typed reviewer handoff artifact schema
- store reviewer findings with provenance and evidence refs
- feed writer from handoff artifacts first, transcript second
- block parent inline write fallback after child ownership begins

Files:

- `runtime/src/gateway/subagent-dependency-summarization.ts`
- `runtime/src/gateway/subagent-prompt-builder.ts`
- `runtime/src/gateway/subagent-context-curation.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`

Exit criteria:

- writer always receives explicit synthesized reviewer artifact
- parent cannot steal child-owned write targets

### Phase 6: Fix Budget and Retry Semantics

Goal:

- request-tree controls must span the actual request lifecycle

Tasks:

- propagate timeout hints into child spawn
- persist request-tree budget tracker across planner retries and verifier loops
- separate per-attempt limits from per-request limits

Files:

- `runtime/src/gateway/subagent-orchestrator.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`
- `runtime/src/llm/chat-executor-planner-verifier-loop.ts`

Exit criteria:

- long loops cannot reset budgets by retrying
- per-step timeout budgets are honored

### Phase 7: Harden xAI/Grok Capability Routing

Goal:

- provider semantics become explicit, fail-closed, and consistent with docs

Tasks:

- build explicit capability matrix for Grok models
- reject client-side/custom tools on xAI multi-agent routes
- reject routed-tool subsets that cannot be realized
- remove silent tool dropping on follow-up loops; replace with explicit error or
  deterministic shrink strategy
- perform structured-output/tool compatibility checks before request shaping
- make parallel tool-call policy explicit per workflow type

Files:

- `runtime/src/llm/grok/adapter.ts`
- `runtime/src/llm/provider-native-search.ts`
- `runtime/src/llm/structured-output.ts`
- `runtime/src/llm/model-routing-policy.ts`
- `runtime/src/llm/chat-executor.ts`
- `runtime/src/llm/chat-executor-tool-loop.ts`
- `runtime/src/gateway/context-window.ts`

Exit criteria:

- no fail-open routed-tool widening
- no custom-tool path on xAI multi-agent models
- no follow-up tool-loop schema suppression without explicit failure handling

### Phase 8: Rebuild the Regression and Evaluation Suite

Goal:

- keep this from regressing again

Tasks:

- expand `orchestration-scenarios.ts`
- add incident fixtures for all new failure classes
- add integration tests for:
  - exact `6 reviewers + 1 writer` PLAN flow
  - one reviewer failure causing terminal failure
  - grounded no-op plan update
  - writer blocked until reviewer handoff exists
  - `needs_verification` child surviving to parent verifier
  - request-tree budgets spanning retries
  - xAI route mismatch fail-closed behavior

Files:

- `runtime/src/eval/orchestration-scenarios.ts`
- `runtime/benchmarks/v1/incidents/*`
- `runtime/tests/regression/orchestration/*`
- `runtime/src/llm/*.test.ts`
- `runtime/src/gateway/*.test.ts`
- `runtime/src/workflow/*.test.ts`

Exit criteria:

- all incident fixtures are deterministic and green
- cleanup branch has an end-to-end regression suite for this workflow class

## File-by-File Impact Map

### Core workflow model

- `runtime/src/workflow/execution-envelope.ts`
- `runtime/src/workflow/execution-intent.ts`
- `runtime/src/workflow/completion-state.ts`
- `runtime/src/workflow/subagent-orchestration-requirements.ts`

### Planner and runtime execution

- `runtime/src/llm/chat-executor.ts`
- `runtime/src/llm/chat-executor-planner.ts`
- `runtime/src/llm/chat-executor-planner-execution.ts`
- `runtime/src/llm/chat-executor-planner-verifier-loop.ts`
- `runtime/src/llm/chat-executor-types.ts`

### Delegation and orchestration

- `runtime/src/gateway/delegation-admission.ts`
- `runtime/src/gateway/delegation-economics.ts`
- `runtime/src/gateway/sub-agent.ts`
- `runtime/src/gateway/subagent-orchestrator.ts`
- `runtime/src/gateway/subagent-prompt-builder.ts`
- `runtime/src/gateway/subagent-context-curation.ts`
- `runtime/src/gateway/subagent-dependency-summarization.ts`

### Verification

- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/workflow/verification-obligations.ts`
- `runtime/src/workflow/verification-contract.ts`
- `runtime/src/utils/delegation-validation.ts`
- `runtime/src/workflow/workspace-inspection-evidence.ts`

### Provider compatibility

- `runtime/src/llm/grok/adapter.ts`
- `runtime/src/llm/provider-native-search.ts`
- `runtime/src/llm/structured-output.ts`
- `runtime/src/llm/model-routing-policy.ts`
- `runtime/src/llm/chat-executor-tool-loop.ts`
- `runtime/src/gateway/context-window.ts`

### Docs and incidents

- `docs/architecture/flows/subagent-orchestration.md`
- `docs/architecture/guides/delegated-workspace-semantics.md`
- `runtime/src/eval/orchestration-scenarios.ts`
- `runtime/benchmarks/v1/incidents/*`

## Rollout Strategy

### Stage 1: Contract introduction without behavior flips

- add types
- add shadow logging of new contract
- compare old and new interpretation on live traces

### Stage 2: Admission and verifier migration

- switch planner/admission to typed artifact relations
- keep old verifier in shadow mode for comparison

### Stage 3: Kernel and completion-state migration

- replace dual-truth status handling
- preserve replay compatibility adapters temporarily

### Stage 4: Provider fail-closed migration

- enable strict routed-tool resolution
- enable strict model capability gating
- add explicit operator errors for incompatible routes

### Stage 5: Remove legacy heuristics

- delete text-based verifier reconstruction
- delete ownership heuristics based on artifact name presence
- delete silent adapter mutation paths that mask incompatibility

## Validation Plan

### Deterministic validation

- all existing orchestration incident fixtures green
- new incident fixtures added for all open issue classes
- unit tests for canonical workflow contract and artifact relations
- request-tree budget tests spanning retries

### Integration validation

- exact natural-language request for `6 actual agents with different roles`
- exact required reviewer cardinality verified from child session ids
- writer blocked until reviewer handoff exists
- grounded reviewer pass without false implementation failure
- grounded writer pass with mutation
- grounded writer pass with true no-op

### Provider validation

- xAI Grok reasoning models with client-side function calls
- negative tests for xAI multi-agent + custom tools
- routed-tool mismatch must fail closed
- follow-up tool-loop requests must preserve required tools or error explicitly

### Replay validation

- replay historical traces that previously produced:
  - `shared_artifact_writer_inline`
  - `missing_file_mutation_evidence`
  - `acceptance_criteria_not_evidenced`
  - `implementation_completion:placeholder_stub`
  - `planner_synthesis_missing_materialized_artifact`
  - `delegation_fallback` dual truth

## Non-Goals

- not rewriting the entire planner prompt stack before contract cleanup
- not moving to xAI server-side multi-agent for this workflow
- not relaxing verification just to make current traces pass
- not broadening artifact ownership to allow true multi-writer races
- not silently degrading provider/tool semantics for compatibility

## What Must Be Deleted When This Is Done

- text-only verifier reconstruction of reviewer/writer semantics
- ownership inference from plain target-artifact mentions
- any path where `delegation_fallback` is dependency-satisfied and verifier-failed
- any path where `needs_verification` is coerced into failed child status
- any parent inline recovery write against child-owned artifact
- any adapter path that widens tool scope when routed tools cannot be honored
- any adapter path that silently strips required follow-up tools

## Immediate Work Queue

1. Introduce canonical workflow and step contracts.
2. Introduce typed artifact relations and migrate admission/economics.
3. Refactor verifier work items to carry full execution contract.
4. Replace dual-truth dependency statuses with one lattice.
5. Split reviewer and writer verification semantics.
6. Introduce explicit reviewer handoff artifacts.
7. Fix timeout propagation and request-tree budget persistence.
8. Harden xAI/Grok capability routing to fail closed.
9. Expand orchestration incident fixtures and end-to-end regression suite.
10. Update architecture docs only after runtime behavior matches them.

## Definition of Done

This cleanup is done only when all of the following are true:

- a natural-language request for `N actual reviewer agents + 1 writer` results
  in exactly that executed child graph
- read-only reviewers do not collide with writer ownership
- reviewer steps are verified as reviewers, not implementations
- writer step receives explicit reviewer handoff artifacts
- fallback and nonterminal states have one shared meaning everywhere
- provider/tool/model capability mismatches fail closed before execution
- historical incidents replay green under deterministic evaluation
- docs, incident fixtures, tests, and live runtime all describe the same system
