# TUI startup spin: unbounded daemon-autostart retry with blank screen

Found 2026-08-23 while live-testing the agenc-goal plugin. Severity: high (session-blocking, silent, CPU-burning).

**Status: FIXED same day.** Root cause was unbounded tail self-recursion in `ensureAgenCDaemonAutostart` (the legacy identity-less restart and build-skew restart both re-entered the whole cycle with no cap or backoff). Fix: restart cycles are now capped at 3 with escalating backoff, giving up with a typed `AgenCDaemonAutostartError` naming the repeating reason; the default CLI route passes real stderr into autostart (respawn reasons were previously swallowed by `silentIo()`) and, on failure in a TTY, boots the TUI anyway with a `daemon-autostart-failed` error notice instead of a blank exit. Live-verified against the deterministic repro below: the formerly infinite spin now prints four visible respawn lines and fails cleanly in 3 seconds. The plugin MCP catalog gap (second finding below) turned out to be a three-link chain, all fixed: (1) plugin-declared servers were never merged into the session MCP source list (now merged in `resolveSessionMcpConfigFromSources` and the refresh path, with the session config and env threaded through so enablement and AGENC_HOME resolve correctly — without the config every plugin loads as disabled; without the env the loader falls back to process.env); (2) `${CLAUDE_PLUGIN_ROOT}` templates from Claude-Code-ecosystem plugins were not aliased to `${AGENC_PLUGIN_ROOT}` and fell through to env-var expansion, dropping the server with "Missing environment variables: CLAUDE_PLUGIN_ROOT" (CLAUDE_* aliases now resolve). The project-scope silent component strip (3) now warns at install time.

## Symptom

When the daemon is not running and autostart cannot bring one up, `agenc` (TUI) burns ~200% CPU indefinitely with a completely blank screen. No error text, no status notice, no project state created, no stderr output. Observed for 12+ minutes with no change. In one instance the process appeared to die via the heap-limit path (`--heapsnapshot-near-heap-limit=1`), taking the terminal window with it.

The same environment renders fine within seconds once any TUI instance manages to start the daemon: the failure mode only exists while autostart keeps failing.

## Deterministic repro

1. Build an isolated AGENC_HOME (must be a short path: `daemon.sock` hits the 108-char AF_UNIX limit):
   - copy `config.toml`, `auth.json`, `onboarding.json`, `.credentials.json`, `trusted-projects.json`, `daemon.cookie` from a real home
   - copy the real `daemon-lifecycle.lock.sqlite`
   - create a dead `daemon.sock` (bind a unix socket, close it, leave the file)
   - write a `daemon-snapshot.json` with `{"reason":"daemon_shutdown", ...}`
   - `chmod 700` the dir (group-writable homes are refused cleanly with "protected directory chain permits untrusted mutation", which is the good, graceful path)
2. `AGENC_HOME=<that dir> agenc` in a trusted project.
3. Blank screen, ~194% CPU, `daemon.pid` in the home keeps being rewritten for minutes.

First seen organically: `~/.agenc` daemon dead since a prior shutdown, stale `daemon.sock`, and the first TUI launched from an environment that could not complete daemon spawn (a sandbox that blocks `~/.agenc` writes). Orphaned spinners then kept later launches failing too.

## Root cause (profiled)

4s CPU profile of the spinning process (inspector attach via `kill -USR1`, samples: 15543):

```
2.9%  mutate                                   bin/agenc-main.js:9695
2.9%  readBoundedLinuxProcIdentityFile         dist/chunk-SIYD475Q.js:931
2.9%  findLinuxAgenCDaemonProcesses            dist/chunk-SIYD475Q.js:679
2.8%  spawnDetachedDaemon                      bin/agenc-main.js:13447 / 13100
1.9%  inspectLinuxAgenCDaemonProcessWithTracker dist/chunk-SIYD475Q.js:746
1.8%  readAgenCDaemonProcessStart              dist/chunk-SIYD475Q.js:609
0.8%  acquireSqliteDatabase                    dist/chunk-AGZJ7IH3.js:3119
0.3%  ensureAgenCDaemonAutostart               bin/agenc-main.js:13377
```

Plus 24% of samples in the garbage collector (allocation churn) and ~50% idle (the loop yields constantly but never stops). Source: `runtime/src/app-server/daemon-autostart.ts` and `daemon-instance-identity.ts`.

`ensureAgenCDaemonAutostart` is re-entered continuously. Each attempt:

- spawns a detached daemon (`spawnDetachedDaemon`)
- scans the entire `/proc` list for daemon identity (`findLinuxAgenCDaemonProcesses` → `readProcList` → `readBoundedLinuxProcIdentityFile` / `readProcEnv` per PID)
- opens and validates the SQLite lifecycle lock (`acquireSqliteDatabase`, `beginAndValidateLock`)
- repairs `daemon.pid` (file keeps being rewritten)

The inner wait loops in `daemon-autostart.ts` do have `host.sleep(...)` polling, but the overall ensure cycle has no backoff, no attempt cap, and no terminal failure state that reaches the TUI. When every attempt fails fast (identity mismatch against a stale lifecycle record, spawn dying immediately, lock contention with another spinner), the cycle rate is bounded only by how fast one attempt fails, i.e. hundreds per minute, each doing a full /proc sweep and a process spawn.

Meanwhile the TUI renders nothing until the daemon connection exists, so the user sees a dead blank terminal.

## Suggested fix shape

1. Exponential backoff + attempt cap in the ensure/autostart cycle (e.g. 1s, 2s, 4s ... cap 30s; give up after N minutes into a terminal error state).
2. On terminal failure, surface a status notice (precedent exists: `statusNoticeDefinitions.tsx` `daemon-autostart-disabled`) and render the TUI shell regardless — the TUI should paint before daemon readiness, with a "daemon unavailable" banner, instead of staying blank.
3. `daemon-spawn-stderr.log` stayed empty through all of this; the spawn failure reason should be captured somewhere inspectable.
4. Orphan protection: two TUIs both stuck in this loop compound each other via the lifecycle lock; a backoff plus jitter also mitigates that.

## Second high-severity finding: plugin MCP servers spawn but their tools never reach the catalog

With the agenc-goal plugin installed at USER scope (authority-controlled, so MCP is allowed), the TUI spawns the plugin's MCP server process (`node .../bin/goal-server.mjs` visible in ps), but the server's tools are absent from the model's tool catalog. Tool search with explicit selections returns:

```
Select tools: mcp.agenc-goal.goal_create, mcp.agenc-goal.goal_update, mcp.agenc-goal.goal_get
{"totalCatalogSize":88,"loaded":[],"missingSelections":["mcp.agenc-goal.goal_create","mcp.agenc-goal.goal_update","mcp.agenc-goal.goal_get"]}
```

So the model can never call any plugin MCP tool, and it burns tokens searching, reading plugin source, and trying shell fallbacks (one grok-4.5 session spent >$7 flailing on this). Likely related to the known "live-agent MCP refresh no-op" backlog item: the server connects, but tool registration/refresh into the live catalog never happens for plugin-sourced MCP servers. Plugin slash commands and agents from the same plugin DO register (`/agenc-goal:goal` and the goal-planner agent both worked).

## Platform gap: MCP stdio on Landlock-fallback machines — ADDRESSED (same day, follow-up PR)

Follow-up fixes landed after this report's first version:

- The broker pre-flights the Landlock plan when readiness came through the fallback: unexpressible policies now fail at spawn-preparation with `[sandbox_policy_unexpressible] ... <reason> ... <cause-correct bubblewrap remediation>` instead of spawn-and-die (skipped for inherited-readonly-cwd spawns, which plan cleanly; best-effort with the stderr capture below as backstop).
- The stdio transport retains a bounded ring of child stderr and attaches the tail to pre-handshake connect failures, so any server death shows its actual reason in /mcp instead of "MCP error -32000: Connection closed".
- Plugin-declared MCP servers finally consume their `pluginSandbox` metadata: they spawn under a tight profile (root read, writes confined to the plugin data dir + its tmp, TMPDIR pointed there) that is stricter under bubblewrap AND Landlock-expressible — plugin MCP works on fallback machines.
- `agenc doctor` emits `[sandbox_landlock_fallback]` with the cause-correct remedy (and exits 1) whenever the fallback is active.
- docs/install.md now states plainly that there is no safe partial waiver under the fallback, and that `[sandbox_policy]` `writable_roots` is a dead config key nothing consumes.
- A FIFTH root cause surfaced only during live verification: the restricted-network seccomp filter denied `getsockname`/`getpeername`/`getsockopt`, and Node's `child_process` "pipe" stdio are AF_UNIX socketpairs — libuv classifies inherited stdio with `getsockname`, so every node-spawned confined child saw `getsockname(0) => EPERM` and instant EOF on stdin (proved with strace and an in-server fd probe; a shell-driven pipeline worked because shell pipes are real pipes). Read-only socket introspection is now allowed in restricted mode; socket creation stays AF_UNIX-only and connect/bind/listen/accept/send*/setsockopt stay denied. With this, the FULL chain was verified live on this bubblewrap-less machine: plugin server `connected` in /mcp with its tools, tool catalog grew 88 → 97, and a model Tool search returned `mcp.plugin:agenc-goal:agenc-goal.goal_create`.

Original analysis below for the record.

## Remaining platform gap: MCP stdio is fully broken on Landlock-fallback machines

With the four integration fixes in place, the plugin MCP server is resolved, handed to the live manager, and spawned through `agenc-linux-sandbox`, but on this machine every connect still fails with `MCP error -32000: Connection closed` because the sandbox launcher exits before exec:

```
bubblewrap is unavailable and the Landlock fallback cannot express this policy:
a writable root carries an existing read-only subpath, which an allow-list
cannot express: <project>/.agenc   (or <project>/.git in git projects)
```

The mcp_stdio permission profile is `root: read, project_roots: write, tmpdir: write` with platform defaults that carve `<project>/.agenc` (and `.git`) out as read-only. A writable root with a read-only subpath is exactly what a Landlock allow-list cannot express, and agenc always creates `<project>/.agenc`, so on machines where bubblewrap is unusable (here: bwrap is installed but blocked by the Ubuntu AppArmor unprivileged-userns restriction, the same condition the installer already warns about) EVERY stdio MCP server fails — plugin-sourced or user-configured. Fail-closed is the intended posture (#1516), so this is a deliberate-tradeoff decision, not a patch: either teach the Landlock fallback to drop the read-only carve-outs with a warning, or surface a specific "MCP unavailable without bubblewrap" error instead of the generic connection-closed. On bubblewrap-capable machines the plugin MCP chain should now work end to end.

## Related smaller findings from the same session

- Sandbox policy: in /tmp-rooted projects, "bubblewrap is unavailable and the Landlock fallback cannot express this policy: a writable root carries an existing read-only subpath (.git)" blocks ALL model shell in the project. May be worth a friendlier degradation.
- AF_UNIX 108-char limit: an AGENC_HOME under a deep path cannot create `daemon.sock` at all; worth an explicit error (the generic autostart failure message does fire, at least on the perms path).
- Plugin scopes: project-scope plugin installs are `repository-controlled` (`plugins/loader.ts` `contentProvenanceForPath`) and silently drop hooks + MCP servers. Correct security posture, but "silently" is rough: `agenc plugin install --scope project` on a plugin that ships MCP/hooks should warn that those components will not load at this scope.
