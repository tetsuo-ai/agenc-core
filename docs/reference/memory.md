# Memory & persona reference

How AgenC loads durable instructions, persona, and auto-memory. Sources:

| Area | Path |
| --- | --- |
| Paths / auto-memory gates | `runtime/src/memory/paths.ts` |
| `AGENC.md` cascade + includes | `runtime/src/memory/agencmd.ts` |
| Persona files | `runtime/src/memory/persona.ts` |
| Entrypoint truncation / prompts | `runtime/src/memory/memdir.ts` |
| Privacy / secret scan | `runtime/src/memory/privacy.ts` |
| Public barrel | `runtime/src/memory/index.ts` |
| Team path helpers | `runtime/src/memdir/` |
| TUI editor | `/memory` → `runtime/src/commands/memory/` |

---

## Store paths

`AGENC_HOME` defaults to `~/.agenc` (`resolveAgencHome` / `getAgenCConfigHomeDir`).

| Store | Default path | Notes |
| --- | --- | --- |
| Config home / memory base | `$AGENC_HOME` | Override base with `AGENC_REMOTE_MEMORY_DIR` |
| Global durable memory | `$AGENC_HOME/memory/` | Entrypoint `MEMORY.md` |
| Project auto-memory | `<projectRoot>/.agenc/memory/` | Entrypoint `MEMORY.md` |
| Project instructions | `<projectRoot>/AGENC.md` | Preferred root instruction file |
| User instructions | `$AGENC_HOME/AGENC.md` | Private global |
| Daily auto-mem logs | `<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md` | Distilled later by dream/extract flows when enabled |

**Project auto-memory resolution** (`getProjectMemoryPath` / `getAutoMemPath`):

1. `AGENC_COWORK_MEMORY_PATH_OVERRIDE` (absolute full-path override)
2. `autoMemoryDirectory` in trusted settings only (policy / flag / local / user — **not** committed project settings)
3. If `AGENC_REMOTE_MEMORY_DIR` is set: `$base/projects/<sanitized-git-root>/memory/`
4. Else: `<projectRoot>/.agenc/memory/`

Git worktrees of the same repo share one auto-memory directory when a
canonical git root is found.

---

## Instruction cascade (`AGENC.md`)

Loaded by `agencmd` in priority order (later = higher attention):

1. **Managed** — e.g. system-wide managed `AGENC.md` / rules dirs
2. **User** — `~/.agenc/AGENC.md` (+ user rules dir)
3. **Project** — walk from cwd up: `AGENC.md` (preferred), **`AGENTS.md` fallback**, `.agenc/AGENC.md`, `.agenc/rules/*.md`
4. **Local** — `AGENC.local.md` (private project)

Also:

- **Auto-memory entrypoints** (`MEMORY.md` global + project) when auto-memory is enabled — framed as **untrusted persisted state**, not as override instructions
- **Persona** files (below) as Project-tier workspace identity

`@include` in memory files: `@path`, `@./rel`, `@~/home`, `@/abs` on leaf text
(not inside code fences). Circular includes skipped; missing files ignored;
binary extensions blocked.

Recommended soft cap: `MAX_MEMORY_CHARACTER_COUNT` (40_000). Entrypoint
`MEMORY.md` also line/byte truncated for prompt injection
(`MAX_ENTRYPOINT_LINES` 200, `MAX_ENTRYPOINT_BYTES` 25_000).

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

1. `AGENC_DISABLE_AUTO_MEMORY` — truthy → OFF, falsy → ON
2. `AGENC_SIMPLE` — OFF
3. Remote without `AGENC_REMOTE_MEMORY_DIR` — OFF
4. `autoMemoryEnabled` in settings.json
5. Default: **on**

When on, the agent may maintain `MEMORY.md` / topic files under the auto-memory
dirs; extract/background helpers may run on interactive sessions (also gated by
build features such as `EXTRACT_MEMORIES`). Session memory lives in conversation
state, not a separate durable path contract.

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

Persistent memory in the prompt is labeled untrusted: stale or model-authored
content must not override current user instructions, permission gates, or live
repo state.

---

## Project bootstrap files

`agenc init` creates:

- `.agenc/config.json`
- `AGENC.md`

See [cli.md](cli.md) · persona/onboarding [onboarding.md](../onboarding.md).
