# Cost-bounded autonomy: budget enforcement design

**Task 15.** A daemon-owned budget layer that bounds what **cumulative-wired
autonomous surfaces** (heartbeat, cron delivery, hooks HTTP) can spend, so AgenC
never reproduces the idle-burn failure mode. Background agent runs use
**per-run** caps only (not this cumulative ledger) — see Live wire-up below.
This note records the SOTA research the design is grounded in and the decisions
that follow from it.

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
  computes the worst-case debit at the model's price and checks it against
  BOTH remaining daily and monthly budget (both must pass — fail closed).
  Returns a hold on success, or a typed `BUDGET_EXCEEDED` refusal.
- **Reconcile** — `reconcile(hold, actualUsage)` replaces the held estimate with
  the real spend and refunds the delta. The real `usage` from the provider
  response is authoritative (pre-flight estimates drift; §4). After a successful
  admit, call sites **always** reconcile exactly once (prefer `try`/`finally`):
  success uses returned usage (or zeros if missing); throw uses zeros → full
  hold refund. Unknown usage may under-book real spend; it must not leave a
  sticky worst-case hold (GW-06/07; hooks/cron/heartbeat parity).
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

## Live wire-up (current as of 0.6.0)

The enforcer primitive is **implemented and live** on the autonomous gateway
surfaces. Callers construct a `BudgetEnforcer` with
`resolveBudgetPolicy` + `BudgetLedger` + `createModelPriceResolver`, then
`admit` → turn → `reconcile`. When budget is disabled, admit is a no-op hold.

### Wired (cumulative ledger)

| Surface | Path | Agent id | On refuse |
| --- | --- | --- | --- |
| **Heartbeat** | `heartbeat/wire.ts` builds enforcer; `heartbeat/runner.ts` admits before the turn and reconciles after | policy `agent` (default `default`) | Deliver pause notice to heartbeat target; skip turn (`budget_paused`) |
| **Cron delivery** | `gateway/cron-delivery.ts` | `cron:<taskId>` | Log + optional channel pause notice; skip turn |
| **Hooks HTTP** | `gateway/hooks.ts` | `hook:<name>` | HTTP **429** with budget error; no turn |

All three mark turns `autonomous: true` and **deny** tool permission requests.
Rough token estimates use chars/4; max output for pre-flight defaults to
**2048** tokens on these paths.

### Not cumulative-wired

| Surface | What bounds spend today |
| --- | --- |
| Interactive TUI / print turns | Session-level cost tools only unless `enforce_interactive` is enabled **and** a caller actually invokes `BudgetEnforcer` on that path (the interactive turn loop is **not** currently admit/reconcile-wired) |
| Background agent runs (`background-agent-runner`) | **Per-run** `AgentBudgetConfig` only (`token_cap` / `dollar_cap` / `wall_clock_seconds`) — does **not** call `BudgetEnforcer` |

So: enabling `[budget]` protects heartbeat / cron delivery / hooks. It does
**not** by itself put a daily envelope around interactive chat or
`agent.create` background jobs. Operators who need those bounds use
`[agent.budget]`, session `max_budget_usd`, and/or future wire-ups.

### Primitive modules

| Module | Role |
| --- | --- |
| `budget/enforcer.ts` | `admit` / `reconcile` / pause / soft-warn |
| `budget/ledger.ts` | Persistent per-agent windows → `budget/ledger.json` |
| `budget/config.ts` | env > config > default policy resolution |
| `budget/pricing.ts` | Model price resolver for worst-case debit |
| `bin/budget-cli.ts` | `agenc budget status\|reset` |

### Deferred (still accurate)

- *Per-model-call* pre-flight gate on the single LLM call path (§3) — needs
  `stream-model` plumbing; per-turn is the pragmatic cut in production today.
- *Velocity circuit-breaker* and *loop/duplicate-turn detector*.
- *Delegation conservation* — sub-agent debit from parent (Agent Contracts §2).
- *Cheap-utility-model routing + outcome-based escalation* (§6) — heartbeat
  carries `policy.model` but full per-turn model override on the daemon session
  is still a cost-reduction follow-up; the **cap** is the safety boundary and
  is live.
- *Reasoning-token budget forcing* (§7).
- Cumulative wire-up for interactive turns and background-agent runs (when
  product wants one ledger across all spend, not only gateway autonomy).

## Citations

BAGEN 2606.00198 · Agent Contracts 2601.08815 · Token Budgets (incident
catalog) 2606.04056 · Is Escalation Worth It? 2605.06350 · FrugalGPT
2305.05176 · RouteLLM 2406.18665 · BEST-Route 2506.22716 · s1 2501.19393 ·
TALE 2412.18547 · Certaindex/Dynasor 2412.20993 · Don't Overthink It
2505.17813 · Stop Overthinking survey 2503.16419 · Heartbeat Scheduling
2604.14178 · Inference-Time Budget Control 2605.05701 · BATS 2511.17006 ·
Workflow Tradeoffs 2605.23929. Practitioner: Claude Code cost docs, Stripe
Agent Toolkit / Google AP2, TrueFoundry/RelayPlane gateway enforcement.
