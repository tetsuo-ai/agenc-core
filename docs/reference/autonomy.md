# Autonomy reference

Operator and developer guide for **cost-bounded autonomous surfaces** in
AgenC **0.3.0**: cumulative budget enforcement, heartbeat, cron delivery, and
hooks HTTP.

Design background: [`../design/budget-enforcement.md`](../design/budget-enforcement.md).
Architecture map: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Gateway
channels: [`../gateway.md`](../gateway.md).

## Mental model

Autonomous turns run **without a human watching**. AgenC treats them as
spend-sensitive:

1. **Pre-flight admit** against a per-agent daily/monthly ledger (when budget
   is enabled).
2. **Run the turn** on a daemon-owned session (gateway is a daemon client).
3. **Reconcile** real usage against the held estimate.
4. On hard-cap breach: **pause** that agent id, **notify** once, **never**
   silently downgrade the model or spend past the cap.

Permission posture for heartbeat, cron delivery, and hooks: **deny** tool
permission requests (fail safe). Channel text and hook payloads are
sanitized/framed as untrusted content before they reach the model.

## What is wired today

| Surface | Module | Budget agent id | Cumulative `BudgetEnforcer` |
| --- | --- | --- | --- |
| Heartbeat | `runtime/src/heartbeat/` (`wire.ts`, `runner.ts`) | policy `agent` (default `default`) | **Wired** |
| Cron delivery | `runtime/src/gateway/cron-delivery.ts` | `cron:<taskId>` | **Wired** |
| Hooks HTTP | `runtime/src/gateway/hooks.ts` | `hook:<name>` | **Wired** (HTTP **429** on refuse) |
| Interactive TUI / print | `session/` turn loop | n/a | **Not** cumulative-wired — no `BudgetEnforcer.admit` on this path today |
| Background agents | `app-server/background-agent-runner.ts` | n/a | **Not** cumulative-wired — **per-run** `[agent.budget]` only |

Defaults: **budget disabled**, **heartbeat disabled**. Enabling either is an
explicit operator action.

---

## Budget (`runtime/src/budget/`)

### Policy

Resolved **env > config > default** (`budget/config.ts`).

```toml
# ~/.agenc/config.toml
[budget]
enabled = true
daily_usd = 5.0
monthly_usd = 50.0
# daily_tokens = 2_000_000
# monthly_tokens = 20_000_000
soft_threshold = 0.8          # warn at 80% of a dollar window
enforce_interactive = false   # reserved flag — interactive path not wired yet
```

| Env | Effect |
| --- | --- |
| `AGENC_BUDGET` | `on`/`1`/`true` enables; other values disable |
| `AGENC_BUDGET_DAILY_USD` | Daily dollar hard cap |
| `AGENC_BUDGET_MONTHLY_USD` | Monthly dollar hard cap |
| `AGENC_BUDGET_DAILY_TOKENS` | Daily token hard cap |
| `AGENC_BUDGET_MONTHLY_TOKENS` | Monthly token hard cap |
| `AGENC_BUDGET_SOFT_THRESHOLD` | Soft-warning fraction in `[0,1)` |
| `AGENC_BUDGET_ENFORCE_INTERACTIVE` | Sets policy flag only; **TUI/print still do not call** `BudgetEnforcer` |

### Ledger

Path: **`$AGENC_HOME/budget/ledger.json`** (mode **0600**, atomic write).

Per agent id: calendar **day** + **month** USD and token spend, `paused` flag,
one-shot soft-warning markers. Windows roll by date keys (`YYYY-MM-DD` /
`YYYY-MM`).

### Admit / reconcile

`BudgetEnforcer.admit({ agentId, model, autonomous, estInputTokens, maxOutputTokens })`:

- Out of scope when disabled or when the call is non-autonomous and
  `enforce_interactive` is false. Interactive turns still never call admit
  today even if the flag is true.
- Refuses if already `paused` or worst-case debit would exceed **any** set cap
  (fail closed on both day and month).
- Debits worst-case **est input + max output** priced via the model price
  resolver; unpriced models still enforce token caps, not dollar caps.

`reconcile(hold, usage)` refunds estimate − actual and may emit a soft
warning.

### CLI

```bash
agenc budget status           # policy + per-agent spend / paused
agenc budget status --json
agenc budget reset <agent>    # clear spend + un-pause that agent id
```

Examples of agent ids you may see: `default` (heartbeat), `cron:…`, `hook:…`.

### Relationship to per-run agent caps

`[agent.budget]` (`token_cap`, `dollar_cap`, `wall_clock_seconds`) bounds a
**single** background-agent run. Defaults are empty (no cap) so long
interactive-style sessions are not killed by a hidden ceiling. Cumulative
daily/monthly budget is the layer that stops idle forever-fire; it is
**orthogonal** and only live on the autonomous surfaces listed above.

---

## Heartbeat (`runtime/src/heartbeat/`)

Proactive ticks driven from **gateway run** when enabled. Disabled by
default.

### Policy

```toml
[heartbeat]
enabled = true
interval_seconds = 1800     # default 1800 (30 min)
# model = "…"               # optional utility model override (cost-reduction; see notes)
# active_hours = [8, 22]    # [start, end) local 24h; omit = always
skip_when_busy = true
agent = "default"           # budget envelope + session label
# target_channel = "telegram"
# target_conversation = "12345"
```

| Env | Effect |
| --- | --- |
| `AGENC_HEARTBEAT` | Enable/disable |
| `AGENC_HEARTBEAT_INTERVAL` | Seconds between ticks |
| `AGENC_HEARTBEAT_MODEL` | Utility model string |
| `AGENC_HEARTBEAT_ACTIVE_HOURS` | `8-22` or `always` |
| `AGENC_HEARTBEAT_TARGET` | `none` or `<channelId>:<conversationId>` |
| `AGENC_HEARTBEAT_AGENT` | Agent id for budget + session (default `default`) |

### Workspace file

Each tick reads **`HEARTBEAT.md`** from the gateway workspace directory
(`WorkspaceHeartbeatFileReader`). If the file is missing or empty, the tick
is skipped (`no_heartbeat_file`) — no model call.

### Tick pipeline (`HeartbeatRunner`)

1. Gates: enabled, active hours, cron-running defer, skip-when-busy.
2. Read `HEARTBEAT.md`.
3. **Budget admit** (autonomous). On refusal → deliver a pause notice to the
   target (if any); **do not** run the turn.
4. Run turn on a **persistent daemon session** (id stored under
   `$AGENC_HOME/gateway/heartbeat-session`, mode 0600). Permissions: **deny**.
5. If the model replies with exactly `HEARTBEAT_OK` (or empty) → suppress
   delivery; otherwise deliver to the configured channel target.
6. **Reconcile** budget from real usage.

### Notes

- Heartbeat starts only when `resolveHeartbeatPolicy(...).enabled` is true
  (`startHeartbeat` returns `null` otherwise).
- Utility-model **routing** is carried in `policy.model` for the runner, but
  applying a cheaper model to the live daemon turn still depends on a
  per-turn model seam; the **budget cap** is the live safety boundary either
  way (see design note §6 deferred cost-reduction).

---

## Cron delivery (`runtime/src/gateway/cron-delivery.ts`)

Runs **delivery-tagged** cron tasks (`CronTask.deliver` set) in isolated
gateway daemon sessions. The in-session cron scheduler **skips** those tasks
so a fire is never double-run.

### Scheduling

- Sleep until earliest due time, with scan cap **5 minutes**
  (`CRON_DELIVERY_SCAN_CAP_MS`) so tasks added by other processes are noticed.
- Source file: workspace **`.agenc/scheduled_tasks.json`**.
- Past-due schedules coalesce to **one** fire; stamps `lastFiredAt` / removes
  one-shots.

### Per fire

1. Resolve channel adapter and/or webhook from `task.deliver`.
2. **Budget admit** with `agentId = cron:<taskId>`, `autonomous: true`. On
   refusal: log + optional channel pause notice; no turn.
3. `SessionRouter.runTurn` with permission requests **denied**.
4. **Reconcile** usage; optional webhook POST of the result payload.

`isRunning()` is exposed so heartbeat can defer while a cron delivery turn is
in flight.

---

## Hooks HTTP (`runtime/src/gateway/hooks.ts`)

Automation entry point: **`POST /hooks/agent`**. Not a conversation surface —
no pairing dance; the **bearer token is the auth**.

### Security posture

| Control | Behavior |
| --- | --- |
| Default | **Disabled** until gateway config / `--hooks` + token |
| Bind | Loopback; **refuses** non-loopback host without `allowNonLoopback` |
| Auth | `Authorization: Bearer <token>` only; **query tokens rejected** (401) even if header is valid |
| Token length | Minimum **16** characters |
| Payload | Untrusted: sanitize + frame before `session.prompt` |
| Permissions | **Deny** all tool permission requests |
| Budget | Admit → turn → reconcile; refusal → **HTTP 429** |
| Body / message caps | 64 KiB body; 32 KiB message chars |

Default port when enabled without an explicit port: **8377**
(`HOOKS_DEFAULT_PORT`). Path: `/hooks/agent`. Channel id: `hooks`.

### Request shape

```http
POST /hooks/agent
Authorization: Bearer <token>
Content-Type: application/json

{
  "message": "deploy finished; summarize failures",
  "name": "ci",
  "agent": "default",
  "sessionKey": "deploys",
  "deliver": { "channel": "telegram", "to": "<chat id>" }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `message` | yes | Prompt text |
| `name` | no | Hook identity (budget id `hook:<name>`, peer id) |
| `agent` | no | Session-scope label (default `default`) |
| `sessionKey` | no | Continuity key — same key reuses the daemon session |
| `deliver` | no | If set → **202** and async channel delivery; else wait and **200** with result |

Identifier fields (`name` / `agent` / `sessionKey`) must match
`^[A-Za-z0-9._-]{1,128}$`.

---

## Operator checklist

1. Set provider credentials (`agenc onboard` or env keys).
2. Enable budget **before** leaving heartbeat/hooks/cron unattended:

   ```toml
   [budget]
   enabled = true
   daily_usd = 5
   monthly_usd = 30
   ```

3. Optional heartbeat: write workspace `HEARTBEAT.md`, set
   `[heartbeat] enabled = true`, run `agenc gateway run` with the target
   channel up.
4. Optional hooks: enable hooks on gateway with a long random token; never put
   the token in query strings; prefer loopback + SSH/tailnet.
5. Monitor and recover:

   ```bash
   agenc budget status
   agenc budget reset default
   agenc budget reset cron:<id>
   agenc budget reset hook:ci
   ```

6. Background agents remain separate: set `[agent.budget]` for per-run caps if
   needed; they do **not** automatically share the cumulative ledger.

## Source map

| Concern | Path |
| --- | --- |
| Budget enforcer / ledger / config | `runtime/src/budget/` |
| Budget CLI | `runtime/src/bin/budget-cli.ts` |
| Heartbeat policy / runner / wire | `runtime/src/heartbeat/` |
| Cron delivery | `runtime/src/gateway/cron-delivery.ts` |
| Hooks server | `runtime/src/gateway/hooks.ts` |
| Session routing | `runtime/src/gateway/session-router.ts` |
| Config schema `[budget]` / `[heartbeat]` | `runtime/src/config/schema.ts` |
| Per-run agent budget | `runtime/src/app-server/background-agent-runner.ts`, `AgentBudgetConfig` |
| Lifecycle hooks (PreToolUse etc.) | `runtime/src/hooks/` (session hooks; distinct from gateway Hooks HTTP) |
