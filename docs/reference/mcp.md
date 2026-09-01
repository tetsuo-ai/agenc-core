# MCP (Model Context Protocol)

AgenC speaks MCP in **both directions**:

| Direction | Location | Role |
| --- | --- | --- |
| **Client** (outbound) | `runtime/src/mcp-client/` | Connect to external MCP servers; bridge tools, resources, and prompts into the live registry |
| **Server** (inbound) | `runtime/src/mcp-server/` | Host AgenC as an MCP server for editors / other hosts |

Deep client notes: [`runtime/src/mcp-client/README.md`](../../runtime/src/mcp-client/README.md).

## Outbound client

### Transports

| Transport | Config value | Requirements |
| --- | --- | --- |
| stdio (default) | `stdio` | `command` (+ optional `args`, `cwd`, `env` / `env_vars`) |
| Streamable HTTP | `http` | `endpoint` |
| SSE (older MCP transport) | `sse` | `endpoint` |
| WebSocket | `websocket` | `endpoint` |

Optional bearer / custom headers apply on network transports. Stdio owns env
allow-listing, process-group cleanup, and PID-tree teardown.

### Config shape

Servers are configured under `mcp_servers` in config (typed as
`McpServerConfig` in `runtime/src/config/schema.ts`):

Server names are stable runtime identifiers: 1–256 ASCII letters, numbers,
colons, hyphens, or underscores. A period is not allowed because `.` separates
the server and tool portions of the canonical `mcp.<server>.<tool>` identity.
Colons are reserved-compatible with plugin-scoped names such as
`plugin:sample:local`; overlong generated plugin scopes are deterministically
compacted with a SHA-256 suffix before they reach the runtime manager.

```toml
[mcp_servers.docs]
transport = "stdio"
command = "npx"
args = ["-y", "some-mcp-server"]
# enabled = true
# required = false
# timeout = 30000
# default_tools_approval_mode = "ask"
# enabled_tools = ["search"]
# disabled_tools = ["delete"]
# container = "my-desktop-container"  # optional: stdio via desktop sandbox / docker exec
```

Network example:

```toml
[mcp_servers.remote]
transport = "http"
endpoint = "https://mcp.example.com/mcp"
# headers = { Authorization = "Bearer ${AGENC_CREDENTIAL_REMOTE_TOKEN}" }
```

`${NAME}` and `${NAME:-default}` interpolation is resolved once from the
creating client's captured environment. It never falls back to the daemon's
startup environment. Use the reserved `AGENC_CREDENTIAL_*` namespace for MCP
secrets that must cross a daemon session boundary. A configured
`headersHelper` receives that same captured environment plus
`AGENC_MCP_SERVER_NAME` and `AGENC_MCP_SERVER_URL`; reconnects retain the
original environment and shell-wrapper authority.

Daemon sessions own their outbound MCP manager and all live transports. The
daemon TUI never creates a client-side manager or mirrors mutations into a
second connection set. It forwards `session.mcp.addServer` and the internal
enable, disable, and reconnect methods to the owning daemon session.

`session.mcp.status` returns a revisioned, passive projection for the public
SDK and TUI. It contains server names, transport/state flags, sanitized display
targets, tool counts, and tool names. It never contains SDK
clients, environment variables, headers, arguments, authentication material,
full remote URLs, raw connection errors, or executable tool schemas.
`event.mcp_status_changed`
contains only `sessionId` and `revision`; clients then fetch the complete
projection. Revisions are monotonic within one live daemon connection and
clients reset their watermark after reconnecting to a replacement daemon.

AgenC can also expose itself as an MCP server via `[mcp.server]`
(`enabled`, `transport` = `stdio` | `sse`, optional `host` / `port`). Daemon
SSE autostart also requires an absolute `workspace`; the path is canonicalized
and must resolve to a directory before the endpoint starts. Foreground
`agenc mcp serve` scopes tools to the command's working directory.

### Plugin-declared servers

Session startup merges enabled-plugin `mcpServers` into the same outbound
set as operator `mcp_servers`. The live path is
`getAllMcpConfigs` → `loadPluginMcpServerRegistrations` → the session
`MCPManager` (`runtime/src/services/mcp/config.ts`,
`runtime/src/plugins/registration/mcp-plugin-integration.ts`). A broken
plugin source is logged, reported on `/mcp`, and skipped; it cannot fail
session startup. `pluginDefinitionKnowledgeComplete` is false when discovery
throws or records an issue.

Names are scoped as `plugin:<plugin-id>:<server>`
(`pluginScopedServerIdentifier`). Overlong generated scopes are compacted
with a SHA-256 suffix. Tools appear as
`mcp.plugin:<plugin-id>:<server>.<tool>`.

| Winner | Loses |
| --- | --- |
| Operator `mcp_servers` with the same command/URL signature | Plugin server (content-based dedup). A **disabled** manual entry does not suppress a plugin server |
| Session `addServer` | Plugin or default origin of the same name |
| Managed MCP policy (`hasManagedMcpAuthority`) | Plugin discovery (not loaded) |
| First enabled plugin | Later plugin with the same command/URL |

Project- and local-scope installs are **repository-controlled**. The loader
strips their `mcpServers`, hooks, and `lspServers`. `agenc plugin install
--scope project` or `--scope local` warns at install time when the manifest
contains hooks or MCP servers. Use `--scope user` to load those surfaces. See
[skills-plugins.md](skills-plugins.md).

Stdio plugin servers spawn under a tight `permissionProfileOverride`:
full-disk read, writes only to the plugin data directory and its `tmp/`
(`TMPDIR` pointed there). The override applies only when the session is
`workspace_write`; a surface may tighten the session profile but cannot widen
it (`SandboxExecutionBroker.prepareSpawn`). The plugin profile has no `.git` /
`.agenc` carve-outs, so it is Landlock-expressible. Ordinary workspace-write
stdio MCP still needs bubblewrap; on AppArmor-restricted hosts these
spawns fail in pre-flight with `[sandbox_policy_unexpressible]` instead of
a bare `MCP error -32000: Connection closed`. AppArmor remediation and
the plugin exemption: [install.md](../install.md#ubuntu-apparmor-and-bubblewrap).

Reserved child env (injected by `pluginMcpSandboxEnvironment`, not
operator-overridable keys): `AGENC_PLUGIN_ROOT`, `AGENC_PLUGIN_DATA`,
`AGENC_PLUGIN_NAME`, `AGENC_PLUGIN_MCP_SERVER`, `AGENC_PLUGIN_SANDBOX`.
Manifest strings may template `${AGENC_PLUGIN_ROOT}`, `${AGENC_PLUGIN_DATA}`,
`${AGENC_SESSION_ID}`, and `${user_config.<field>}` before ordinary
`${NAME}` / `${NAME:-default}` expansion from the **session** environment.
A missing required environment variable drops the server. `cwd` must stay
inside the plugin root (realpath-checked).

Connect failures attach up to **8** recent child stderr lines (400 characters
each) as `; server stderr: <tail>` (`RECENT_STDERR_MAX_LINES` in
`runtime/src/mcp-client/transports/stdio.ts`). The production manager uses
a silent logger. Before stderr retention, the manager discarded the launcher's
refusal text.

### Tool bridge

- Namespaced tool names: `mcp.<serverName>.<toolName>`
- Permission integration via the same arbiter as built-ins
- Result size cap: `MAX_MCP_CALL_RESULT_BYTES` (5 MiB)
- Catalog policy: `enabled_tools` / `disabled_tools` /
  `default_tools_approval_mode` (normalized in the resilient client)
- Dead connections reconnect with exponential backoff
  (`ResilientMCPBridge`, 1 s → 30 s, ×2)
- Optional **supply-chain pin** (SHA-256 over the canonical tool catalog JSON)
  refuses to load if the advertised catalog drifts

Resources (list/read) and prompts (list/render into message pairs) are bridged
through the same session-owned manager. Resource reads preserve multipart
content in order, cap each block at 1 MiB and each aggregate read at 5 MiB,
accept at most 256 content blocks, and mark truncation explicitly. Resource
catalogs accept at most 100 cursor pages and 1,000 descriptors. Resource URIs
are limited to 8 KiB; display names, descriptions, and MIME metadata are
sanitized and bounded to 1 KiB, 8 KiB, and 256 bytes respectively. The
model-facing read helper persists binary blocks in the session's private
tool-results directory and returns file references; raw base64 is not inserted
into model context.

User-authored `@server:uri` resource mentions are resolved once at the session
sampling boundary, and only from the exact authoritative root-human text for
that turn. Continuation sampling cannot consume the same turn twice. AgenC
matches the longest connected server-name prefix (so plugin-scoped names
containing `:` remain valid), then admits the catalog lookup and resource read
as one bounded, read-only effect through that session's MCP manager. A turn
resolves at most 10 resource mentions under one shared 1-second deadline and
retains at most 5 MiB across their encoded content and resource metadata. These
reads never use `ToolUseContext.mcpClients` or the TUI preprocessing path; the
passive status projection contains no executable client. Returned resource
content keeps the canonical size, normalization, truncation, and untrusted-data
framing rules above.

### Model-facing MCP tools

There is **no** LIVE tool named `MCPTool`. External MCP tools appear as deferred
registry entries under the namespace **`mcp.<server>.<tool>`**.

Built-in helpers that help the agent work with MCP resources:

- `ListMcpResourcesTool`
- `ReadMcpResourceTool`

Slash: `/mcp` opens the MCP connection menu in the TUI. `/mcp status` and
`/mcp list` show server state; `/mcp tools [server]` inspects tools; and
`/mcp reconnect|enable|disable <server>` applies session-scoped connection
changes. `/mcp add <server> <command> [args...]` imports a session-scoped stdio
server without editing `config.toml`. `/mcp new` (alias `/mcp create`) scaffolds
a dependency-free project-local stdio server and connects it for the session.
The command and menu do not provide an authentication action; `needs-auth` is
only a displayed connection state. In daemon mode the menu reads the passive
status projection and sends mutations back to the daemon; it does not own
transports or executable MCP clients.

### Model-facing inputSchema sanitization

Outbound MCP `inputSchema` is sanitized before any provider sees it
(`sanitizeMcpInputSchemaForModel` in
`runtime/src/mcp-client/model-facing-sanitization.ts`). The session tool
bridge (`runtime/src/mcp-client/tools.ts`) and the compatibility client
(`runtime/src/services/mcp/client.ts`) share that helper. Only the
model-facing catalog copy is rewritten. The MCP server still receives the
model's arguments over the protocol.

Intent: treat server metadata as untrusted capability description, not
instructions, and keep property names byte-identical so generated
arguments still match the server.

The sanitizer:

- Keeps structural keywords, including `$ref`, `$defs`, `definitions`,
  `properties`, `patternProperties`, and `dependentSchemas`
- Drops instruction-like annotations **outside** those schema maps:
  `description`, `title`, `examples`, `default`, `$comment`,
  `markdownDescription`, `deprecated`, `readOnly`, `writeOnly`
- Never rewrites keys. A Unicode lookalike or NFKC collision is
  `unsafe_key`, not a silent rename
- Bounds schema strings to **1,024** UTF-8 bytes, arrays to **64** items,
  and nesting to **16** levels
  (`MCP_MODEL_FACING_METADATA_LIMITS`). The finished JSON must be at most
  **32 KiB**
- Drops non-finite numbers and non-JSON values. Cycles, non-object
  roots, and accessor-only properties are `invalid_root`

A `$ref` that names a local `$defs` / `definitions` entry therefore
survives into the provider catalog:

```json
{
  "type": "object",
  "$defs": {
    "item": { "type": "object", "properties": { "id": { "type": "string" } } }
  },
  "properties": { "item": { "$ref": "#/$defs/item" } }
}
```

Failure is fail-open for the catalog: the model sees
`{ "type": "object", "properties": {} }` so the tool remains callable.
For `too_large` and `unsafe_key`, the session tool bridge logs a warning and
the compatibility client logs at MCP debug level. `invalid_root` does not log
a diagnostic.
Gemini's later object-root check accepts that fallback, so an empty
parameter list is not a Gemini schema error. Local `$ref` values that
survive sanitization are sent intact through native
`parametersJsonSchema`; they are no longer dropped by a local OpenAPI
compiler. See
[provider-tool-compat.md](../provider-tool-compat.md#gemini-native-json-schema).

### Compaction summaries stay tool-free

Bootstrap installs the live registry (`registry.toLLMTools()`, including every
`mcp.<server>.<tool>` schema) on the session provider. Ordinary agent turns
still inherit that factory catalog when a caller omits `tools`. Transactional
compaction does not.

`invokeCompactionProvider` (`runtime/src/services/compact/transaction.ts`)
passes an explicit empty catalog so constructor-scoped client tools and
provider-native server tools cannot be added after preflight accounting:

```text
tools: []
toolRouting: { allowedToolNames: [] }
```

`accountingOptionsForProvider` copies factory tools only when `options.tools`
is `undefined`. An empty array is an explicit catalog, so the MCP/builtin
schemas stay off the admitted summary. `providerNativeToolsForAccounting`
then filters Grok native tools (web search, x_search, code execution,
collections, remote MCP) by that allowlist. `[]` omits them. When no allowlist
is set, `toolChoice === "none"` also omits the native catalog. Compact uses the
empty allowlist instead.

#### Previous failure

Before the empty catalog, omitting `tools` inherited the
session factory list. Admission counted unused schemas against an already-full
window and denied `context_window_exceeded`. Auto-compact, `/compact`, and
mid-turn compact then failed to shrink the window (`mid_turn_compact_failed`).

#### What still counts tools

| Surface | Catalog in token count? |
| --- | --- |
| Agent turn / `runAdmittedModelCall` with `tools` omitted | Yes. Factory tools merge in. Grok native tools count unless allowlisted or `toolChoice` is `"none"`. Remote MCP without a complete native count still denies `token_accounting_uncertain`. |
| Auto-compact fire threshold (`estimateMessagesTokens`) | Yes. The count includes the system prompt, tools, framing, and reserved output. A large MCP catalog makes compact run earlier. |
| Compact **summary** (`invokeCompactionProvider`) | No. The call sends `tools: []` and an empty allowlist. |
| `/context` display (`session-compact.ts`) | Yes. It reconstructs the next-turn payload, including `toLLMTools()`. |

#### Caller rule

Callers that omit `tools` inherit the session catalog. A tool-free call must
pass `tools: []`. When Grok native tools must also stay off the wire, pass
`toolRouting: { allowedToolNames: [] }`. Compaction summarizes history and
must not advertise tools.

### CLI

```bash
agenc mcp serve [--transport stdio|sse]
agenc mcp add|list|get|remove|add-json|add-from-agenc-desktop
agenc mcp reset-project-choices
agenc mcp doctor
agenc mcp xaa
```

`serve` transport defaults and host/port for network modes come from config
`[mcp.server]` (the CLI rejects inventing `--host`/`--port` flags on the
command line). Full flag tables: [cli.md](cli.md).

### Sampling & roots

Session-owned managers can route `sampling/createMessage` through the active
runtime provider. Connections without a runtime session return a graceful
unavailable result. Host roots are advertised per the MCP connection.

## Inbound server

Two related layers:

| Layer | Path | Role |
| --- | --- | --- |
| Framework | `runtime/src/mcp-server/` | Protocol handlers, stdio/HTTP/SSE adapters |
| Config start entry | `runtime/src/mcp/server/start.ts` | What the CLI / daemon actually starts from `[mcp.server]` |

Prefer config `[mcp.server]` and the `agenc mcp` CLI rather than importing
framework modules from embedders.

The inbound server does not advertise tools: `tools/list` is empty and every
direct `tools/call` fails closed with `ADMISSION_IDENTITY_REQUIRED` and reason
`mcp_session_admission_identity_missing`. An injected tool registry is never
materialized or reached. Environment variables are never execution
authorization. Tool support can return only after requests are bound to a
native daemon session/capability and traverse the common permission, sandbox,
admission, redaction, and audit path.

Prompts and resources are scoped to the same canonical workspace: project
`.agenc/skills`, `.agenc/memory`, and `AGENC.md`. User-global skills, memory,
and instructions are never exposed by inbound serve.
Every candidate is canonicalized, regular-file checked, and rejected if a
symlink resolves outside the workspace. Resource listing remains metadata-only;
the server revalidates and reads only the resource selected by `resources/read`.

## Security notes

- Treat MCP tool results as **untrusted work data** (same framing discipline as
  channel payloads).
- Inbound `mcp serve` exposes prompts and resources only. Tools are neither
  advertised nor dispatched, even if a registry or legacy environment override
  is present.
- SSE remains loopback-only, disabled by default, and has no peer authentication.
  Prefer stdio when process-level peer isolation is required: any local process
  or OS user able to reach loopback may otherwise read the configured workspace
  with the AgenC owner's filesystem authority.
- Prefer supply-chain pins for untrusted third-party servers.
- Stdio servers run as your user with the configured env — only pass secrets you
  intend the child to see.

### Design record (2026-07-16)

The boundary follows the current MCP specification's principles that tool
execution requires explicit user control and robust access controls, and that
tool metadata is not itself an authorization decision:

- [MCP 2025-11-25 security and trust principles](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP tools security guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

Alternatives rejected: retaining an environment opt-in (no authenticated
identity, consent, or audit binding), sending mutations to the bare registry
dispatcher (bypasses native policy), and disabling the entire inbound server
(unnecessary for workspace-scoped read-only integrations). The fail-closed
subset preserves useful local reads while leaving one future re-enable point:
the daemon-owned admission kernel.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Plugin tools never appear after `agenc plugin install` | Scope is `project` or `local`? Those installs are repository-controlled and strip MCP. Reinstall with `--scope user`. Confirm `[plugins] enabled` and the plugin entry. Inspect `/mcp`. |
| `MCP error -32000: Connection closed` with no reason | Look for a `; server stderr:` suffix on the same error. On Linux Landlock fallback, workspace-write MCP is often `[sandbox_policy_unexpressible]`. Run `agenc doctor`. |
| `[sandbox_landlock_fallback]` from `agenc doctor` | Bubblewrap is unusable (commonly Ubuntu AppArmor userns). Install the generated profile or stay on plugin-scoped MCP / `read-only`. See [install.md](../install.md#ubuntu-apparmor-and-bubblewrap). |
| `[sandbox_required_unavailable]` saying the Linux helper must sit outside the workspace | A bare `agenc` opened `$HOME`. The helper lives under `~/.agenc` and can never leave a home-sized workspace. Open a project directory. See [tools-permissions-sandbox.md](tools-permissions-sandbox.md). |
| One plugin server missing, session still starts | A broken plugin source is skipped. A duplicate command/URL is suppressed by an enabled manual server. Check `/plugin` for `mcp-server-suppressed-duplicate`. |
| `/compact` or auto-compact denied `context_window_exceeded` on the **summary** | Summaries no longer inherit the MCP/builtin factory catalog or Grok native tools. If admission still denies, the transcript + system prompt + reserved output themselves exceed the window. Confirm the live window (not the 128k fallback), shrink `/compact` focus, or compact earlier. `/context` still shows the next-turn catalog size; that is not the summary request. |
| Mid-turn dies `mid_turn_compact_failed` after adding MCP servers | A large catalog can raise the estimate past the fire threshold and raise provider-reported `promptTokens` past the mid-turn outer gate. The summary request should still pass admission. Check the disable-flag rules and the 2-failure digest guard on [CP-0006](../design/critical-path/0006-compaction-transaction.md), and whether last-sample `promptTokens` disagreed with the compact-module estimate. |
| Gemini or another provider unexpectedly advertises an argument-taking MCP tool with empty `properties` | Sanitization may have replaced the schema with an open object (`too_large`, `unsafe_key`, or silent `invalid_root`). A legitimate no-argument schema can have the same shape and pass through unchanged. Compare the server's original `inputSchema`; check session-bridge warnings or compatibility-client MCP debug logs for the first two issue codes. Fix an invalid advertised schema; do not expect Gemini to reject the fallback. |
| Gemini fails locally at `tools["mcp.<server>.<tool>"].parameters` | The sanitized schema reached native `parametersJsonSchema` and failed the object-root proof (scalar/array/nullable root, unresolved `$ref`, or an empty finite `const`/`enum` intersection). See [provider-tool-compat.md](../provider-tool-compat.md#gemini-native-json-schema). |

## Related

- Tools / permissions overview: [`tools-permissions-sandbox.md`](tools-permissions-sandbox.md)
- Plugin install scopes, manifests, and repository-controlled stripping: [`skills-plugins.md`](skills-plugins.md)
- Gemini native JSON Schema and object-root proof: [`provider-tool-compat.md`](../provider-tool-compat.md#gemini-native-json-schema)
- Admission token accounting: [`provider-aware-token-accounting.md`](../design/provider-aware-token-accounting.md)
- Client README: [`../../runtime/src/mcp-client/README.md`](../../runtime/src/mcp-client/README.md)
- Architecture map: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
