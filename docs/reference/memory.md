# Memory & persona reference

How AgenC loads durable instructions, persona, and auto-memory. Sources:

| Area | Path |
| --- | --- |
| Paths / auto-memory gates | `runtime/src/memory/paths.ts` |
| `AGENC.md` cascade + includes | `runtime/src/memory/agencmd.ts` |
| Persona files | `runtime/src/memory/persona.ts` |
| Entrypoint truncation / prompts | `runtime/src/memory/memdir.ts` |
| Privacy / secret scan | `runtime/src/memory/privacy.ts` |
| Full-corpus retrieval index | `runtime/src/memory/full-corpus-index.ts` |
| Recall + scan fallback | `runtime/src/memory/find-relevant.ts` |
| Index constants / FTS contract | `runtime/src/memory/full-corpus-contract.ts` |
| Prompt attachment | `runtime/src/prompts/attachments/relevant-memories.ts` |
| Public barrel | `runtime/src/memory/index.ts` |
| Team path helpers | `runtime/src/memdir/` |
| TUI editor | `/memory` → `runtime/src/commands/memory/` |

---

## Store paths

The sole home authority is `AGENC_HOME`, defaulting to `$HOME/.agenc`
(`HomeContext` / `getAgenCHomeDir`).

| Store | Default path | Notes |
| --- | --- | --- |
| Config home / memory base | `$AGENC_HOME` | Override base with `AGENC_REMOTE_MEMORY_DIR` |
| Global durable memory | `$AGENC_HOME/memory/` | Entrypoint `MEMORY.md` |
| Project auto-memory | `$AGENC_HOME/projects/<sanitized-git-root>/memory/` | Entrypoint `MEMORY.md`; shared by the prompt, recall and extraction |
| Project instructions | `<projectRoot>/AGENC.md` | Preferred root instruction file |
| User instructions | `$AGENC_HOME/AGENC.md` | Private global |
| Daily auto-mem logs | `<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md` | Distilled later by dream/extract flows when enabled |
| Team memory | `<autoMemPath>/team/MEMORY.md` | When `TEAMMEM` is on |
| Full-corpus retrieval index | `$AGENC_HOME/derived-indexes/memory-v1.sqlite` | Derived cache only; rebuildable from memory files |

**Project auto-memory resolution** (`getProjectMemoryPath` / `getAutoMemPath`):

1. `AGENC_COWORK_MEMORY_PATH_OVERRIDE` (absolute full-path override)
2. The trusted canonical auto-memory directory preference (managed/user; never a committed project value)
3. `$base/projects/<sanitized-git-root>/memory/`, where `$base` is
   `AGENC_REMOTE_MEMORY_DIR` when set and `$AGENC_HOME` otherwise
   (`buildProjectMemoryDirectory`). Memory never lands inside the repository.

Git worktrees of the same repo share one auto-memory directory when a
canonical git root is found.

---

## Instruction cascade (`AGENC.md`)

Resolved for every coding-agent/review turn at the shared session boundary in
priority order (later wins only within workspace guidance):

1. **Managed** — `$AGENC_MANAGED_INSTRUCTIONS` or the platform managed `AGENC.md`: `/etc/agenc/AGENC.md` on Linux, `/Library/Application Support/AgenC/AGENC.md` on macOS, and `%ProgramData%\AgenC\AGENC.md` on Windows. Rules load from the `rules/*.md` directory beside that file.
2. **User** — `$AGENC_HOME/AGENC.md` plus `$AGENC_HOME/rules/*.md`
3. **Project** — walk from cwd: `AGENC.override.md`, `AGENC.md`, **`AGENTS.md` fallback** (`CLAUDE.md` is not a fallback), `.agenc/AGENC.md`, `.agenc/rules/**/*.md`
4. **Local** — `<projectRoot>/AGENC.local.md` only (not every ancestor)

Also:

- **Auto-memory entrypoints** (`MEMORY.md` global + project) when auto-memory is enabled — framed as **untrusted persisted state**, not as override instructions
- **Persona** files (below) as Project-tier workspace identity

Live instruction includes use `@include <path>` on their own line. Relative
targets must stay inside the canonical tier/workspace boundary. Absolute and
escaping targets are denied unless an embedding host supplies a revocable
trusted-operator approval bound to the exact workspace, including source
digest, and target identity. Symlinks, hard links, special files, broken links,
unstable reads, and invalid UTF-8 fail closed. The legacy `@path` parser remains
only for compatibility attachment discovery and cannot authorize external
reads.

The provider receives the resolved envelope exactly once through its native
system-prompt field. See
[secure project instructions](../design/secure-project-instructions.md) for
request-surface exclusions, filesystem guarantees, and platform limits.

Recommended soft cap: `MAX_MEMORY_CHARACTER_COUNT` (40_000). Entrypoint
`MEMORY.md` also line/byte truncated for prompt injection
(`MAX_ENTRYPOINT_LINES` 200, `MAX_ENTRYPOINT_BYTES` 25_000).

### Memory prompt

When auto memory is enabled, `loadMemoryPrompt()` (`memory/memdir.ts`)
returns two pieces that the system prompt assembler places separately:

- `instructions`: path-free guidance (when to save, where, the
  one-fact-per-file frontmatter format, the `MEMORY.md` index, how to recall)
  rendered under `# auto memory` in the cacheable static head.
- `directories`: the `# Memory directories` block with the global and project
  paths (and any host-injected per-session guidance) rendered in the dynamic
  tail.

`prepareTurnRuntimeInputs`, `assembleBaseInstructionsForModel` and the
`/context` estimate all go through `resolveMemoryPromptInputs()`, and the
loader creates both memory directories so the model can write to them
without checking first. The block is about 700 tokens in total.

Each live turn also appends the global and project `MEMORY.md` indexes to
the instruction envelope (`prompts/live-instructions.ts`), truncated by
`truncateEntrypointContent` and framed as untrusted
`<persistent_memory_context type="AutoMem">` blocks ahead of the trusted
base prompt.

The file tools (`FileRead`, `Glob`, `Grep`, `Write`, `Edit`, `MultiEdit`)
admit both memory roots regardless of the workspace boundary
(`resolveToolAllowedPaths` folds in `getDurableMemoryRoots()`), so the model
can read and write where the prompt points. Only those two directories are
admitted: sibling state under `$AGENC_HOME` such as
`projects/<slug>/sessions/`, `config.toml` or `auth.json` stays denied, and
memory writes through these tools are screened by `checkMemorySecrets`.

---

## Persona files (workspace root)

OpenClaw-parity names in the **workspace root only** (not ancestors):

| File | Role |
| --- | --- |
| `USER.md` | Who the human is |
| `SOUL.md` | Agent persona, tone, boundaries |
| `IDENTITY.md` | Established agent identity (often agent-written) |
| `BOOTSTRAP.md` | One-time ritual; injected **only while `IDENTITY.md` is absent** |

- Per-file prompt budget: **16 KiB** (`PERSONA_FILE_MAX_BYTES`); disk file unchanged
- Injected into the system prompt persona section at conversation start (stable for that conversation)
- Never overrides permission gates or safety rules
- Fresh edits apply on the **next** new conversation

Onboarding: `agenc onboard identity` walks the naming ritual for these files.

---

## Automatic memory

**Enabled by default.** `isAutoMemoryEnabled()` priority:

1. Typed simple mode selected by `--bare` — OFF
2. When `AGENC_REMOTE` is set and `AGENC_REMOTE_MEMORY_DIR` is unset — OFF
3. Canonical `autoMemoryEnabled` in `config.toml`
4. Default: **on**

When on, the agent may maintain `MEMORY.md` / topic files under the auto-memory
dirs; extract/background helpers may run on interactive sessions (also gated by
build features such as `EXTRACT_MEMORIES`). Session memory lives in conversation
state, not a separate durable path contract.

The session-notes subagent (`memory/session`, writes `summary.md`) is **off by
default**: nothing reads the notes yet and compaction already summarizes the
same material, so it only runs when `AGENC_SESSION_MEMORY_ENABLED=1` is set
(`AGENC_DISABLE_SESSION_MEMORY=1` still wins). Failures surface as the
`session_memory_update_failed` warning.

The extraction child (`services/extractMemories`) forks the full history on
every third eligible terminating turn by default (`DEFAULT_MIN_ELIGIBLE_TURNS`),
sees only the file read/write tools (`MEMORY_EXTRACTION_TOOL_ALLOWLIST`) inside
the memory directory, and never blocks a turn: in-flight runs are drained at
session shutdown. Every gate that stops a run and every failed run emits a
`warning` event with cause `memory_extraction_skipped` or
`memory_extraction_failed` (session log only; not shown in the transcript).

Query-time recall of those files uses the full-corpus index below when a
resolved `AGENC_HOME` is available. Session-start recall never uses the index.

---

## Full-corpus memory index

`PersistentMemoryIndex` is a derived SQLite/FTS5 cache over durable `.md`
memory files. Source files remain authoritative. The index is restartable and
rebuildable; deleting `memory-v1.sqlite` only drops cache state.

There is no operator config or env toggle for the index. `findRelevantMemories`
opens `$AGENC_HOME/derived-indexes/memory-v1.sqlite` when the prompt attachment
supplies an absolute home. Schema version is `MEMORY_INDEX_SCHEMA_VERSION` (2).
FTS5 `unicode61` is required; without it refresh is `degraded` and query is
`unavailable`.

The freshness contract is [CP-0005](../design/critical-path/0005-derived-index-freshness.md).
Queries pin one complete generation. Staging, failed, and superseded
generations are never queryable.

### Recall workflow

`relevantMemoriesProducer` (auto-memory on, session memory mode not
`disabled`, under the 60 KiB session-surface budget) calls
`findRelevantMemories` with:

1. Global root `getGlobalMemoryPath()` (`$AGENC_HOME/memory/`, `role: "global"`)
2. Project root `getProjectMemoryPath()` (`role: "project"`)

Those two directories are the attachment's search set. They are the same
resolvers the memory prompt and the permission carve-outs use, so recall
follows remote bases, trusted overrides and worktree-shared canonical roots
and searches exactly where the model and the extraction child write.

On a non-empty user query (`mode: "query"`):

1. `refresh()` applies at most one implicit build slice
   (`MAX_MEMORY_INDEX_BUILD_SLICE_MS`, 30s). Pending work continues in the
   background.
2. `query()` pins the current complete generation, ranks FTS candidates,
   and fuses project / global / recent lists.
3. If the index is missing, closed, FTS-less, or
   `query_resource_limited` / `unavailable`, recall falls back to a bounded
   filesystem scan (`scanMemoryRoots` + `rankMemoryHeaders`).
4. An optional admitted memory selector may rerank, but only when more than
   `MAX_RELEVANT_MEMORIES` (5) candidates ranked: with five or fewer there is
   nothing to drop, so the main-model round trip is skipped. The selector has
   a 5 s deadline (`MAX_MEMORY_SELECTOR_MS`); failure or timeout returns the
   lexical top 5. Each surfaced file is then truncated to 200 lines / 4 KiB
   for the prompt.

`mode: "session_start"` (first empty-query turn, not a subagent) always
scans. It never opens the index.

An explicit refresh (`refresh(..., { explicit: true })`) keeps taking slices
until complete or `MAX_MEMORY_EXPLICIT_REFRESH_WAIT_MS` (300s). Implicit
refresh does not wait.

### Incremental writers vs reader pins

Two update paths:

| Path | When | How |
| --- | --- | --- |
| Full rebuild | First build, explicit refresh, watcher not `healthy`, or change-log overflow | Invisible staging generation, bounded slices, atomic publish of a new complete generation |
| Incremental | Watcher `healthy` and the change log is ahead of the published cursor | Claim a builder lease on the **current complete** generation, drain live reader pins, apply coalesced create/update/delete/rename rows, then advance that generation's change cursor |

The incremental path is the one that used to starve: queries kept the
published generation pinned, so the writer refused the lease forever and
edits never landed.

Current lease rules (`#claimBuildLease`, `#pinCurrentGenerations`,
`#waitForIncrementalReaderDrain`, `#applyIncrementalChanges`):

1. A builder lease (`MEMORY_INDEX_BUILD_LEASE_MS`, 60s) may be taken on a
   complete generation even while reader pins exist. The previous empty-pin
   requirement on claim is gone.
2. The writer then waits up to one build slice (30s; tests may shrink this
   with `incrementalReaderDrainMs`, which is not an operator knob) for live
   pins to clear, polling every `MEMORY_WATCH_DEBOUNCE_MS` (100ms).
3. After the drain it **renews** the lease before filesystem preparation.
   A lease that expired during the wait is reclaimed; if another owner holds
   it, refresh returns `refresh_pending`.
4. New queries cannot pin a generation that still has a live builder lease.
   They return `unavailable` with
   `memory index update is in progress; retry the query` (recall then
   scans).
5. The incremental commit transaction still refuses to apply if any live
   pin remains, or if this process no longer owns the lease. That returns
   `refresh_pending` with
   `memory index update is waiting for an active reader or writer` instead
   of blocking indefinitely.
6. Crossing `MAX_MEMORY_INDEX_BYTES` (512 MiB) during the apply rolls the
   transaction back.

Background refresh retries a `refresh_pending` incremental contention with
the same 100ms backoff. Existing in-flight queries keep their pinned
snapshot and header bytes until they finish or their pin lease expires
(heartbeat 10s, lease 60s).

### Refresh and query outcomes

`refresh()`:

| Kind | Meaning |
| --- | --- |
| `complete` | Every requested root is a complete generation with watcher `healthy` |
| `refresh_pending` | A slice, lease, reader drain, concurrency cap, or remaining change-log work is still outstanding |
| `degraded` | FTS unavailable, a root `failed`, or a complete generation with watcher `degraded` / `overflow` |

`query()`:

| Kind | Meaning |
| --- | --- |
| `complete` | Pinned generation, watcher `healthy` |
| `stale` | Candidates returned, but watcher or freshness is not fully healthy |
| `unavailable` | No complete generation, writer lease held, index closed, or FTS missing |
| `query_resource_limited` | Pin heartbeat/lease lost or the query pool refused the work |

`pollRefresh(generationToken)` maps a staging row to `refresh_pending`.
`cancelRefresh` fails that staging generation.

### Limits and watcher health

Named caps from `full-corpus-contract.ts` (not `config.toml`):

| Cap | Value | Effect |
| --- | --- | --- |
| `MAX_MEMORY_INDEX_ROOTS` | 64 | Excess roots fail closed before I/O |
| `MAX_MEMORY_FILES_PER_ROOT` | 1_000_000 | Per-root file bound |
| `MAX_MEMORY_INDEX_CONCURRENT_BUILDS` | 2 | Extra builds return `refresh_pending` |
| `MAX_MEMORY_INDEX_CHANGE_LOG_EVENTS` | 100_000 | Further `recordChange` marks watcher `overflow` and requires a full rebuild |
| `MAX_MEMORY_FTS_CANDIDATES` | 200 | Per-root FTS candidate cap |
| `MAX_MEMORY_HEADER_UTF8_BYTES` | 65_536 | Fingerprint / header preimage bound |
| `MAX_MEMORY_INDEX_WATCHERS` | 64 | Process-wide watchers |
| `MEMORY_INDEX_ROOT_IDLE_TTL_MS` | 30 days | Unused roots are eligible for scoped cleanup |

Watcher health: `healthy` (incremental updates allowed), `degraded`
(unreadable path, non-file change, or audit miss — rebuild required),
`overflow` (change log full or watcher overflow). Same-size/same-mtime
header edits still change the item fingerprint because exact bounded
header bytes are in the preimage.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| New memory files not recalled on the next query | Implicit refresh is one 30s slice. Wait for background refresh, or expect `refresh_pending` under sustained query load until pins drain. |
| Recall looks like a cold filesystem walk | Index path unset (no absolute `AGENC_HOME`), FTS5 missing, query during a writer lease, or `session_start` mode. Those paths scan and ignore the SQLite cache. |
| `refresh_pending` + "waiting for an active reader or writer" | A live pin outlived the drain window, or the commit saw a pin/lease race. Not a hang. Retry; overlapping queries should now unblock the writer instead of starving it. |
| `refresh_pending` + "another daemon owns the bounded memory index writer lease" | A second process holds the 60s builder lease. Wait for expiry or the other owner to release. |
| Watcher `overflow` / `degraded` | Incremental apply is disabled. The next successful full rebuild republishes a complete generation. Do not delete source `MEMORY.md` files. |
| Database growing toward 512 MiB | Applies that would grow past `MAX_MEMORY_INDEX_BYTES` roll back. The last complete generation stays queryable. |
| Stale prompt text after an edit | An in-flight query can still return the pinned snapshot. The following query, after pins drain, sees the incremental cursor. |

Do not treat `$AGENC_HOME/derived-indexes/` as a backup of memory content.
Scoped cleanup may delete derived cache only.

---

## `/memory`

Slash command: open the interactive memory file picker/editor (`memory.tsx`).
Headless/daemon dispatch returns text directing the operator to the TUI.

Related mentions: memory mention aliases / `@` syntax from project-memory helpers
(`MEMORY_MENTION_ALIASES`, `isMemoryMention`).

---

## Privacy & secrets

`runtime/src/memory/privacy.ts`:

- Classifies paths as personal auto-memory vs team (feature `TEAMMEM`) vs session transcript / session-memory under config home
- Secret scanning / redaction before write or sync paths (`scanForSecrets`, `redactSecrets`, `checkTeamMemSecrets`)
- Auto-managed memory files are distinct from operator instruction files such as `AGENC.md`

Durable memory writes are screened for secrets: `checkMemorySecrets` denies a
`Write` into any global or project memory file whose content matches a secret
rule, and the extraction child's tool policy denies `Write`/`Edit`/`MultiEdit`
content the same way. Recalled memory content and the loaded `MEMORY.md`
indexes pass through `redactSecrets` before they reach the prompt.

Persistent memory in the prompt is labeled untrusted: stale or model-authored
content must not override current user instructions, permission gates, or live
repo state.

---

## Project bootstrap files

`agenc init` creates:

- `.agenc/config.toml`
- `AGENC.md`

See [cli.md](cli.md) · persona/onboarding [onboarding.md](../onboarding.md).
