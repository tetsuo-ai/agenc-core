# Autonomy reference

Operator and developer guide for **cost-bounded autonomous surfaces** in
AgenC **0.17.0**: daemon-owned execution admission, heartbeat, cron delivery,
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
| Background agents | `app-server/background-agent-runner.ts` | unattended policy; `[agent.budget]` is enforced only by the shared admission kernel |

Defaults: **budget disabled**, **heartbeat disabled**. Enabling either is an
explicit operator action.

### Session autonomous tick mode (distinct system)

The CLI flag `--autonomous` enables **session keepalive** ticks
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
soft_threshold = 0.8          # stored on BudgetPolicy; no warning emitter in runtime/src/budget/
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
- `(runId, stepId)` is unique. The first model sample uses
  `model:<sub>:<turn>:<reentry>:<attempt>`; later samples add
  `:sample-<ordinal>` before `:<attempt>`. The ordinal is checkpointed before
  the next admission, so nudge, compact, empty-response, and other follow-up
  samples remain distinct and crash-resumable.
  See [execution-admission-kernel.md](../design/execution-admission-kernel.md#model-step-identity).

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
# active_hours = [8, 22]    # [start, end) local 24h; omit = always
skip_when_busy = true
# target_channel = "telegram"
# target_conversation = "12345"
```

| Env | Effect |
| --- | --- |
| `AGENC_HEARTBEAT` | Enable/disable |
| `AGENC_HEARTBEAT_INTERVAL` | Seconds between ticks |
| `AGENC_HEARTBEAT_ACTIVE_HOURS` | `8-22` or `always` |
| `AGENC_HEARTBEAT_TARGET` | `none` or `<channelId>:<conversationId>` |

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
- Delivery-routed jobs (`announceChannel` / `announceTo` / `webhook` on
  CronCreate) are **always durable** and run only while
  **`agenc gateway run`** is up (`startCronDelivery`). A daemon restart
  alone does not fire them.
- Isolated session key: `cron|default|<id>`
  (`SessionRouter.conversationKey`).

### Per fire

1. Resolve channel adapter and/or webhook from `task.deliver`.
2. `SessionRouter.runTurn` on an unattended daemon session with permission
   requests **denied**.
3. Model/tool calls reserve and reconcile through daemon execution admission.
   On denial: log + optional channel pause notice.
4. On a successful turn, optionally POST the result JSON to
   `deliver.webhook`. A webhook failure is **logged and does not retry**
   the turn; the fire is still stamped.

`isRunning()` is exposed so heartbeat can defer while a cron delivery turn is
in flight.

### Webhook destinations (pinned, fail-closed)

Cron webhooks are **public-egress only**. The delivery client resolves the
host once, then dials that exact IP (`requestPinnedCronWebhook`). The HTTP
`Host` header and TLS SNI keep the original hostname. There is no
DNS-rebinding window between the policy check and the socket.

`CronCreate` only checks that `webhook` is an `http(s)` URL. The pinned
address gate runs at **delivery** (and again on every redirect hop).
`assertCronWebhookUrlSafe` is an optional early check; it is not the
enforcement boundary.

| Constraint | Behavior |
| --- | --- |
| Scheme | `http:` or `https:` only |
| Credentials | Username/password in the URL are rejected |
| Local names | `localhost` and `*.localhost` blocked before DNS |
| Address policy | `resolveAllowedAddress(..., { allowPrivateNetwork: false })`, the same classifier as the browser SSRF proxy |
| Mixed DNS | **Fail closed** if **any** answer is disallowed (public + `10/8` is rejected) |
| Loopback / private | Blocked. Unlike session HTTP hooks, **loopback is not allowed** |
| Cloud metadata | Blocked in every representation (`169.254.169.254`, `100.100.100.200`, AWS IPv6 IMDS, IPv4-mapped and scoped forms) |
| Special-purpose | Reserved, documentation, benchmark, multicast, CGNAT, unique-local, and link-local ranges blocked |
| Redirects | At most **5** hops (`CRON_WEBHOOK_MAX_REDIRECTS`). Each hop is re-resolved and re-pinned |
| Redirect protocol | Scheme changes (`https` → `http`) are rejected |
| Redirect method | `307` / `308` keep POST + body; `301` / `302` / `303` become GET with no body |
| Timeout | **15 s** (`CRON_WEBHOOK_TIMEOUT_MS`) covering DNS **and** every hop |
| Private-network override | **None.** `[browser].allow_private_network` does not apply to cron |

There is no cron equivalent of `AGENC_BROWSER_ALLOW_PRIVATE_NETWORK`. Point
webhooks at a reachable public HTTPS endpoint, not `127.0.0.1`, RFC1918,
link-local, or metadata addresses.

Successful POST body (JSON):

```json
{
  "taskId": "abc123",
  "cron": "7 * * * *",
  "prompt": "summarize overnight deploys",
  "finalMessage": "No failed overnight deploys.",
  "stopReason": "end_turn",
  "firedAt": "2026-08-31T16:00:00.000Z"
}
```

### Operator pitfalls

- A webhook that only listens on loopback or a private network will store
  successfully (`https://127.0.0.1:9000/hook` passes CronCreate) and then
  fail at fire with a `cron webhook: blocked` error.
- A hostname that answers both a public and a private address is rejected
  even if the public address would have been fine.
- A public URL that **redirects** to a private or metadata host is rejected
  on that hop; the first request already happened.
- Webhook POST errors do not pause the job or refund the turn. Check
  gateway logs (`cron: webhook POST failed for task <task-id>`).
- Channel delivery still needs a running adapter. An unknown
  `announceChannel` skips channel send for that fire and may still POST
  the webhook via the null adapter.

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
5. Cron webhooks must be public http(s) URLs. Loopback, private, and
   metadata destinations are rejected at delivery even if CronCreate stored
   them. There is no private-network override.
6. Monitor and recover:

   ```bash
   agenc budget status
   agenc run status <run-id>
   agenc run replay <run-id> --after 0 --limit 100
   agenc run evidence <run-id> --limit 100
   agenc run cancel <run-id> --reason "operator stop"
   ```

7. Set `[agent.budget]` when a run also needs a hard token/USD/wall-clock
   allocation; descendants conserve that allocation transactionally.

## Source map

| Concern | Path |
| --- | --- |
| Execution admission / budget config | `runtime/src/budget/`, `runtime/src/state/execution-admission.ts` |
| Budget CLI | `runtime/src/bin/budget-cli.ts` |
| Heartbeat policy / runner / wire | `runtime/src/heartbeat/` |
| Cron delivery | `runtime/src/gateway/cron-delivery.ts` |
| Cron webhook pin / SSRF | `runtime/src/gateway/cron-delivery.ts` (`postCronWebhook`, `requestPinnedCronWebhook`), `runtime/src/browser/ssrf.ts` (`resolveAllowedAddress`) |
| Hooks server | `runtime/src/gateway/hooks.ts` |
| Session routing | `runtime/src/gateway/session-router.ts` |
| Config schema `[budget]` / `[heartbeat]` | `runtime/src/config/schema.ts` |
| Background admission policy | `runtime/src/app-server/background-agent-runner.ts`, `runtime/src/bin/bootstrap.ts` |
| Lifecycle hooks (PreToolUse etc.) | `runtime/src/hooks/` (session hooks; distinct from gateway Hooks HTTP) |
