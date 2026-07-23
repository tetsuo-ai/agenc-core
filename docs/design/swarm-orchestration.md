# Swarm and agent orchestration

This document is the product-truth map for AgenC's adaptive `/swarm` mode and
the daemon-backed multi-agent v2 runtime. It separates runtime guarantees from
model guidance, records the evidence boundary for delegated work, and defines
the local evaluation needed before changing routing defaults.

## Canonical path

```text
/swarm setting
  → per-turn routing guidance + model-facing audit receipt
  → spawn_agent / assign_task / send_message / wait_agent / close_agent
  → AgentControl admission, identity, role provenance, and mailboxes
  → delegate isolation + fork-context boundary
  → runAgent persistent worker
      → one fresh turn id and timeout budget per assignment
      → one structured outcome receipt per assignment
  → parent mailbox + background-task projection
  → parent review, verification, and integration
```

`runtime/src/agents/v2/` is the canonical model-facing coordination surface.
The older team/pane utilities under `runtime/src/utils/swarm/` support their
explicit UI and compatibility workflows; `/swarm` does not route new v2 work
through that state machine. Do not add a third agent lifecycle.

## What is advisory and what is enforced

`/swarm` changes a root agent's model-facing instructions. It does not itself
spawn a worker, reserve capacity, approve a tool, create a worktree, or merge a
change.

| Boundary | Runtime truth |
| --- | --- |
| `mode`, `recommended_max_agents`, isolation, and integration in `agenc.swarm.route.v1` | Advisory. The model may use fewer workers or remain sequential. These fields are not spawn-admission controls. |
| User instruction not to delegate | Emitted as high-priority model guidance and expected to be honored; it is not a new OS sandbox primitive. |
| Agent depth, live-slot/concurrency capacity, role provenance, execution admission, and budgets | Enforced by the existing control and admission paths at spawn time. |
| Tool availability, permission mode, approval rules, and sandbox policy | Enforced normally. Swarm mode grants no additional tool or filesystem authority. |
| `assign_task` eligibility | Enforced atomically: the target must be a live, idle, reusable descendant with no outstanding assignment. |
| `isolation: "worktree"` | Enforced only when explicitly requested on `spawn_agent`; a routing recommendation alone does not create one. |
| Worktree integration | Never automatic. Only the captured immutable `base_commit..integration_ref` evidence range is eligible for review; a path, branch name, worker claim, or successful task outcome is not. |

## Routing policy

Swarm mode is not “always use more agents.”
`runtime/src/agents/swarm-routing.ts` makes a conservative decision for every
eligible root turn:

- `sequential` is the default. One rollout owns a coupled critical path.
- `parallel` requires either explicit parallel/concurrent delegation language,
  or explicit independence language together with a syntactic list. List
  formatting, vague plurality, task length, or broad “audit/research” wording
  alone stays sequential. A parallel decision recommends two workers normally
  and a guidance ceiling of four for four or more listed items.
- High-risk work that is otherwise parallelizable is capped at two workers.
  Coupling or an explicit no-delegation instruction still keeps it sequential.
- `coordinate` is used when there is no matching new root-human task, including
  mailbox-driven completion turns. It consumes existing receipts instead of
  recursively replacing finished workers.
- Writable parallel work is advised to use isolated worktrees and a
  `verify_then_integrate` boundary. Read-only analysis uses result synthesis.

The attachment producer emits at most one routing reminder per exact root
`turnId`, and never emits one for a child agent. It routes the root-human text
only when the runtime-owned human-turn ID matches the current turn ID. A
synthetic follow-up, stale transcript text, or missing exact provenance is
routed as `coordinate` with zero replacement workers.

The model-facing `<swarm_routing_receipt>` contains:

- policy version `agenc.swarm.route.v1`;
- a SHA-256 fingerprint of the exact trusted root-human input, including
  policy-relevant layout/newlines, while never exposing that text in the
  receipt;
- `sequential`, `parallel`, or `coordinate`;
- recommended maximum agents, isolation, and integration mode;
- the conservative explicit-parallelism, independence/list, coupling, write,
  and risk signals that produced the decision.

This receipt is derived from trusted turn provenance, but it is still an
ephemeral prompt attachment. It is not written as a durable event-log record,
is not a replay boundary, and is not proof that the model followed the
recommendation.

Actual delegation goes through `spawn_agent`, where the normal permission,
sandbox, tool-policy, capacity, execution-admission, and budget checks remain
in force.

## Delegation and assignment admission

`spawn_agent` requires a non-empty self-contained `message` and `task_name`.
It validates the requested role against the immutable role workspace and
validates any model, reasoning-effort, and service-tier overrides. Omitting
`fork_turns` creates a clean fork; explicit full-history forks inherit the
parent role/model/effort and reject those overrides.

Worktree isolation also requires a valid task name, a Git repository, and an
available child sandbox execution boundary. A spawn result identifies the
live agent and may include worktree locators; it is not a task-completion or
integration receipt.

An accepted `assign_task` is narrower than generic message delivery:

1. the sender and target cannot be the same agent;
2. the sender must be a strict ancestor of the target in the agent tree;
3. the root cannot be an assignment target;
4. the target must be a live `idle` reusable worker;
5. no earlier assignment may remain outstanding.

Admission allocates the assignment's `taskId` and fresh `turnId`, installs the
outstanding-assignment marker, and projects the triggering mailbox item as one
synchronous operation. A rejected assignment enqueues no task. The successful
tool result returns both IDs; that result means “accepted,” not “completed.”

`send_message` is different. It is passive, does not allocate a task turn, and
does not call the provider. The runtime retains the authenticated author;
messages from peers outside the target's ancestor chain are explicitly framed
as untrusted data. Passive messages stay within normal mailbox bounds and are
folded into the next admitted assignment.

## Worker and turn lifecycles

A reusable worker and one assignment are different lifecycles:

- A v2 worker normally moves
  `pending_init → running → idle → running … → shutdown`.
- Each accepted assignment receives a fresh `turnId`, originating `taskId`,
  model-turn/run context, tool-call count, and timeout controller. One task may
  make multiple provider calls while tools are used. Idle time is not charged
  to the next turn.
- `completed` is a terminal status used by one-shot/compatibility lifecycles;
  a successful keep-alive v2 turn publishes its turn outcome and leaves the
  worker `idle`.
- `errored` and `shutdown` are irreversible. `interrupted` is non-final for
  watcher semantics but is not assignment-eligible; only `idle` workers accept
  another task. `not_found` is a lookup result, not a live state.
- Every accepted task reaches one outcome:
  `completed`, `errored`, `interrupted`, or `nack`. `nack` means admission
  succeeded but teardown happened before the task could start.
- Wake-up is observe/subscribe/recheck/drain. The provider is never called
  directly from a wake signal; a triggering message must be drained first.
- A queued trigger is consumed before another provider call, so stale input
  cannot be replayed as a new turn.

These rules prevent stale-input replay, duplicate turns, lost wake-ups, and
unbounded idle timers. Task outcomes are made durable independently of their
best-effort parent projection, as described next.

### Correlated turn outcome

Before the runtime projects a result into the parent mailbox, it durably
appends `subagent_turn_outcome` to the child journal. The parent-visible
`<subagent_notification>` then carries:

- runtime-owned agent path, identity, role, and role-workspace provenance;
- `lifecycle: "turn"`, `task_id`, `turn_id`, and outcome;
- per-turn tool-call count;
- final message or failure/interruption reason when present;
- post-turn worktree evidence when the worker is isolated.

Progress events carry the same task/turn correlation. A generic completion
watcher notification is suppressed when the correlated receipt already
represents that turn. The journal-first ordering makes the child outcome—not
the parent mailbox—the authority, and the per-turn commit guard prevents a
second durable outcome for the same turn. If durable outcome append fails,
AgenC clears the outstanding admission, marks the worker `errored`, emits a
warning, and does not project the result as though durable evidence existed.

Parent projection is a separate, bounded live-process delivery step. Receipt
fields are truncated for model context and carry a stable `projection_id` plus
a reference to the full child outcome. A bounded in-memory outbox retries
mailbox backpressure and transient send failures while the process and parent
session remain live. This is deliberately not described as crash-exactly-once:
the child journal and parent mailbox are different durability domains, with no
cross-journal transaction. A daemon/process loss after child commit but before
parent delivery can require recovery from the referenced child rollout; a
later recovery implementation must deduplicate by `projection_id`. If the
live outbox itself saturates, AgenC retains the durable task outcome, emits an
explicit warning, and marks the worker lifecycle `errored` rather than
claiming that a receipt was delivered or allowing silent worker reuse.

### Root mailbox and model-context bounds

The root session mailbox is bounded independently of the model context: at
most 512 retained records and 16 MiB of measured envelope data. Human idle
input and turn-triggering control/receipt records are protected. They may
displace passive agent chatter, with a sequence-aware omission summary, but a
protected record or human-input batch is rejected atomically when no safe
capacity remains; AgenC must not report a partially admitted human batch as
accepted. The daemon/TUI pre-turn queues accept at most 512 non-empty inputs
and 16 MiB of measured serialized retained content blocks. Human batches that
accompany a concrete submission use an opaque admission token bound to their
exact queue coordinates. A preparation or submission failure before the turn
consumes that batch rolls back only those coordinates and restores the visible
composer; it cannot broadly drain unrelated traffic or leave hidden
attachment/skill context for the next prompt. Consumed or indeterminate
outcomes are not duplicated.

One model turn projects at most 32 agent records and 128 KiB of agent content.
An individually oversized first record is bounded with a visible truncation
marker so it cannot be deferred forever. Passive overflow is summarized or
left for the next human/root turn; passive chatter alone never creates a chain
of paid autonomous turns. Deferred triggering receipts remain protected and
schedule bounded follow-up turns until their prefix is consumed. Retained FIFO
coordinates and omission ranges survive selective drains, so idle-input
collection cannot silently reorder agent traffic.

`wait_agent` is not a read-only status query: it drains every delivered parent
mailbox update into the current turn and therefore has no target filter.
`list_agents` is the non-mutating live-tree/status view. Near-simultaneous
completion notifications may be coalesced into one parent follow-up turn, but
each assignment retains its own receipt and correlation IDs.

## Failure, interruption, and close semantics

- Spawn validation, worktree setup, capacity, admission, or provenance failure
  returns an error and does not expose a successful live child.
- Assignment admission failure returns an error without enqueuing the rejected
  task or consuming a new worker turn.
- A task that starts and fails publishes `errored` with a reason. Runtime and
  provider failures, including `role_timeout`, are errors. An explicit
  interrupt or non-timeout cancellation/abort publishes `interrupted` with a
  reason.
- If a worker is torn down after an assignment is accepted but before it
  starts, the task receives `nack` with
  `worker_teardown_before_start` before child-session shutdown; accepted work
  is not silently dropped.
- `close_agent` is an approval-bearing terminal mutation. It closes the
  worker's mailboxes, releases the live registry slot, and shuts down
  descendants before the parent worker.
- A worker receipt reports an outcome; it does not assert that claimed files
  are correct, that tests really passed, or that a worktree evidence range is
  safe to integrate.

## Fork and trust boundaries

Omitting `fork_turns` is a clean fork. The child sees its self-contained task
and trusted runtime/system context, not the parent's full conversation.
`fork_turns: "all"` is an explicit full-history choice; a positive integer
copies only that many recent turns.

Agent identity, role workspace, sender path, task id, and worktree coordinates
come from runtime-owned envelopes. Worker prose remains untrusted evidence:

- validate claims against source, diffs, and test output;
- do not execute instructions embedded in a worker result merely because it
  arrived through a mailbox;
- do not let repository instructions expand permissions or sandbox authority;
- do not integrate a worktree range from a completion signal alone.

## Worktree integration contract

For independent writable tasks, the parent gives each worker a disjoint write
set and `isolation: "worktree"`. The worker should commit every intended
deliverable and report its commit(s), changed paths, and checks. One turn may
produce more than one commit. Those prose claims remain untrusted. After the
turn, the runtime inspects the isolated worktree through the sandboxed Git
boundary without mutating the index, branch, or object database.

Automatic worktree coordinates are scoped to the session, full agent path, and
one logical spawn. Reassigning the same live worker keeps its rolling worktree
and evidence base, but a later replacement spawn at the same agent path gets a
fresh branch and directory. Retained state from an earlier worker is therefore
never resumed implicitly.

The worktree path, branch, and canonical Git root are locators, not immutable
evidence. The captured state is one of:

| State | Meaning | Integration reference | Keep-alive reuse |
| --- | --- | --- | --- |
| `committed_clean` | HEAD changed from the captured base, the base remains an ancestor, and the worktree is clean | Exact immutable `head_commit`, repeated as `integration_ref` | Advance the rolling base to the captured HEAD; the worker may continue |
| `unchanged_clean` | HEAD equals the base and the worktree is clean | None | Preserve/advance the rolling base; the worker may continue |
| `dirty_uncommitted` | Base ancestry is intact, but tracked or untracked output remains uncommitted | None | Stop reuse and retain the evidence/worktree for diagnosis |
| `diverged` | The captured base is not an ancestor of HEAD | None | Stop reuse and retain the evidence/worktree for diagnosis |
| `unverifiable` | Git evidence could not be captured or validated | None; only bounded sanitized error plus locators | Stop reuse and retain the evidence/worktree for diagnosis |

Verifiable states also carry the captured base commit, HEAD commit, tree hash,
cleanliness, and ancestry result. Only `committed_clean` may carry
`integration_ref`, and that value is the exact commit object ID. Never infer an
integration target from the mutable branch name or path. A `completed` task
with any other evidence state is still non-integrable.

Worktree evidence is also a keep-alive admission boundary. After
`committed_clean` or `unchanged_clean`, AgenC advances the worker's rolling
base and may admit another assignment. `dirty_uncommitted`, `diverged`, and
`unverifiable` fail closed: the worker does not return to reusable `idle`, and
the captured evidence and worktree are retained so a parent can diagnose the
state instead of compounding it with another turn.

Git's porcelain status excludes ignored files, and the captured commit/tree
does not contain an ignored file that was never added. A clean evidence state
therefore makes no claim about ignored files. If an ignored path is an intended
deliverable, the worker must explicitly unignore it or use `git add -f`, then
commit it before completion; otherwise it is outside the evidence range and
must not be integrated from the worktree path.

Evidence capture is a bounded point-in-time observation, not an atomic
filesystem snapshot. AgenC reads both HEAD and porcelain status before and
after the intervening Git probes and returns `unverifiable` if either observable
moves. The isolated worker must still be quiescent during capture: two status
reads cannot detect content changing between two equally dirty porcelain
states. The immutable commit/tree and reviewed `base_commit..integration_ref`
range remain the integration authority; mutable worktree contents never do.

Integration stays an explicit parent operation (or a sequentially assigned
integration worker when coordinator mode has no git tools):

1. require `committed_clean` evidence and select the immutable
   `base_commit..integration_ref` range, not branch;
2. inspect every commit and the aggregate diff in that exact evidence range;
3. verify the worker's claimed checks against the parent integration context;
4. integrate one verified range from one worker at a time;
5. run the relevant verification gate after each integration;
6. stop on conflict, divergence, dirty state, unverifiable evidence, or
   regression and preserve the worktree for diagnosis.

Unchanged clean worktrees are eligible for automatic cleanup when their
worker is torn down. Worktrees with commits or dirty files are retained for
review. Cleanup policy does not convert any state into integration approval.

For changes needing a durable autonomous pipeline, use the verified-change
workflow rather than inventing merge logic in the coordinator. Its worktree,
effect journal, verification fan-out, independent review, and sealed evidence
are the stronger integration primitive.

## Evaluation gate

Agent-count changes are experimental claims, not defaults. This is AgenC's
local protocol, not a result reported by the external papers below.

Before a run, freeze the repository/base commit, task definitions and expected
artifacts, provider/model, prompt/tool surface, permission and sandbox modes,
token/model-call budget, timeouts, topology policy, and success oracle.
Preregister the primary verified-success measure, non-inferiority margin,
efficiency measure, exclusions, and zero-tolerance trust failures.

| Axis | Required cells |
| --- | --- |
| Topology | sequential, adaptive, forced 2-agent, forced 4-agent |
| Task class | coupled fix, modular implementation, multi-area audit, research synthesis |
| Dependency structure | longest dependent chain, intermediate results carried across steps, fan-in/aggregation breadth, independent parallel components, adversarial or incorrect intermediate evidence |
| Isolation | shared workspace, worktree for otherwise-equivalent writable cells |
| Outcome | verified success, regression, incomplete, infrastructure failure |
| Efficiency | wall time, input/output tokens, tool calls, model calls |
| Coordination | accepted/completed/errored/interrupted/NACK counts, duplicate work, stale replay, lost wake, conflict, orphaned worker |
| Trust | missing/duplicate task receipt, correlation mismatch, required-context omission, out-of-role leakage, ownership violation, provenance failure, permission bypass, worktree escape, branch-as-ref use, unverified integration attempt |

Use paired tasks and seeds where the provider permits them. Three repetitions
per cell are only a smoke minimum, not a claim of statistical sufficiency;
choose the final sample size from a power analysis or report the study as
exploratory. Preserve raw per-task cells and report paired differences with
uncertainty intervals appropriate to the sample size. Separate model/task
failures from infrastructure failures.

Verified success must come from a task-specific oracle such as tests, type
checks, artifact validation, or human review recorded before topology is
revealed. A worker's self-report and a `completed` receipt are not success
oracles.

Never promote a topology from one small pass and never collapse quality, cost,
latency, and trust into one opaque score. The adaptive policy should become a
default only when it is non-inferior on preregistered verified success,
improves at least one preregistered efficiency measure, and introduces no
zero-tolerance trust regression.

## Published benchmarks and current research evidence (external)

These sources motivate design questions; they are not AgenC evaluations.
AgenC has not reproduced, matched, or inherited any reported result merely by
implementing a similar mechanism. Venue status is stated explicitly; this is a
selected evidence set, not an exhaustive literature review.

### Quantitative anchors

The values below were rechecked against the linked primary PDFs on
2026-07-22. Rows use different tasks, models, budgets, and metrics and are not
cross-study leaderboard entries.

| Source / metric | Exact reported value | Evaluated task or subset | Primary location | Material limitation |
| --- | --- | --- | --- | --- |
| CAID, workspace-isolation ablation | PaperBench score: single agent `57.2`; multi-agent soft/shared isolation `55.5`; CAID worktree isolation `63.3` | PaperBench Code-Dev, Claude Sonnet 4.5, 20-paper aggregate | Table 3, PDF p. 6; per-paper Table 7, p. 21 | One framework, model, judge, task set, and fixed budget; it isolates neither every CAID component nor AgenC's implementation |
| Scaling Agent Systems, sequential planning | Relative to single-agent mean `0.568`: Independent `-70.0%` (`0.170`), Centralized `-50.3%` (`0.282`), Decentralized `-41.5%` (`0.332`), Hybrid `-39.1%` (`0.346`) | PlanCraft, 100 instances per configuration | Figure 2, PDF p. 11; §4.2, p. 13 | Architecture means over the paper's models and matched-compute setup; not an agent-count-only ablation |
| Scaling Agent Systems, software engineering | Relative to single-agent mean `0.522`: Independent `-14.9%` (`0.444`), Decentralized `-5.4%` (`0.494`), Centralized `-3.1%` (`0.506`), Hybrid `-2.1%` (`0.511`) | SWE-bench Verified, 20-instance subset per configuration | §4.2, PDF p. 14; per-model 95% bootstrap CIs in Table 16, p. 43 | The 20-instance cells have wide intervals; aggregate directional means do not make every model comparison significant |
| MASBENCH, controlled axis coverage | Axis values `2–12`; train/test splits: Depth `3,993/1,195`, Horizon `2,174/567`, Breadth `2,000/676`, Parallel `1,807/567`, Robustness `3,000/600` | Dependency-graph tasks controlling depth, carried intermediates, fan-in, independent components, and adversarial notes | §4.2, PDF p. 6 | Primarily synthetic iGSM-derived reasoning tasks; Robustness is instantiated only on Depth `4`; the evaluated system trains an orchestrator rather than applying AgenC's static advisory policy |
| Multi-Agent Teams Hold Experts Back, strong-synergy gap | Relative gap to the At-Least-One-Correct oracle: `6.3%` MMLU Pro, `14.4%` GPQA Diamond, `18.1%` SimpleQA, `41.1%` HLE Text-Only, `20.3%` MATH-500 | 100 problems per benchmark; heterogeneous four-model deliberative teams | Table 2, PDF p. 7 | The comparator is an oracle over member answers, and conversational self-organization is not dependency-decomposed software execution |
| TeamBench, enforcement and verifier audit | Verifier edit attempts `256` prompt-only vs `72` enforced (`3.6×`); pass rate `42.7% [34.7, 50.0]` vs `40.5% [32.4, 48.6]`, adjusted outcome-test `p=0.907`; pooled verifier false-accept rate `49.4%` | Enforcement comparison: 148 paired observations from a 25-task, two-seed, three-family design; false accepts: 1,083 role-mixing runs with valid attestation and grader result | §3.6, PDF p. 7; Table 6, p. 17; Table 18, p. 30 | Pass rate was statistically indistinguishable; 942 role-mixing runs lacked valid attestations, and counting those as failures lowers the effective false-accept rate to `22.3%` |
| PerspectiveGap, prompt-boundary quality | Mean combined strict pass `17.2%` (best model `62.0%`); all-model mean overall leakage `217.9%` | 33 models × 110 scenarios × two shuffle seeds × two prompt-construction tasks = 14,520 evaluations | §1, PDF p. 2; §5, p. 6; Table 5, p. 8 | It evaluates generated prompt artifacts, not worker execution; leakage is an event count per scenario and may exceed 100%, not a probability |
| Software Delegation Contracts, reviewability/cost | Evidence sufficiency `3.90 → 4.73` (`+0.83` on a five-point scale; 22 improved/0 worsened of 30 pairs); agent tokens `+13.0%`; wall time `+38.3%` | 64 runs over ten small TypeScript tasks; 30 matched baseline/contract pairs plus four evidence-bundle previews | Table 1, PDF p. 6; §4.4 cost table, p. 7 | All 64 runs passed hidden checks with zero scope violations, so the pilot shows reviewability/cost effects, not correctness improvement |
| MAST, observed system failure | Failure rate `41.0%–86.7%` across the six plotted system/benchmark cells; taxonomy data contains 1,642 traces from seven frameworks | Heterogeneous coding, math, and general-agent benchmarks | Figure 5, PDF p. 19; Table 1, p. 3 | Figure cells use different benchmarks and are explicitly not directly comparable; most large-scale failure labels use a calibrated LLM annotator |
| AgentLocate, failure localization | With Qwen-7B/all-at-once: agent-level accuracy `69.05%`, step-level accuracy `38.10%` | Who&When Algorithm-Generated test split | Table 1, PDF p. 7 | A trained attribution pipeline on one synthetic subset; it is not part of AgenC and exact-step accuracy remains far below complete reliability |

### Effective Strategies for Asynchronous Software Engineering Agents

[Geng and Neubig, arXiv:2603.21489
(v2, July 2026 preprint)](https://arxiv.org/abs/2603.21489v2) introduce
Centralized Asynchronous Isolated Delegation (CAID). The evaluated tasks are
Commit0-Lite (Python library implementation) and the Code-Dev protocol of
PaperBench (research-paper reproduction), using a central manager and isolated
engineer worktrees.

The paper directly supports studying dependency-aware delegation,
asynchronous worktrees, and explicit commit/merge/test integration. In its
reported PaperBench isolation ablation, shared-workspace “soft isolation”
scored below its single-agent baseline, while worktree isolation scored above
it. Its engineer-count study was non-monotonic.

Scope limits: this is a software-engineering study with its own models,
budgets, prompts, manager, benchmarks, and substantially different runtime and
cost profiles. It does not establish that every task benefits from CAID, that
four workers are optimal for AgenC, or that a worktree alone makes integration
safe.

### Towards a Science of Scaling Agent Systems

[Kim et al., arXiv:2512.08296
(v3, April 2026 preprint)](https://arxiv.org/abs/2512.08296v3) compare one
single-agent and four multi-agent architectures across 260 configurations on
Finance-Agent, BrowseComp-Plus, PlanCraft, WorkBench, SWE-bench Verified, and
Terminal-Bench. The study reports strong task/architecture dependence: every
tested multi-agent architecture degraded sequential PlanCraft performance,
while centralized coordination helped decomposable financial reasoning.

The source supports conservative, task-structure-aware topology selection. It
does not provide a universal “more agents” law. Its SWE-bench Verified and
Terminal-Bench evaluations use 20-instance subsets; the paper reports wide
per-cell bootstrap intervals and cautions that individual comparisons are
underpowered. Architecture comparisons are not the same experiment as
increasing an otherwise-identical agent count.

### MAS-Orchestra and MASBENCH

[Ke et al., ICML 2026, arXiv:2601.14652
(v5)](https://arxiv.org/abs/2601.14652v5) introduce MASBENCH, a controlled
benchmark whose dependency graphs vary Depth, Horizon, Breadth, Parallel, and
Robustness, plus MAS-Orchestra, a reinforcement-learned system that selects a
whole multi-agent structure. Their controlled results are task- and
model-capability-dependent: with the weaker evaluated sub-agent, the trained
multi-agent system improved most tested structures except strongly sequential
Depth; with the stronger sub-agent, gains diminished across Depth, Horizon,
Breadth, and Parallel.

This supports measuring dependency structure and a single-agent baseline
instead of treating task difficulty as sufficient evidence for fan-out. It
also supports testing adversarial intermediate information separately from
ordinary correctness. MASBENCH is primarily synthetic mathematical reasoning,
and MAS-Orchestra is a trained orchestration policy with its own agents,
verifiers, compute, and Avg@8 metric. It neither validates AgenC's regex policy
nor establishes its agent-count ceilings.

### Multi-Agent Teams Hold Experts Back

[Pappu et al., accepted at ICML 2026,
arXiv:2602.01011 (v4)](https://arxiv.org/abs/2602.01011v4) evaluate
self-organizing, deliberative teams on human-inspired decision tasks and five
frontier-model benchmarks. The teams consistently failed to match the paper's
per-problem At-Least-One-Correct expert oracle, even when told which agent had
the most expertise for that problem. The study attributes the main gap to poor
expert leveraging and finds that consensus-seeking can dilute expertise as
team size grows.

This cautions against treating open peer deliberation or majority compromise
as a reliable synthesis method. For AgenC, it motivates evaluating explicit
task ownership, provenance-preserving coordination, and independent
task-specific verification; those mechanisms were not tested by this paper.
The experiments study heterogeneous conversational teams, not
dependency-decomposed software workers, and also find a robustness benefit
from consensus when one member is adversarial. They do not prove that every
multi-agent coding task should defer to one worker.

### TeamBench

[Kim et al., arXiv:2605.07073
(v1, May 2026 preprint)](https://arxiv.org/abs/2605.07073v1) evaluate
coordination under OS-enforced Planner/Executor/Verifier role separation using
851 task templates and 931 seeded instances. Prompt-only and sandbox-enforced
teams had statistically indistinguishable pass rates, yet prompt-only runs had
3.6 times more verifier attempts to edit executor code. The deterministic
grader also rejected many verifier-approved submissions.

This directly supports measuring policy violations and independent
verification rather than relying on aggregate pass rate or role prompts alone.
It does not show that AgenC's role/sandbox boundary has the same behavior, and
its preprint results do not establish that every task needs three roles.

### PerspectiveGap

[Sun et al., arXiv:2606.08878
(v2, July 2026 preprint)](https://arxiv.org/abs/2606.08878v2) test whether a main
model gives each worker the context and handoff constraints that role needs
without leaking distractors or out-of-role information. The benchmark has 110
scenarios, two prompt-construction tasks, and ten loop-centered topologies,
with deterministic scoring and a hand audit of the containment detector.

This supports self-contained, role-scoped delegation prompts and explicit
write/handoff ownership. It evaluates prompt artifacts, not downstream worker
execution; its authors note limited topology coverage, internally audited
reference mappings without external-annotator agreement, and a scorer that
can penalize paraphrases. It therefore motivates an AgenC prompt-boundary eval
cell, not a claim that clean forks or role prompts are already sufficient.

### Software Delegation Contracts

[Schmalbach, arXiv:2606.17099
(v1, June 2026 preprint)](https://arxiv.org/abs/2606.17099v1) reports a
controlled pilot of explicit coding-agent delegation contracts: task,
authority, returned work package, and acceptance context. Across 64 executions
of ten small TypeScript tasks, adding a contract and required evidence bundle
did not improve objective task outcomes in a ceiling-saturated sample, but did
improve blinded reviewers' evidence-sufficiency and ambiguity measures. It
also increased token and wall-clock cost.

This supports self-contained assignment prompts, explicit authority/write
sets, declared acceptance checks, and structured evidence receipts. The pilot
uses one dependency-free environment, two model tiers, model-based reviewers,
and only tasks that all passed hidden acceptance checks. It demonstrates a
reviewability trade-off, not a correctness gain or a universal prompt format.

### Who Broke the System?

[Xia et al., to appear at COLM 2026,
arXiv:2607.07989 (v1)](https://arxiv.org/abs/2607.07989v1) study attribution of a
multi-agent failure to both an agent and its earliest decisive trajectory
step. Their AgentLocate method combines an LLM judge with independent
multi-perspective verification and evaluates it on two benchmarks.

This supports retaining correlated per-agent, per-turn trajectories rather
than only a final team answer. AgenC's durable outcome record and task/turn
IDs make later localization possible; they do not perform AgentLocate's
inference or validate the paper's attribution method. An LLM diagnosis must
remain secondary to deterministic task evidence and direct trajectory review.

### Why Do Multi-Agent LLM Systems Fail?

[Cemri et al., NeurIPS 2025 Datasets and Benchmarks,
arXiv:2503.13657 (v3)](https://arxiv.org/abs/2503.13657v3) build MAST from more than
1,600 annotated traces across seven multi-agent frameworks. Its 14-mode
taxonomy includes step repetition, loss of conversation history, task
derailment, ignored peer input, termination-condition failures, premature
termination, and incomplete or incorrect verification.

The paper supports explicit lifecycle, correlation, termination, and
verification instrumentation. Its case studies indicate that many failures
stem from system design and that topology changes can outperform prompt-only
interventions. The taxonomy is empirical, not exhaustive; it combines human
analysis with a calibrated LLM annotator and does not prove that any one AgenC
mechanism eliminates a failure class.

### Beyond the Leaderboard

[Albayaydh et al., arXiv:2607.05775
(v1, July 2026 preprint)](https://arxiv.org/abs/2607.05775v1) synthesize 27
benchmark, taxonomy, and audit papers spanning 19 benchmarks. Their
cross-cutting taxonomy covers tool invocation, planning and constraints,
long-horizon context degradation, multi-agent coordination, safety/security,
and measurement validity. The synthesis reports compounding failures with
task length and warns that strong subtask results need not produce end-to-end
success.

This reinforces an evaluation that records the trajectory, trust failures,
resource use, and verified end result separately. It is a qualitative
cross-paper synthesis, not a controlled AgenC experiment; its inputs use
different agents, tasks, metrics, and failure taxonomies.

### MultiAgentBench

[Zhu et al., ACL 2025,
DOI 10.18653/v1/2025.acl-long.421](https://aclanthology.org/2025.acl-long.421/)
evaluate multi-agent collaboration and competition across research,
Minecraft, database analysis, coding, bargaining, and Werewolf scenarios. In
addition to task scores, the benchmark records milestone-based progress and
communication/planning coordination measures across several topologies and
planning strategies.

The paper supports measuring the coordination process as well as final task
performance. Some scenario scores and coordination measures use LLM-based
rubrics, the environments differ from repository integration, and its results
do not validate AgenC's router or receipt protocol.

## AgenC design synthesis (inference)

The following is AgenC's engineering inference from the external evidence, not
a claim made or validated jointly by those papers: require explicit
parallelism, or explicit independence plus a syntactic task list, before
fan-out; keep the recommended topology small; isolate parallel writes; make
accepted work and terminal outcomes correlated and durable; integrate only an
immutable, verified `base_commit..integration_ref` range; and evaluate both
the answer and the process that produced it.
