# Cost-bounded autonomy: budget enforcement design

> **Historical design.** The surface-specific `BudgetEnforcer` / JSON ledger
> described below has been superseded in production by the daemon-owned
> [execution admission kernel](execution-admission-kernel.md). The research and
> original rationale remain useful, but gateway heartbeat, cron, and hooks no
> longer construct this second accounting engine.

**Task 15.** This note records the research that motivated cost-bounded
autonomy and the original implementation decisions.

Operator-facing summary of live surfaces:
[`../reference/autonomy.md`](../reference/autonomy.md).

## What the literature says (2023-2026)

Three surveys of the field converge on one architecture. Full citations at the
end; the load-bearing findings:

1. **Enforce externally — never trust the model to police its own spend.**
   *BAGEN* (arXiv:2606.00198) shows frontier agents are systematically
   over-optimistic about remaining budget: they keep spending on doomed
   trajectories and only declare a task infeasible after most of the budget is
   gone (feasibility stays >70% at 60% burn). Budget-awareness barely
   correlates with task skill (r≈0.35) and reaches only ~47% interval
   calibration even after SFT+RL. The daemon must be the meter and the gate.

2. **Budget is a first-class enforced contract, not a prompt.** *Agent
   Contracts* (arXiv:2601.08815) models resource caps (tokens, dollars,
   tool-call and wall-clock quotas) as machine-checkable commitments with
   continuous monitoring, interrupts on breach, graceful degradation, and a
   **conservation law**: a sub-agent's budget is debited from the parent's
   remaining envelope, so team fan-out can't multiply spend past the cap.

3. **The gate is a pre-flight admission check; post-hoc accounting is
   reconciliation, not control.** Monitoring ≠ enforcement — a spend alert
   fires *after* the money is spent (practitioner consensus; TrueFoundry,
   RelayPlane). The *Token Budgets* incident catalog (arXiv:2606.04056, 63
   production overrun incidents) argues the budgeted call must be the **only
   callable path** so no code can bypass it.

4. **Debit worst-case up front, reconcile from actuals.** Before a call, debit
   `prompt_tokens + max_output_tokens` at the model's price; admit only if it
   fits remaining budget; after the response, replace the hold with the real
   `usage` and refund the delta. This makes mid-turn exhaustion structurally
   impossible — you never begin a call you can't fully afford. Cap output
   tokens per call so one call can't blow the remainder.

5. **Fail closed = pause + notify + offer explicit raise. Never silently
   downgrade.** The incident catalog and Claude Code's `/usage-credits`
   pattern agree: on cap hit, reject with a typed error, pause autonomy, tell
   the human, and let them raise/resume — do **not** quietly swap to a cheaper
   model (it hides the boundary). Cheap-model defaults are a *cost-reduction*
   lever, orthogonal to the *safety* boundary.

6. **Cheap-utility-model-by-default for autonomous turns, two tiers, route by
   turn class up front.** Autonomous idle overhead (heartbeat + bootstrap
   re-injection) is where the money actually leaks, not useful work. *Is
   Escalation Worth It?* (arXiv:2605.06350) shows **pre-generation routing
   beats cascades on 4/5 benchmarks** — deciding the tier before generating
   avoids paying for the cheap call at all. And you already know the turn class
   (heartbeat/cron vs user-facing), which is exactly the difficulty signal that
   whole router models are built to recover (BEST-Route, RouteLLM). So: route
   by turn class, two tiers only, escalate on **outcome** signals (a tool
   failure, a high-stakes/mutating action) — never on the model's self-reported
   confidence (consistently miscalibrated across the literature).

7. **The cost-quality curve is steep then flat.** Repeatedly, 30-70% of
   tokens/cost can be cut for low-single-digit quality loss (TALE 67%/-2.7pp;
   Certaindex 11-29%/0; s1 budget-forcing; FrugalGPT up to 98% on narrow
   tasks). Aggressive budgeting is usually free or positive-EV, not a tax.

8. **Always-on cost bounding is an open research gap.** The one heartbeat
   scheduling paper (arXiv:2604.14178) explicitly excludes cost as a goal. So
   the *enforcement* machinery is borrowed from the resource-bounded papers
   (1-5) and the agent-payments world (hard credential cap + soft policy +
   audit, e.g. Stripe Issuing / Google AP2 Mandates), not from proactive-agent
   work. We are slightly ahead of the literature here.

## Design decisions (what we build)

A self-contained subsystem, `runtime/src/budget/`, exposing a
`BudgetEnforcer` that autonomous surfaces call around each turn.

- **Config `[budget]`** (env > config > default, mirroring `transaction-guard`):
  per-agent `daily_usd` / `monthly_usd` hard caps, optional token caps, a
  `soft_threshold` fraction (default 0.8) for the warn-a-human tier, and an
  `enabled` flag. **Disabled by default** → zero behavior change until an
  operator opts in.
- **Ledger** — per-agent, per-window (calendar day + calendar month) cumulative
  spend, persisted to `<agencHome>/budget/ledger.json` (0600), atomic writes.
  Windows roll by date key so "daily/monthly budget" means what a user expects.
- **Admission gate** — `admit({ agentId, model, estInputTokens, maxOutputTokens })`
  transactionally reserves the worst-case debit at the model's price under the
  ledger's cross-process disk lock: the cap check (BOTH remaining daily and
  monthly budget — fail closed) runs against the locked, freshly-loaded state,
  and the debit plus a durable, uniquely-identified open hold land in ONE
  atomic save. Two concurrent reservers serialize on the lock; the second sees
  the first's debit. Returns a hold on success, or a typed `BUDGET_EXCEEDED`
  refusal.
- **Reservations** — every non-zero hold carries a `holdId` (the frozen
  `BudgetReservation.reservationId` from `contracts/run-contracts.ts`) and is
  persisted in the ledger file while open (`listOpenHolds()`). A crash between
  admit and reconcile leaves a visible open hold whose FULL reservation stays
  consumed (`held_unknown` semantics) — unknown usage is never refunded as if
  the call were free. A hold whose day window rolls before reconciliation is
  discarded without refund. Operator `reset` clears the agent's open holds.
- **Reconcile** — `reconcile(hold, actualUsage)` consumes the persisted hold
  **exactly once**: it replaces the held estimate with the real spend and
  refunds the delta in one locked transaction. The real `usage` from the
  provider response is authoritative (pre-flight estimates drift; §4).
  Duplicate calls find no open hold and are mechanical no-ops
  (`{ applied: false, reason: "duplicate" }`) — `holdId` is the idempotency
  key, so retry/recovery paths can safely call it again. Call sites reconcile
  via exclusive `try`/`finally` on **hooks, cron, and heartbeat**: success
  uses returned usage (or zeros if missing); throw uses zeros → full hold
  refund (the contract's `voided` resolution).
- **Enforcement policy** — on refusal: pause the agent's autonomy
  (`paused` state), emit a notification once, and surface the typed error; the
  operator raises the cap or resets to resume. Crossing the soft threshold
  emits a one-shot warning. **Never** silently downgrades the model (§5).
- **Scope** — enforcement applies to autonomous turns (`autonomous: true` on
  admit) by default; interactive turns are unaffected unless
  `enforce_interactive` / `AGENC_BUDGET_ENFORCE_INTERACTIVE` is set.
- **CLI** — `agenc budget status` (per-agent spend vs caps, window, state),
  read-only; `agenc budget reset <agent>` for the operator.

### Relationship to the existing per-run agent caps

The background-agent runner already enforces **per-run** caps
(`[agent] AgentBudgetConfig`: `token_cap`, `dollar_cap`, `wall_clock_seconds`)
that halt a *single* run when it exceeds a bound. Task 15 is the complementary
**cumulative daily/monthly envelope per agent** that spans runs and daemon
restarts — the layer that bounds a heartbeat firing every 30 min forever, which
no per-run cap can. The two compose: a per-run cap stops one runaway loop; the
daily/monthly cap stops the *aggregate* idle burn. We do not duplicate per-run
enforcement.

Default `[agent.budget]` is **empty** (no token/dollar/wall-clock caps) so long
foreground-style sessions are not killed by a hidden ceiling; operators who
want per-run caps set them explicitly.

## Production replacement (current as of 0.7.1)

`ExecutionAdmissionKernel` is now the sole production accounting authority.
It reserves at the actual model/charged-tool boundary, conserves child work
inside parent allocations, reconciles provider usage exactly once, and keeps
unknown usage held in project SQLite. TUI, print, daemon background sessions,
subagents, heartbeat, cron, and hooks all reach that boundary. Gateway code
only schedules and delivers; it does not estimate/debit an outer turn.

Calendar-window allocations are keyed by the durable root-agent/run identity,
so independent agents in one project do not consume one another's cap while
all descendants of an agent share its envelope. A durable run identity is
pinned to its project state database; rebinding it to another workspace fails
closed instead of creating a second copy of the same daily/monthly allowance.

The old `BudgetEnforcer` and `BudgetLedger` modules remain for isolated legacy
tests/evaluation compatibility, not as a live gateway gate. `agenc budget
status` reports configured policy only, and `agenc budget reset` is rejected.
Operators inspect immutable durable state with `agenc run
status|replay|evidence` and stop work with `agenc run cancel`.

## Citations

BAGEN 2606.00198 · Agent Contracts 2601.08815 · Token Budgets (incident
catalog) 2606.04056 · Is Escalation Worth It? 2605.06350 · FrugalGPT
2305.05176 · RouteLLM 2406.18665 · BEST-Route 2506.22716 · s1 2501.19393 ·
TALE 2412.18547 · Certaindex/Dynasor 2412.20993 · Don't Overthink It
2505.17813 · Stop Overthinking survey 2503.16419 · Heartbeat Scheduling
2604.14178 · Inference-Time Budget Control 2605.05701 · BATS 2511.17006 ·
Workflow Tradeoffs 2605.23929. Practitioner: Claude Code cost docs, Stripe
Agent Toolkit / Google AP2, TrueFoundry/RelayPlane gateway enforcement.
