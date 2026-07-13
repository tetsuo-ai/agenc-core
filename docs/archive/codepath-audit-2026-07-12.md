# Codepath audit report — agenc-core 0.6.0

**Date:** 2026-07-12  
**Branch:** `main` @ post-#1471  
**Mode:** audit-only (no code fixes in this pass)  
**Method:** Six parallel exclusive-zone agents tracing live control flow; senior verification follows in a separate section.

> **Not product truth.** Historical engineering audit. Prefer this file for fix prioritization, not operator docs.

---

## Executive summary

Agents audited: **security/sandbox**, **daemon multi-session**, **gateway/budget/hooks**, **tools/agents/MCP**, **TUI/CLI**, **LLM/remote/SDK**.

| Severity | Count (raw agent claims) | After senior filter |
| --- | --- | --- |
| Critical | 1 | **1** (TOOL-01) |
| High | ~25 | **~14 confirmed**; ~6 downgraded to MED/intentional/UX |
| Medium | ~40 | residual backlog |
| Low / Info | remainder | residual / intentional |

**Top fix themes (cross-cutting):**

1. **Shell / tool isolation gaps** — env credential leak, stdin without ownership, sandbox honesty for alternate shells  
2. **Multi-session process globals** — `process.env` compact mutation, frozen daemon cwd, single-project thread store  
3. **Gateway pairing + budget** — live PairingStore vs CLI approve clobber; channel turns not budgeted  
4. **LLM stream retry** — mid-stream splice after partial yield; stream connect timeout missing  
5. **Cold resume /attach-only** — product promise vs implemention gap  

**Solid areas (confirmed across agents):** browser SSRF proxy design, hooks Bearer/loopback posture, Telegram answer-only + tool deny, OAuth>BYOK for Grok, unattended denylist vs yolo for shell (partial), marketplace mutating verbs not live, main spinner fake tok/s suppressed, MCP serve mutations env-gated.

---

## Severity legend

- **CRITICAL** — practical exploit or multi-agent isolation break without exotic config  
- **HIGH** — clear correctness/security defect with realistic repro  
- **MEDIUM** — real bug or race under load / concurrent use  
- **LOW** — residual risk, design gap, or ops footgun  
- **INFO** — intentional design or already solid  

---

## 1. Security & sandbox (SEC)

| ID | Sev | Title | Evidence |
| --- | --- | --- | --- |
| SEC-01 | **HIGH** | LIVE `exec_command` inherits full `process.env` (API keys leak to shell) | `unified-exec/process-manager.ts:295-299`; contrast `tools/system/bash.ts` minimal env |
| SEC-02 | **HIGH** | PreToolUse hook `permissionDecision: allow` skips content deny / unattended denylist / safetyCheck | `permissions/guardian/arbiter.ts:590-635`; hooks merge path |
| SEC-03 | **MEDIUM** | Auto-mode dangerous-allow strip is Bash-name-only (misses `exec_command` family) | `permissions/permission-mode.ts:465-481` |
| SEC-04 | **MEDIUM** | Unattended denylist aliases omit `shell` | `unattended-policy.ts:25-41` vs `SHELL_TOOL_FAMILY` |
| SEC-05 | **MEDIUM** | `tool.checkPermissions` throw → passthrough (fail-open) | `permissions/evaluator.ts:306-321` |
| SEC-06 | **MEDIUM** | Transaction guard `fail_mode=open` proceeds on classifier failure | `transaction-guard/ollama-courtguard.ts` (default closed — ops risk) |
| SEC-07 | **LOW** | Ledger tool skips host approval (device is gate) — intentional | `elicitation/request-ledger-transfer.ts` |
| SEC-08 | **LOW** | Hook SSRF allows loopback intentionally | `utils/hooks/ssrfGuard.ts` |
| SEC-09 | **LOW** | `security audit` CLI is Phase-0 exposure only | `bin/security-cli.ts` |
| SEC-10 | **LOW** | Path validation TOCTOU residual | `permissions/path-validation.ts` |

**Clean:** Browser SSRF (resolve-once IP, proxy, metadata always blocked); shell deny aliases for Bash↔exec_command in rules; OAuth wins over BYOK; sandbox fail-closed when isolation required and helper missing.

---

## 2. Daemon multi-session (DAE)

| ID | Sev | Title | Evidence |
| --- | --- | --- | --- |
| DAE-01 | **HIGH** | Concurrent compact mutates **process.env** (provider keys) | `session/run-turn.ts:840-879` |
| DAE-02 | **HIGH** | Daemon `process.cwd()` frozen at first autostart; missing cwd falls back wrong | `daemon-cli.ts` spawn; bootstrap defaults |
| DAE-03 | **HIGH** | Single `FileThreadStore` pinned to daemon-start project | `thread-store/store.ts` + daemon-cli construction |
| DAE-04 | **HIGH** | Daemon start not single-instance atomic (TOCTOU) | `daemon-cli.ts` pid write; launcher check-then-start |
| DAE-05 | **MEDIUM** | Launcher “ready” = pid+cookie only, not socket | `packages/agenc/src/launcher.mjs` |
| DAE-06 | **MEDIUM** | Residual `bootstrap/state.ts` process singleton if hit | `bootstrap/state.ts`, `utils/cwd.ts` |
| DAE-07 | **MEDIUM** | Durable resume lease skipped when rollout path missing | `conversation/thread-manager.ts:745-755` |
| DAE-08 | **MEDIUM** | Legacy commandExec sandbox cwd = daemon cwd | `command-exec.ts:471,676-684` |
| DAE-09 | **MEDIUM** | Non-loopback WS = cookie-only network auth (flag-gated) | `daemon-cli.ts` + transport auth |
| DAE-10 | **MEDIUM** | Runtime-manager concurrent install race | `packages/agenc/lib/runtime-manager.mjs` |
| DAE-11 | **MEDIUM** | Sync FS on event loop for session.list / resume | `thread-store/store.ts` |
| DAE-12 | **MEDIUM** | `restoreAgent` omits client envOverrides | `background-agent-runner.ts:867-883` |
| DAE-13 | **LOW–MED** | Env override allowlist gaps | `agent-cli.ts` DAEMON_CLIENT_ENV_OVERRIDE_KEYS |
| DAE-14 | **LOW** | Cancel/stop race near completion | agent-lifecycle stop path |
| DAE-15 | **LOW** | Process-global cost STATE residual | `bootstrap/state.ts` |

**Solid:** Per-session cwd beats frozen workspace when client passes cwd; ambient multi-session session guard; Unix cookie+peerUid; no process-global model on switch (todo-115); durable resume safety ladder when path present; /resume preview freeze partially fixed.

---

## 3. Gateway / budget / heartbeat (GW)

| ID | Sev | Title | Evidence |
| --- | --- | --- | --- |
| GW-01 | **HIGH** | Telegram control-plane public groups bypass DM pairing | `control-plane.ts:168-179` → `gateway.ts` `bypassAccess` |
| GW-02 | **HIGH** | CLI `pairing approve` vs live gateway in-memory store clobber | `pairing.ts` load-once; CLI separate store |
| GW-03 | **HIGH** | Channel turns never call budget admit (`enforce_interactive` dead) | `gateway.ts:260-305` vs budget only on hooks/cron/heartbeat |
| GW-04 | **MEDIUM** | Budget admit non-atomic (check then hold race) | `budget/enforcer.ts:75-149` |
| GW-05 | **MEDIUM** | Ledger lock timeout fails open without merge | `budget/ledger.ts:101-115` |
| GW-06 | **MEDIUM** | Cron: unreconciled hold if turn throws | `cron-delivery.ts` |
| GW-07 | **MEDIUM** | Heartbeat: unreconciled hold if turn throws | `heartbeat/runner.ts` |
| GW-08 | **MEDIUM** | Cron session agent hard-coded `"default"` | `cron-delivery.ts:224-253` |
| GW-09 | **MEDIUM** | Media/x-search daily caps TOCTOU overshoot | meme/voice/x-search usage files |
| GW-10 | **LOW** | `pairing approve` no pending required | `pairing.ts:209-217` |
| GW-11 | **LOW** | Heartbeat skip_when_busy ignores channel load | `heartbeat/runner.ts` |
| GW-12 | **LOW** | Heartbeat + budget off = unbounded spend (by design) | budget default disabled |
| GW-13 | **LOW** | WebChat token in query string | `webchat-channel.ts` |
| GW-14 | **LOW** | Owner claim code not timing-safe | `control-plane.ts:242-245` |
| GW-15 | **LOW** | Heartbeat admit model may ≠ turn model | `heartbeat/wire.ts` |
| GW-16 | **LOW** | Soft threshold only for USD not tokens | `enforcer.ts` |

**Solid:** Open DM requires `*` + open; untrusted framing; Telegram answer-only; hooks Bearer + min token + 429; channel tokens stripped from daemon env; pause-once notification.

---

## 4. Tools / multi-agent / MCP (TOOL)

| ID | Sev | Title | Evidence |
| --- | --- | --- | --- |
| TOOL-01 | **CRITICAL** | Shared unified-exec process table — no agent ownership | `bootstrap.ts` one manager; `write_stdin`/`kill_process` by bare session_id |
| TOOL-02 | **HIGH** | `write_stdin` opts out of approval + shell-family deny | `write-stdin.ts:64`; SHELL_TOOL_FAMILY omits it |
| TOOL-03 | **HIGH** | `system.bash` deferred as sandboxed but never wraps platform sandbox | `tools/system/bash.ts` vs unified-exec sandbox |
| TOOL-04 | **HIGH** | LIVE PowerShell skips sandbox + shell-family policy | `model-facing-tools.ts` PowerShell registration |
| TOOL-05 | **HIGH** | File-mutation deny misses MultiEdit / apply_patch | `permissions/rules.ts` aliases |
| TOOL-06 | **HIGH** | Bare `registry.dispatch` skips permission/sandbox (MCP serve) | `tool-registry.ts:933+`; `mcp-server/tools.ts` |
| TOOL-07 | **MEDIUM** | Dual catalog TUI vs LIVE (SSRF parity drift) | `tools.ts` vs LIVE registry |
| TOOL-08 | **MEDIUM** | MCP catalog pin optional (fail-open) | `mcp-client/supply-chain.ts` |
| TOOL-09 | **MEDIUM** | Required MCP servers may not auto fail-closed | manager start opts |
| TOOL-10 | **MEDIUM** | Sandbox `failIfUnavailable` defaults off | `sandboxTypes.ts` |
| TOOL-11 | **MEDIUM** | `kill_process` marked idempotent + no ownership | kill-process tool + recovery |
| TOOL-12 | **MEDIUM** | Multi-agent default shared cwd; inherit parent mode | `agents/v2/spawn.ts` |
| TOOL-13 | **LOW** | File edit TOCTOU residual | file-edit / apply_patch |
| TOOL-14 | **LOW** | Browser SSRF residual if manager misbuilt | BrowserTool |
| TOOL-15 | **LOW** | Gated xAI tools mostly solid | model-facing-tools gates |
| TOOL-16 | **LOW** | Code-mode nested dispatch fail-closed for mutations | tool-registry code-mode |

**Solid:** LIVE web_fetch DNS pin; Bash↔exec_command deny family; max_turns mapping; spawn keepAlive for assign_task; XSearch/Imagine Grok gates; MCP serve mutations require env.

---

## 5. TUI / CLI (TUI)

| ID | Sev | Title | Evidence |
| --- | --- | --- | --- |
| TUI-01 | **HIGH** | Cold resume not implemented; disk list → attach-only fail | `agenc.ts` resumeTUIEntry live-agent only |
| TUI-02 | **MEDIUM** | `/resume` still sync FS on Ink thread | `commands/resume.ts` |
| TUI-03 | **MEDIUM** | Cancel wired but tools may outlive 100ms abort budget | `tasks.ts` GRACEFUL_INTERRUPTION_TIMEOUT_MS |
| TUI-04 | **MEDIUM** | Double-submit TOCTOU before busy ref set | `App.tsx` submit path |
| TUI-05 | **MEDIUM** | Workbench focus can silence composer (UX) | WorkbenchLayout focus |
| TUI-06 | **INFO** | Onboarding multi-provider key verify solid | useApiKeyVerification |
| TUI-07 | **LOW** | Footer key verify Anthropic-centric | tui/hooks/useApiKeyVerification.ts |
| TUI-08 | **INFO** | Permission mode does hit daemon | permissions.ts + setDaemonPermissionMode |
| TUI-09 | **LOW** | Dynamic slash palette may lag first paint | App getCommands async |
| TUI-10 | **LOW** | Main spinner fake tokens suppressed | showLeaderTokenStats=false |
| TUI-11 | **MEDIUM** | Identity resolution OK; outcome broken via TUI-01 | resume-session.ts |

---

## 6. LLM / remote / SDK (LLM / REM / SDK)

| ID | Sev | Title | Evidence |
| --- | --- | --- | --- |
| LLM-01 | **HIGH** | Mid-stream transport retry splices second SSE onto partial stream | `llm/client-session.ts:1046-1114` |
| LLM-02 | **HIGH** | Stream attempt ignores request timeoutMs (hang on open) | `client-session.ts:1239` vs non-stream timeout |
| LLM-03 | **HIGH** | Managed OpenRouter max **output** 2048 + tool-drop-on-length | bootstrap + openai adapter length strip |
| LLM-04 | **MEDIUM** | Token estimate `JSON.length/4` for context fit | wire/chat-completions.ts |
| LLM-05 | **MEDIUM** | Missing tool_calls index uses accumulator.size | openai/adapter.ts |
| LLM-06 | **MEDIUM** | finish_reason length drops all tools | stream-model + adapter |
| LLM-07 | **MEDIUM** | OpenAI OAuth refresh no single-flight | oauth/refresh-loop.ts |
| LLM-08 | **MEDIUM** | POST 5xx retry without idempotency | client-session retry policy |
| LLM-09 | **LOW–MED** | Idle watchdog only on non-empty chunks | client-session stream loop |
| LLM-10 | **MEDIUM** | Unknown openai-compat defaults 32k max output | openai-compatible-token-limits.ts |
| REM-01 | **MEDIUM** | Remote host ticket uses frozen login token | remote-cli.ts |
| REM-02 | **MEDIUM** | TUI re-pairs on non-410 host-poll failures | remote-cli.ts TUI path |
| REM-03 | **MEDIUM** | Empty daemon cookie still starts bridge | remote-cli.ts |
| SDK-01 | **MEDIUM** | Protocol drift tests method names only | sdk protocol tests |
| MKT-01 | **INFO** | Marketplace mutating verbs not enabled | protocol/marketplace-cli.ts |

**Solid:** xAI OAuth single-flight + quarantine; OAuth>BYOK; SDK permission deny default; marketplace read-only only.

---

## Suggested fix priority (for implementation later)

### P0 — security / multi-agent isolation
1. TOOL-01 + TOOL-02 + TOOL-11 — process ownership + stdin/kill policy  
2. SEC-01 — scrub secrets from shell env  
3. SEC-02 — hook allow must not skip deny floors  

### P1 — correctness under concurrency / money
4. DAE-01 — stop process.env mutation in compact  
5. LLM-01 + LLM-02 — stream retry + connect timeout  
6. GW-02 — pairing store reload/lock  
7. GW-03 — interactive budget if product expects it  
8. TOOL-03 + TOOL-04 + TOOL-05 — sandbox/shell/file-mutation policy honesty  

### P2 — product UX / multi-project daemon
9. TUI-01 — cold resume or honest attach-only UI  
10. DAE-02 / DAE-03 / DAE-04 — cwd, multi-project store, atomic start  
11. LLM-03/06 — managed 2048 + tool-drop interaction  
12. GW-01 — public Telegram bypass explicit  
13. REM-01/02 — remote token refresh / re-pair  

### P3 — hardening
14. Budget atomic admit (GW-04/05/06/07)  
15. MCP pin/required defaults (TOOL-08/09)  
16. Remaining LOW items  

---

## Agent provenance

| Zone | Agent focus |
| --- | --- |
| SEC | browser, sandbox, permissions, auth, transaction-guard, execution gates |
| DAE | app-server, bootstrap state, session, recovery, thread-store, launcher |
| GW | gateway, heartbeat, budget, gateway-cli |
| TOOL | tools, registry, agents v2, MCP, phases/execute-tools |
| TUI | tui, commands, bin route/resume, onboarding |
| LLM | llm client/adapters, remote-cli, agenc-sdk, protocol marketplace |

---

## Senior verification

**Verifier:** senior staff re-read of every CRITICAL/HIGH evidence path (read-only, 2026-07-12).  
**Filter result:** 1 CRITICAL remains; ~14 confirmed HIGH; several overstatements downgraded.

### Verdict table (CRITICAL / HIGH)

| ID | Claimed | Verdict | Notes |
| --- | --- | --- | --- |
| **TOOL-01** | CRITICAL shared process table | **CONFIRMED CRITICAL** | One manager per bootstrap; children inherit services; write/kill by bare `session_id` |
| **TOOL-02** | HIGH write_stdin | **CONFIRMED HIGH** | `requiresApproval: false`; not in shell family |
| **TOOL-03** | HIGH system.bash sandbox | **CONFIRMED HIGH** (narrow; deferred default) | No platform sandbox path; discoverable |
| **TOOL-04** | HIGH PowerShell | **CONFIRMED HIGH** (when present) | No sandbox; not in shell family |
| **TOOL-05** | HIGH MultiEdit/apply_patch deny | **CONFIRMED HIGH** | Edit aliases incomplete |
| **TOOL-06** | HIGH bare dispatch | **DOWNGRADED → MED** | MCP serve mutations env-gated by default |
| **SEC-01** | HIGH full process.env | **CONFIRMED HIGH** | LIVE exec inherits full env; bash minimal |
| **SEC-02** | HIGH hook allow | **CONFIRMED HIGH** (nuanced) | Name-level deny still wins; content/unattended floors skipped |
| **DAE-01** | HIGH env compact | **CONFIRMED HIGH** (same-process) | Cross-process agents OK; in-process multi-agent races |
| **DAE-02** | HIGH frozen cwd | **DOWNGRADED → MED** | Fallback footgun; explicit cwd works |
| **DAE-03** | HIGH single thread store | **CONFIRMED HIGH** (session path) | Snapshot multi-store does not fix list/resume |
| **DAE-04** | HIGH start TOCTOU | **DOWNGRADED → MED** | Ops reliability; socket usually prevents dual live |
| **GW-01** | HIGH TG public bypass | **DOWNGRADED → intentional / MED residual** | Designed public answer-only when enabled |
| **GW-02** | HIGH pairing clobber | **CONFIRMED HIGH** | Live memory vs CLI disk store |
| **GW-03** | HIGH no channel budget | **DOWNGRADED → product gap MED** | Documented autonomous-only envelope |
| **LLM-01** | HIGH mid-stream splice | **CONFIRMED HIGH** | Retry after partial yield |
| **LLM-02** | HIGH stream timeout | **CONFIRMED HIGH** | Stream attempt ignores timeoutMs |
| **LLM-03** | HIGH managed 2048 | **SPLIT** | Cap intentional (INFO); tool-drop-on-length is real defect |
| **TUI-01** | HIGH cold resume | **CONFIRMED UX HIGH** | Honest attach-only; not security |

### Not bugs (do not re-litigate)

- GW-01 public Telegram when `publicEnabled` (answer-only + tool deny)
- GW-03 interactive budget not wired (design doc says so)
- Managed OpenRouter 2048 **output** cap as a product limit
- TUI cold resume incomplete but fail is honest (`todo-113`)
- Browser SSRF design, host-gated pairing codes, MCP mutation env gate

### Ship-blockers (P0)

1. TOOL-01 + TOOL-02 (+ kill_process ownership/policy)  
2. SEC-01 shell env scrub  
3. SEC-02 hook allow floor bypass  

### Sprint top-10 (senior ranked)

| Rank | IDs | Work |
| --- | --- | --- |
| 1 | TOOL-01 + TOOL-02 | Process ownership + stdin/kill shell-family policy |
| 2 | SEC-01 | Minimal/allowlisted env for unified-exec |
| 3 | SEC-02 | Hook allow still runs content deny / unattended / safetyCheck |
| 4 | LLM-01 | No mid-stream splice after partial yield |
| 5 | LLM-02 | Stream connect/request timeout parity |
| 6 | GW-02 | Pairing store reload/lock across CLI + live gateway |
| 7 | DAE-01 | Compact without mutating process.env |
| 8 | TOOL-05 | MultiEdit / apply_patch deny aliases |
| 9 | TOOL-03 + TOOL-04 | Sandbox + shell-family for system.bash / PowerShell |
| 10 | DAE-03 (+ DAE-02) | Multi-project primary thread store |

### Residual risk

The only practical **CRITICAL** is same-process multi-agent shell isolation (TOOL-01), amplified by stdin/kill policy opt-outs and full env inherit. Unattended floors can be weakened by PreToolUse `allow` and incomplete tool-name families. LLM stream retry/timeout and pairing CLI/live split are real correctness issues but not remote RCE. Cumulative budget correctly covers autonomous surfaces only today — operators must not assume channel chat is USD-capped.

**Confidence:** high on all re-read CRITICAL/HIGH paths; no NEEDS-REPRO — structural defects visible without live exploit demos. Dynamic PTY hijack not executed (read-only).

---

## Remediation status (2026-07-12, branch `fix/codepath-audit-remediation`)

| ID | Status | Commit / note |
| --- | --- | --- |
| TOOL-01 | **FIXED** | `1aef14be9` + `6ed875b26` process ownership; Monitor/PowerShell/workflow stamp owner |
| TOOL-02 | **FIXED** | `1aef14be9` + `6ed875b26` write_stdin/kill/Monitor shell-family + requiresApproval |
| SEC-01 | **FIXED** | `0f3f84379` scrub-env for spawn |
| SEC-02 | **FIXED** | `7aede537e` arbiter evaluator floors after hook allow |
| LLM-01 | **FIXED** | `6d56044f7` no mid-stream transport retry after yield |
| LLM-02 | **FIXED** | `6d56044f7` stream acquireAttempt uses timeoutMs |
| GW-02 | **FIXED** | `86a1c560e` PairingStore reload-from-disk |
| DAE-01 | **FIXED** | Shared `session/compact-env-guard.ts` used by run-turn + session-compact; serialized process.env installs (race removed) |
| TOOL-05 | **FIXED** | `98807aac6` MultiEdit/apply_patch mutation family |
| TOOL-04 (partial) | **FIXED** (family) / **DEFERRED** (sandbox) | PowerShell in SHELL_TOOL_FAMILY; platform sandbox wire-up deferred — risk: Windows shell without sandbox |
| TOOL-03 | **DEFERRED** | system.bash platform sandbox honesty — risk: deferred shell escapes isolation; prefer exec_command |
| DAE-02 | **FIXED** | require absolute existing cwd on agent.create/session.create; clients send absolute path; daemon never invents |
| DAE-03 | **DEFERRED** | multi-project primary FileThreadStore — risk: session.list incomplete across projects |
| SEC-03 | **DEFERRED** | auto-mode strip Bash-name-only residual (shell family expanded; auto-mode helper not retargeted) |
| SEC-04 | **FIXED** (via TOOL-02 unattended shell alias) | shell/write_stdin/kill aliases |
| SEC-05 | **DEFERRED** | checkPermissions throw fail-closed |
| GW-01 | **N/A intentional** | public TG when publicEnabled |
| GW-03 | **N/A intentional** | interactive budget not wired (design) |
| LLM-03 cap | **N/A intentional** | managed 2048 output |
| LLM-03 tool-drop | **DEFERRED** | finish_reason length drops tools — risk: managed turns lose tool calls |
| TUI-01 | **DEFERRED** | cold resume / honest attach-only UX polish |
| Phase 2 remainder (GW-04+, TOOL-06+, TUI-02+, REM-*, LLM-04+) | **DEFERRED** | backlog after Phase 0 + senior top-10; risk noted in original findings |

See `git log --oneline main..HEAD` on `fix/codepath-audit-remediation` for exact hashes.
