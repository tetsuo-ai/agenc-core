# Autonomy reference

Operator and developer guide for **cost-bounded autonomous surfaces** in
AgenC **0.6.0**: daemon-owned execution admission, heartbeat, cron delivery,
and hooks HTTP.

Design background: [`../design/execution-admission-kernel.md`](../design/execution-admission-kernel.md).
Architecture map: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Gateway
channels: [`../gateway.md`](../gateway.md).

## Mental model

Autonomous turns run **without a human watching**. AgenC treats them as
spend-sensitive:

1. **Run on a daemon-owned session** marked as unattended for admission policy
   (gateway remains only a daemon client).
2. **Reserve** worst-case tokens/USD at each real model or charged-tool
   boundary against the run and all ancestor/window allocations.
3. **Reconcile exactly once** from authoritative usage. Unknown usage keeps
   the full hold; an overrun is explicit and cancels descendants.
4. On hard-cap breach: **deny before dispatch**, journal the decision, and
   never silently downgrade the model or spend past the cap.

Permission posture for heartbeat, cron delivery, and hooks: **deny** tool
permission requests (fail safe). Channel text and hook payloads are
sanitized/framed as untrusted content before they reach the model.

## What is wired today

| Surface | Module | Execution admission |
| --- | --- | --- | --- |
| Heartbeat | `runtime/src/heartbeat/` (`wire.ts`, `runner.ts`) | daemon session model/tool boundaries |
| Cron delivery | `runtime/src/gateway/cron-delivery.ts` | daemon session model/tool boundaries; denial notice |
| Hooks HTTP | `runtime/src/gateway/hooks.ts` | daemon session model/tool boundaries; HTTP **429** on denial |
| Interactive TUI / print | `session/` turn loop | model/tool boundaries; windows only with `enforce_interactive` |
| Background agents | `app-server/background-agent-runner.ts` | unattended policy plus `[agent.budget]` run allocation |

Defaults: **budget disabled**, **heartbeat disabled**. Enabling either is an
explicit operator action.

### Session autonomous tick mode (distinct system)

CLI flags `--autonomous` / `--proactive` enable **session keepalive** ticks
in the interactive/daemon-TUI path (`runtime/src/session/autonomous-mode.ts`).
This is **not** the same as unattended admission policy:

- Keepalive can drive idle re-prompts on a session while you leave the TUI up.
- All sessions still traverse execution admission at model/tool boundaries.
- Daemon background sessions use an explicit admission-autonomous hint that
  does not turn keepalive ticks on.
- Plan mode excludes autonomous keepalive.
- Gateway operators still use `agenc gateway run --heartbeat` / `--hooks` for
  channel/webhook autonomy with daemon-enforced caps.

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
enforce_interactive = false   # daily/monthly windows target unattended work
```

| Env | Effect |
| --- | --- |
| `AGENC_BUDGET` | `on`/`1`/`true` enables; other values disable |
| `AGENC_BUDGET_DAILY_USD` | Daily dollar hard cap |
| `AGENC_BUDGET_MONTHLY_USD` | Monthly dollar hard cap |
| `AGENC_BUDGET_DAILY_TOKENS` | Daily token hard cap |
| `AGENC_BUDGET_MONTHLY_TOKENS` | Monthly token hard cap |
| `AGENC_BUDGET_SOFT_THRESHOLD` | Soft-warning fraction in `[0,1)` |
| `AGENC_BUDGET_ENFORCE_INTERACTIVE` | Apply daily/monthly windows to interactive TUI/print calls too |

### Durable accounting

The daemon-owned execution admission kernel persists reservations,
reconciliation, allocations, cancellation locks, queue decisions, and journal
events in each project's schema-v14 SQLite database. Gateway surfaces do not
create a second ledger.

Calendar **day** and **month** token/USD scopes are ancestor allocations.
Per-run `[agent.budget]` caps join that same transactional allocation tree.

### Admit / reconcile

`ExecutionAdmissionClient.acquire(...)` runs before every real model call or
charged tool:

- It reserves estimated input plus the finite provider output bound against
  every applicable ancestor.
- Unpriced or unbounded work is denied under a hard USD cap.
- Cancellation, queueing, denial, dispatch, fallback, and settlement are
  journaled under durable run/step/reservation identities.

`reconcile(reservationId, usage)` replaces the hold exactly once. Missing
post-dispatch usage remains `held_unknown`; provider excess becomes
`provider_overrun` and stops descendants.

### CLI

```bash
agenc budget status           # configured policy (read-only compatibility)
agenc budget status --json
agenc run status <run-id>     # durable usage/reservations/tree state
agenc run evidence <run-id>   # bounded, hashed evidence
agenc run cancel <run-id> --reason "operator stop"
```

`agenc budget reset` is rejected; durable accounting is not erased or
rewritten to make capacity appear available.

### Relationship to per-run agent caps

`[agent.budget]` (`token_cap`, `dollar_cap`, `wall_clock_seconds`) bounds one
run inside the same allocation tree. Defaults are empty; daily/monthly
`[budget]` windows apply to unattended work and optionally interactive work.

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
3. Run turn on a **persistent daemon session** (id stored under
   `$AGENC_HOME/gateway/heartbeat-session`, mode 0600). Permissions: **deny**.
4. The session's model/tool boundaries reserve and reconcile through daemon
   execution admission; a denial is journaled and logged as a tick error.
5. If the model replies with exactly `HEARTBEAT_OK` (or empty) → suppress
   delivery; otherwise deliver to the configured channel target.

### Notes

- Heartbeat starts only when `resolveHeartbeatPolicy(...).enabled` is true
  (`startHeartbeat` returns `null` otherwise).
- Utility-model **routing** is carried in `policy.model` for the runner, but
  applying a cheaper model to the live daemon turn still depends on a
  per-turn model seam; the daemon admission cap remains the safety boundary.

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
2. `SessionRouter.runTurn` on an unattended daemon session with permission
   requests **denied**.
3. Model/tool calls reserve and reconcile through daemon execution admission.
   On denial: log + optional channel pause notice.
4. Optionally POST the successful result payload to the configured webhook.

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
| `name` | no | Hook identity / framed peer id |
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
   agenc run status <run-id>
   agenc run replay <run-id> --after 0 --limit 100
   agenc run evidence <run-id> --limit 100
   agenc run cancel <run-id> --reason "operator stop"
   ```

6. Set `[agent.budget]` when a run also needs a hard token/USD/wall-clock
   allocation; descendants conserve that allocation transactionally.

## Source map

| Concern | Path |
| --- | --- |
| Execution admission / budget config | `runtime/src/budget/`, `runtime/src/state/execution-admission.ts` |
| Budget CLI | `runtime/src/bin/budget-cli.ts` |
| Heartbeat policy / runner / wire | `runtime/src/heartbeat/` |
| Cron delivery | `runtime/src/gateway/cron-delivery.ts` |
| Hooks server | `runtime/src/gateway/hooks.ts` |
| Session routing | `runtime/src/gateway/session-router.ts` |
| Config schema `[budget]` / `[heartbeat]` | `runtime/src/config/schema.ts` |
| Background admission policy | `runtime/src/app-server/background-agent-runner.ts`, `runtime/src/bin/bootstrap.ts` |
| Lifecycle hooks (PreToolUse etc.) | `runtime/src/hooks/` (session hooks; distinct from gateway Hooks HTTP) |
