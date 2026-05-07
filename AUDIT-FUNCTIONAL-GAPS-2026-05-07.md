# Functional gap audit — 2026-05-07

## Why this exists

The `PORT_CHECKLIST.md` `[x]` count tracks items where code shipped, build is green, and verify gates passed. Verify gates are mostly structural: branding, no upstream growth, typecheck cap, security paths can't be throwing stubs, TUI starts under PTY. They do not assert that a feature actually works end-to-end when a user runs `agenc`.

This audit closes that loop. Five parallel subagents inspected the live runtime for places where the checklist says "done" but the user-visible feature is broken, stubbed, or unwired.

## Surfaces audited

1. TUI commands, slash commands, composer (`runtime/src/tui/**`, `runtime/src/commands/**`, CLI entry)
2. Tool registry and execution (`runtime/src/tools/**`, registry/dispatch)
3. MCP integration (server + client lifecycle, config, TUI surface)
4. Daemon protocol, IPC, lifecycle, auth (`runtime/src/app-server/**`)
5. Provider/model adapters (`runtime/src/llm/**`, provider profiles, env auth)

## Findings — 35 items

These are tracked in `PORT_CHECKLIST.md` Phase 14 with prefixes `GAP-TUI-*`, `GAP-TOOLS-*`, `GAP-MCP-*`, `GAP-DMN-*`, `GAP-PROV-*`.

### TUI surface (12 items)

The biggest structural finding: `runtime/src/tui/components/App.tsx` is the live AgenC shell, but it bypasses `runtime/src/tui/screens/REPL.tsx` (the orphaned ~4600-line screen). REPL.tsx is what wires `<GlobalKeybindingHandlers/>`, `<ExitFlow/>`, `<MessageSelector/>`, `<TokenWarning/>`, the cost overlay, the compact progress bar, the rewind UI, the worktree-exit prompt. App.tsx mounts only Messages, PermissionOverlay, ElicitationOverlay, RealtimePanel, PromptInput. **Everything REPL.tsx mounts that App.tsx does not is shipping as dead UI/keys.** This is GAP-TUI-12.

Most user-visible regressions trace to App.tsx not mounting GlobalKeybindingHandlers (GAP-TUI-01): Ctrl+T, Ctrl+L, Ctrl+O, Ctrl+Shift+O, Meta+J, and the entire Transcript-context binding set are declared but no-op. Ctrl+T and Ctrl+O are hinted in the footer (`PromptInputFooterLeftSide.tsx:270`), so users actively try them.

Other live gaps:

- `/clear` doesn't reset the TUI transcript view (GAP-TUI-03)
- `/keybindings` spawns an editor while Ink owns the terminal (GAP-TUI-04)
- `/init` writes the upstream prompt template to AGENC.md instead of generating a real contributor guide (GAP-TUI-05)
- `/copy` doesn't reach the OS clipboard (GAP-TUI-06)
- `/reload-plugins` only refreshes the picker, not the live dispatcher (GAP-TUI-07)
- `/compact` progress bar never updates because daemon-backed Session lacks the hooks (GAP-TUI-08)
- `/btw` is in the help menu but not registered (GAP-TUI-09)
- `/files` is gated `USER_TYPE === "ant"` and never visible to AgenC users (GAP-TUI-11)
- `~17 commands/ subdirectories` contain executable command modules never wired into `buildDefaultRegistry()` — looks like coverage in PR diffs but isn't (GAP-TUI-10)
- `App.tsx` has `onShowMessageSelector={() => {}}` no-op stub and missing `onMessageActionsEnter` (GAP-TUI-02)

### Tool registry (5 items)

- `SyntheticOutputTool` base singleton echoes input untouched without validation (GAP-TOOLS-01)
- `spawn_agents_on_csv` declares both `max_workers: string` and `max_concurrency: number` for the same field (GAP-TOOLS-02)
- `tool-search` is marked `idempotent` but mutates session-advertised-tool state (GAP-TOOLS-03)
- 7 tool operations have parallel TUI and daemon implementations (Read/FileRead, Bash/system.bash, Edit/FileEdit, Write, Grep, Glob, NotebookEdit) — pick one surface per tool (GAP-TOOLS-04)
- 5 null-stub tools imported with conditional spread (`SuggestBackgroundPRTool`, `VerifyPlanExecutionTool`, `REPLTool`, `TungstenTool`, `TungstenLiveMonitor`) — implement or delete (GAP-TOOLS-05)

### MCP integration (6 items)

The `agenc mcp serve` server-out path (AgenC-as-MCP-server) is real, typed, tested, and wired into daemon autostart. The `MCPManager` client-in path is real and wired into session lifecycle. **The gap is everything in between.**

- Two parallel config namespaces with no bridge: `~/.agenc.json` `mcpServers` (legacy zod) vs `~/.agenc/config.toml` `mcp_servers` (live TOML). User-facing `mcp add` (when wired) populates a key the live MCPManager will never read (GAP-MCP-01)
- `agenc mcp` CLI only supports `serve`. `add`/`list`/`get`/`remove`/`add-json`/`add-from-agenc-desktop`/`reset-project-choices`/`doctor` handlers exist at `cli/handlers/mcp.tsx:102-460` but no parser wires them (GAP-MCP-02)
- `/mcp` slash command is read-only status. `mcp-client/manager.ts:388 reconnectServer` is implemented and tested but no caller (GAP-MCP-03)
- GAP-MCP-04 resolved the stale MCP donor tier by deleting the dead command subdirectory and entrypoint, moving `mcp add` into the live CLI handler layer, wiring `mcp xaa`, and removing the retained `services/mcp`, TUI MCP, and CLI handler `// @ts-nocheck` boundaries.
- MCP connection failure notifications (`useMcpConnectivityStatus`) live only in dead REPL.tsx (GAP-MCP-05)
- Cross-process lockfile race in MCP auth refresh, TODO: before GA (GAP-MCP-06)

### Daemon protocol (5 items)

- `session.create` / `session.detach` / `session.terminate` declared in protocol, called by SDK, **silently rejected** by daemon dispatcher with `-32601 "daemon method is not implemented yet"`. Backing impl exists at `session-lifecycle.ts:125,296,321`. Three missing case clauses + validators (GAP-DMN-01)
- `session.list` and `permission.list` gated by `if (manager === undefined)` — boot path may leave them unset (GAP-DMN-02)
- Unix socket accepts connections without auth at accept time; cookie verification only at `initialize`. Peer can hold socket open and consume resources (GAP-DMN-03)
- D-14's `verifiedBy: "peerUid"` is never produced because Node's `net.Socket` can't expose `SO_PEERCRED`. Need native binding fallback (GAP-DMN-04)
- No `agenc-runtime reload` subcommand; config refresh requires full restart (GAP-DMN-05)

D-17 tool-recovery wiring is real and well-tested — no gap.

### Provider adapters (7 items)

The four real wired providers are `anthropic`, `openai`, `grok`, `ollama`. `gemini`/`groq`/`deepseek`/`openrouter`/`lmstudio`/`openai-compatible` are thin shim subclasses. The `anthropic` SSE handler (incl. tool-use input_json_delta), the `openai` chat + responses + structured outputs paths, and the `grok` server-side search routing are all complete.

The gaps:

- No Bedrock adapter despite `BUILT_IN_PROVIDER_SCOPE_OMISSIONS` advertising the gap (GAP-PROV-01)
- `APIProvider` enum advertises bedrock, vertex, foundry, nvidia-nim, minimax, mistral, github with env-flag resolution, but none are concrete adapters (GAP-PROV-02)
- **Auth bypass:** `llm/provider.ts` reads `process.env[apiKeyEnvLabel]` directly in every concrete-provider case. Only the `agenc` branch uses `AuthBackend.vendKey()`. Direct violation of the global rule (GAP-PROV-03)
- **process.env mutation:** `providerProfiles.ts`, `providerFlag.ts`, `openaiShim.ts` mutate `process.env.OPENAI_API_KEY` and other key envs (GAP-PROV-04)
- ~25 provider presets in `providerProfiles.ts` (kimi-code, moonshotai, together, azure-openai, dashscope, nvidia-nim, minimax, xai, bankr, zai, atomic-chat, mistral, ...) all collapse to a shared shim with baseURL substitution; no per-provider behavior (GAP-PROV-05)
- `runtime/src/utils/model/providers.ts` is `// @ts-nocheck` and uses a bracketed-name sentinel array to evade the file-path scanner (GAP-PROV-06)
- `services/api/minimaxUsage/fetch.ts` ships MiniMax usage telemetry without a MiniMax provider (GAP-PROV-07)

## Methodology

Five parallel `general-purpose` subagents, one per surface. Each instructed to produce a punch list (file:line + symptom) of declared-but-not-functional code, NOT structural/branding/typecheck issues. Findings consolidated and deduplicated against existing checklist scope.

## Outcome

- 35 new items added to `PORT_CHECKLIST.md` Phase 14
- Open count: 12 → 47
- These items DO NOT gate Z-FINAL by default. Z-FINAL still depends only on `Z-*` and `ZC-*` items. Decide separately whether GAP-* items block declaring agenc-core "done."
