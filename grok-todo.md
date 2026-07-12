# Grok / xAI full-surface parity — AgenC backlog

> **Audience:** implementers closing the gap between **Grok 4.5 (and full xAI API)**
> and AgenC when users run Grok via **`XAI_API_KEY` / aliases** or **`/grok-login`**.
> **Not** a general product roadmap — see `docs/roadmap.md` and `TODO.md`.
>
> **Generated:** 2026-07-12  
> **Method:** parallel codebase map + xAI docs map + Grok Build tool inventory,
> then independent verification agents (code + docs) + senior engineer review.  
> **Status:** Phase 0–2 + G3 + G11/G13/G24 **landed** on branch `feat/grok-parity-g0-g24` (2026-07-12). Residual: G9/G10/G16 media modes, G12/G14/G15/G20 polish.
> **Senior review verdict:** APPROVE-WITH-CHANGES → blockers incorporated.
> **Absolute verification:** Strong HAVE 14/14 CONFIRMED; gaps 12/12 CONFIRMED;
> tasks G0–G24: **0 ALREADY FIXED**, **0 WRONG**, 3 PARTIAL (G12/G18/G20 polish depth).

---

## 0. Non-negotiable design principles

1. **Grok features are Grok-only.** Server-side xAI tools, Imagine media, and
   xAI-specific request fields apply **only** when the active session provider is
   `grok` (slug aliases: `xai` → `grok`), the host is direct xAI
   (`api.x.ai` / documented allowlist — **not** OpenRouter), **and** the model
   family supports them. Non-Grok providers (OpenAI, Anthropic, Ollama, OpenRouter
   including `x-ai/grok-*`, local vLLM) must never receive `web_search` /
   `x_search` / `code_interpreter` / Imagine tools or xAI-only request fields.
2. **Follow official xAI docs**, not Grok Build tool *names*. Prefer Responses
   API shapes from [docs.x.ai](https://docs.x.ai). Tools:
   `/developers/tools/*`. Media: `/developers/model-capabilities/imagine` +
   rest-api-reference images/videos.
3. **Auth paths (split by surface):**
   - **BYOK:** `XAI_API_KEY` → `GROK_API_KEY` → `AGENC_XAI_API_KEY` (**always wins**).
   - **Subscription OAuth:** `/grok-login` / `/grok-logout` → inference on
     `api.x.ai` / `*.grok.com` only. Not public developer-API OAuth.
   - **Chat + server tools + reasoning:** BYOK **or** OAuth.
   - **Imagine / TTS / video REST:** require BYOK until OAuth is **empirically
     verified** on those endpoints; fail with a clear message under OAuth-only.
4. **Do not bust other models.** Every new tool, payload, or request field needs
   a **fail-closed gate** (session provider + model + host allowlist) **and**
   regression tests that non-Grok turns and **tool registries** are unchanged.
5. **Do not clone Grok Build’s entire client tool list.** Map to xAI server tools,
   existing AgenC LIVE tools, or small Grok-gated agent tools.
6. **Cost / safety:** server tools bill per successful call; agent loops amplify
   tokens. **Deliberate defaults** (expensive tools off until enabled). X **write**
   tools stay opt-in MCP, never default.
7. **One search architecture (locked — Pattern A).** Match today’s WebSearch
   design: LIVE client tool → optional one-shot native xAI server tool when
   session provider is `grok`. Do **not** dual-bill (LIVE wrapper + continuous
   main-loop injection of the same capability). See §3 and G1.
8. **One config surface (locked).** All Grok capability flags live under a single
   provider-scoped schema block (e.g. `[llm.xai]`), applied only when
   `provider === "grok"`. No ad-hoc global `tools_config` flags that leak to
   other providers. **Ship G6 before productizing G1/G2/G5/G7/G8.**

### Working protocol (same spirit as `TODO.md`)

1. Scout the tree first — re-verify each task still open.
2. One task at a time unless parallel-safe.
3. Revert-sensitive tests for every behavioral change.
4. Gates before done: `npm run typecheck`, `npm test`, and for TUI/daemon paths
   `check:tui-runtime-startup` / relevant e2e.
5. Update this file as tasks land.

---

## 1. What “ALL of it” means (scope)

### In scope (direct `api.x.ai` + Grok provider in AgenC)

| Family | Official surface | AgenC target |
| --- | --- | --- |
| Chat / agentic | Responses `POST /v1/responses` | Grok adapter (strong HAVE) |
| Built-in tools | `web_search`, `x_search`, `code_interpreter`, `file_search`, remote `mcp` | Productized, Grok-gated |
| Client tools | AgenC LIVE tools as `type: "function"` | HAVE (schema-normalized) |
| Citations | `citations` + inline `[[N]](url)` | Stream/UI completeness |
| Imagine image | `/v1/images/generations`, `/v1/images/edits` | Agent tools + gateway parity |
| Imagine video | `/v1/videos/*` async | Agent tools (async) |
| Vision | chat `input_image` | Mostly HAVE |
| Files / collections | Files + collections RAG | Product UX + `file_search` |
| Reasoning | `reasoning.effort` | HAVE + multi-agent fixes |
| Caching | `prompt_cache_key` | HAVE |
| Auth | BYOK + `/grok-login` | HAVE (gateway auth gaps) |
| Catalog | public model IDs | Align + multi-agent safety |

### Out of scope / non-goals

- Cloning Grok Build UI chrome (`render_inline_citation` as a model tool, goals branding).
- Shipping environment-specific MCP suites as core defaults.
- Default-on X **write** API — opt-in MCP only.
- `grok-composer-*` full AgenC tool loop (ACP only; keep current spawn).
- Coin/token marketplace logic.
- Replacing local `exec_command` with only xAI `code_interpreter` — offer both.
- Full OpenRouter parity for server tools / Imagine (honest matrix only — G24).
- Grok Build–style `memory_search` / `memory_get` (general product, not Grok-only).
- Realtime Voice Agent / STT product (separate milestone — G17).

### Grok Build tools → AgenC mapping

| Grok Build | Class | AgenC approach |
| --- | --- | --- |
| `web_search` | xAI server / client | LIVE `WebSearch` → one-shot native `web_search` on Grok |
| `open_page` / `open_page_with_find` | Client | `web_fetch` + `Browser` |
| `x_*` (four tools) | Build client; xAI unifies as **`x_search`** | LIVE `XSearch` one-shot (Pattern A) |
| `image_gen` / edit / video | Imagine REST | Grok-gated LIVE tools (provider + BYOK) |
| `web_fetch` | Client | LIVE `web_fetch` |
| Coding tools | Client | LIVE catalog |
| Session MCPs | MCP host | Config, not core defaults |

---

## 2. Ground truth today (verified 2026-07-12)

### Strong HAVE

| Area | Evidence / nuance |
| --- | --- |
| Default provider/model | `defaultConfig()` → `grok` / `grok-4.5` (`config/schema.ts`) — **docs still often say 4.3** |
| BYOK key order | `resolveApiKey`: `XAI_API_KEY` → `GROK_API_KEY` → `AGENC_XAI_API_KEY` |
| OAuth login | `/grok-login` / `/grok-logout`; BYOK overrides OAuth |
| Responses adapter | `llm/providers/grok/*`, `wire/responses-xai.ts` |
| Native tool **plumbing** | `provider-native-search.ts`: all five built-in types + remote MCP |
| Native web (product) | LIVE `WebSearch` **one-shots** native `web_search` when session provider is `grok` (`runGrokNativeWebSearch`). Session bootstrap does **not** set `extra.webSearch`. Latent continuous injection exists if `extra.webSearch` is set on the main GrokProvider — not the product default |
| Gating non-Grok (native defs) | `provider !== "grok"` → `[]` |
| Reasoning effort | Fail-closed allowlist (4.3 / 4.5 / multi-agent / build-latest) |
| `prompt_cache_key` | Adapter + `shape-request.ts` |
| Citations stream | `CitationStreamParser` |
| Vision | Catalog + adapter; vision model switch |
| Composer ACP | `grok-composer-*` → Grok CLI ACP; tools off by default |
| Gateway | `x_search`, Imagine image, TTS (key = `XAI_API_KEY` only today) |
| Tool schema strictness | `normalizeToolParamSchema` (`docs/provider-tool-compat.md`) |

### Verified gaps

| Gap | Severity | Notes |
| --- | --- | --- |
| Multi-agent still `supportsToolUse: true` | **P0** | xAI: no client function tools; AgenC still attaches LIVE tools |
| `supportsGrokServerSideTools` fail-open on empty model | **P0** | `if (!normalized) return true` |
| No `[llm.xai]` product config | **P0** | Plumbing via provider `extra` only; schema empty for xSearch/codeExecution/collections/remoteMcp |
| `x_search` not on CLI agent loop | **P0** | Gateway only |
| `code_interpreter` not productized | **P1** | Plumbing only |
| `enable_image_search` missing | **P1** | Types + builder only have image understanding |
| Imagine agent tools missing | **P1** | Gateway meme image gen only; ChatGPT image gate is irrelevant for Grok |
| Collections / remote MCP config | **P1** | Plumbing only |
| Gateway auth aliases / OAuth | **P1** | `XAI_API_KEY` only |
| Docs seed still 4.3 | **P2** | providers.md, config.md, cli.md, INDEX.md, **ARCHITECTURE.md** claim `defaultConfig`/`fresh seed` = 4.3 while code is **4.5** |
| Dual WebSearch stacks | **P2** | model-facing vs `tools/WebSearchTool/` |
| Files management / TTS agent / video | **P1–P2** | media + RAG completeness |

### xAI docs (CONFIRMED)

- Responses tools: `web_search`, `x_search`, `code_interpreter`, `file_search`, `mcp`, `function`.
- Domains under `filters`; `enable_image_search` / `enable_image_understanding` **top-level** on tool.
- Multi-agent: **no** client-side function calling; built-ins + remote MCP only.
- Imagine: `/v1/images/generations`, `/v1/images/edits`; video async create + `GET /v1/videos/{request_id}`.
- Inline citations default on for Responses.
- Developer API = API keys; product OAuth separate.

---

## 3. Architecture (Grok-only, fail-closed)

### Locked search pattern (Pattern A)

```
User asks for web/X research
        │
        ▼
LIVE client tool (WebSearch / XSearch)
        │
        ├─ session provider === "grok"
        │     && host is direct xAI
        │     && model supports server tools
        │     && capability flag on
        │         → one-shot Responses call with ONLY that server tool
        │         → return results + citations to main agent
        │
        └─ else → non-native fallback (DuckDuckGo / configured SERP / error)
```

Main chat turn continues to send AgenC LIVE tools as `type: "function"` for
normal coding models. **Do not** also inject the same server search tool on
every main-loop request (avoids dual billing and dual UX).

**Exception:** multi-agent models — **no** client function tools; only server
built-ins + remote MCP when enabled (G0).

### Gate stack

```
Media / server tools / xAI request fields
  1. session provider === "grok"
  2. inference host allowlist (api.x.ai / *.grok.com) — not OpenRouter
  3. model family allowlist (fail-closed if unknown/empty)
  4. capability flag from [llm.xai] (defaults deliberate)
  5. credentials: chat may use OAuth; media REST requires BYOK until verified
  6. permissions / sandbox for workspace writes
```

**Imagine tools must not register** merely because `XAI_API_KEY` is present while
the user is on Claude/GPT.

### Defaults (deliberate cost control)

| Capability | Default (Grok 4.5 direct) | Notes |
| --- | --- | --- |
| Native web via LIVE `WebSearch` | **on** (status quo) | Already productized one-shot path |
| LIVE `XSearch` / native `x_search` | **off** | Enable via `[llm.xai]` / slash / env |
| `code_interpreter` | **off** | Billable; opt-in |
| `file_search` / collections | **off** | Needs collection IDs |
| remote MCP (xAI server) | **off** | Distinct from client MCP |
| `enable_image_search` | **off** | Opt-in |
| Imagine / video / TTS | **off** until tool used + permissions | BYOK for REST |

---

## 4. Task backlog

### P0 — Correctness & schema spine (ship first)

#### G0. Multi-agent model: strip client function tools

- **Finding:** xAI multi-agent does not support client-side function calling.
  Catalog: `supportsToolUse: true` (`model-catalog.ts`). Adapter still attaches
  AgenC LIVE tools. Also listed in `VISION_MODELS_WITH_TOOLS`.
- **Docs:** https://docs.x.ai/developers/model-capabilities/text/multi-agent
- **Do:**
  - Detect `grok-4.20-multi-agent*` (all aliases).
  - In tool **assembly**, strip all AgenC `type: "function"` LIVE tools.
  - Allow only server built-ins + remote MCP when `[llm.xai]` enables them.
  - Catalog: set metadata so UI/runtime do not claim full coding tool use
    (`supportsToolUse: false` **or** introduce `supportsClientFunctionTools`
    if you need to distinguish — document the choice).
  - Remove multi-agent from allowlists that imply client tools.
  - UX: clear error/help when user expects coding tools; note that
    `reasoning_effort` maps to **agent count** (4 vs 16), not “think harder.”
- **Touch:** `model-catalog.ts`, grok adapter / tool assembly, `structured-output.ts`
  comments, tests.
- **Tests:** multi-agent request has **zero** `type: "function"` tools; `grok-4.5`
  still has function tools.

#### G4. Fail-closed `supportsGrokServerSideTools`

- Empty/undefined/unnormalizable model → **false** (today returns `true`).
- Tests: revert-sensitive unit tests (must fail before flip).
- **Do not** cargo-cult flip `webSearchToolType` enum; Grok uses
  `supportsSearchTool` → native path hints. Catalog enum cleanup is separate
  and optional.

#### G6. Single `[llm.xai]` capability profile (schema first)

- **Ship before G1/G2/G5/G7/G8.**
- Add config schema + loader → provider factory `extra` fields already partially
  present in `llm/provider.ts` (`xSearch`, `codeExecution`, `collectionsSearch`,
  `remoteMcp`, `webSearch`, options).
- Suggested fields (names illustrative; keep provider-scoped):

  ```toml
  [llm.xai]
  web_search = true           # default true — drives LIVE WebSearch native path
  x_search = false
  code_execution = false
  enable_image_search = false
  enable_image_understanding = false
  # collections / remote_mcp tables as nested blocks when enabled
  ```

- Applied **only** when session provider is `grok` + direct xAI host.
- Optional env overrides: `AGENC_XAI_X_SEARCH=1`, etc.
- Docs: config reference + providers.md.
- **Touch:** `config/schema.ts`, loader, `provider.ts`, resolve path into
  `GrokProvider` / `LLMXaiCapabilitySurface`.

---

### P0/P1 — Productize built-in tools (after G6)

#### G1. LIVE `XSearch` on main CLI agent (Pattern A)

- **Finding:** Gateway has hosted `x_search`; CLI agent does not.
- **Docs:** https://docs.x.ai/developers/tools/x-search
- **Design (locked):** Mirror `WebSearch` / `runGrokNativeWebSearch`:
  - LIVE tool `XSearch` (name TBD but public catalog-stable).
  - When session provider is `grok` + `llm.xai.x_search` (or tool forced on)
    + model supports server tools → one-shot Responses with `{ type: "x_search", … }`.
  - Options from `LLMXSearchConfig` (handles, dates, image/video understanding).
  - Default **off** in G6 profile (enable via config/slash).
- **Do not** continuous-inject `x_search` on every Grok chat request (unless a
  future Pattern B epic rewrites both web and X and demotes LIVE wrappers —
  out of scope here).
- **Safety:** never for non-Grok; no X write APIs; dual-billing guard with G19.
- **Tests:** grok + flag → native call; non-Grok registry has no tool or tool
  refuses; OpenRouter snapshot clean.

#### G2. Productize `code_interpreter`

- Responses type `code_interpreter` (already in payload builder).
- G6 flag `code_execution` default **off**.
- When on: inject into Grok Responses tools (or one-shot tool if preferred for
  cost isolation — document choice; injection is fine for code interpreter
  because there is no dual LIVE path today).
- Keep local `exec_command`.
- **Tests:** payload only when grok + flag.

#### G5. `enable_image_search` on web_search

- Add `enableImageSearch` to `LLMWebSearchConfig` + `buildWebSearchPayload`
  as top-level `enable_image_search`.
- Wire through G6 flag; default off.
- Docs: web-search image embeds.

#### G7. Collections `file_search` product surface

- Config: collection / `vector_store_ids` + enable flag.
- Inject `file_search` when set.
- Distinct from G15 (Files upload / attachment_search).

#### G8. Remote MCP (xAI server `mcp` tool)

- Config under `[llm.xai.remote_mcp]` — **never** confuse with client
  `mcp.<server>.<tool>`.
- Fields: `server_url`, `server_label`, auth, `allowed_tools`.
- Docs: https://docs.x.ai/developers/tools/remote-mcp

---

### P1 — Media (after chat spine)

#### G3. Imagine LIVE image generation

- `POST /v1/images/generations`
- Models: `grok-imagine-image`, `grok-imagine-image-quality`
- Params: prompt, n, aspect_ratio, resolution, response_format
- Save under workspace; return path
- **Gate stack:** session `provider === "grok"` **and** BYOK **and** permissions
  — **not** “has XAI key while on Claude”
- Do **not** use ChatGPT `imageGenerationToolAuthAllowed`
- Default: tool available only on Grok sessions; invocation is explicit

#### G9. Imagine image edit + multi-image (≤3)

- `POST /v1/images/edits`
- Same gate stack as G3

#### G10. Imagine video family

- Create + poll `GET /v1/videos/{request_id}`
- Text/image-to-video; edit; extension
- Reference-to-video: **only** `grok-imagine-video` (reject on `…-1.5`)
- Long-running via Monitor / task board
- Same gate stack; document $/sec

#### G11. Gateway auth parity

- Full key alias chain + optional OAuth where API accepts it
- Independent of G1 (do not block agent loop)

#### G12. Citations polish

- **Status after absolute verify: PARTIAL (not a full missing feature).**
  Adapter already extracts provider `citations`; stream has
  `CitationStreamParser` for a different tag format (`<oai-mem-citation>`), not
  xAI markdown `[[N]](url)`.
- Do: TUI/transcript rendering for xAI inline cites; optional
  `include: ["no_inline_citations"]`; align stream parser with Responses cites.
- Touch also: `stream-parser.ts`, Grok adapter citation extract, `responses-xai.ts`.

---

### P2 — Catalog, docs, hygiene, advanced

#### G13. Model catalog + docs default drift

- Fix systematic “fresh config is grok-4.3” claims in at least:
  `docs/reference/providers.md`, `docs/reference/config.md`,
  `docs/reference/cli.md`, `docs/INDEX.md`, **`docs/ARCHITECTURE.md`**
  → **4.5** to match `defaultConfig().model`.
- Catalog completeness for public IDs; imagine models as media, not chat.
- Optional: clarify `webSearchToolType` vs `supportsSearchTool` for Grok.

#### G14. Vision + tools edge cases

- `VISION_MODELS_WITH_TOOLS` vs multi-agent (G0) and current default vision model
- Document 20 MiB / jpg-png limits

#### G15. Files API + attachment_search

- Upload/attach for auto `attachment_search` (higher fee than collections)
- Separate from G7

#### G16. TTS agent/slash surface

- Reuse `gateway/voice.ts` patterns; BYOK; Grok session gate

#### G18. Advanced Responses features

- **Status after absolute verify: PARTIAL.** Wire already supports
  `max_turns`, `prompt_cache_key`, encrypted-reasoning include
  (`responses-xai.ts`). Product/config surface incomplete; batch / Responses
  WebSocket / priority still open. Non-blocking.

#### G19. Dual WebSearch stack hygiene

- Document LIVE path (`bin/model-facing-tools.ts` `WebSearch`) as canonical
- Second stack: `tools/WebSearchTool/**` + `tools.ts` registration
- Guard: never bill both LIVE native one-shot and injected main-loop web_search
  for the same user intent
- Tied to G1/G6 acceptance

#### G20. Cost / usage UX

- **Status after absolute verify: PARTIAL.** Usage fields exist
  (`webSearchRequests`, server-side tool usage in adapter); budget package
  exists. Full operator UX / soft caps incomplete.

#### G24. OpenRouter managed Grok: honest capability matrix

- What works vs requires direct `api.x.ai`
- **Code already hard-gates** native defs with `provider !== "grok"` → `[]`
  (OpenRouter provider slug never gets them). Gap is **docs honesty** +
  regression snapshots so this cannot regress.
- Docs: `docs/managed-openrouter.md`, `docs/reference/providers.md`

---

### P3 — Separate milestones

#### G17. STT / Voice Agent (realtime WebSocket)

- Full product; not on critical path for coding-agent Grok parity.

#### G22. Optional MCP examples

- Document `xai-docs` / X API MCP for power users; never default X write.

#### G23. Enterprise: mTLS, ZDR, management API keys

---

## 5. Implementation order (locked)

```
Phase 0 — Correctness
  G0  multi-agent client-tool strip
  G4  fail-closed empty-model server-tool gate

Phase 1 — Schema spine
  G6  [llm.xai] config → provider extra

Phase 2 — Agentic tools
  G1  LIVE XSearch (Pattern A, default off)
  G5  enable_image_search
  G2  code_interpreter productize
  G7  file_search config
  G8  remote MCP config
  G19 dual-path search guard (with G1)

Phase 3 — Media
  G3  Imagine image gen
  G9  image edit
  G10 video family
  G16 TTS (optional)

Phase 4 — Polish
  G11 gateway auth
  G12 citations
  G13 catalog/docs
  G14 vision edges
  G15 files API
  G20 cost UX
  G24 OpenRouter honesty
```

Parallel after Phase 1: agent tools (Phase 2) ∥ gateway auth (G11) ∥ docs (G13).

---

## 6. Acceptance criteria

### Chat / agentic (BYOK **or** OAuth on `grok-4.5`)

1. Coding tools work without strict-schema 400s.
2. LIVE `WebSearch` uses native `web_search` on Grok (status quo preserved).
3. LIVE `XSearch` uses native `x_search` when `[llm.xai].x_search` is on.
4. Optional `code_interpreter` when enabled.
5. Citations available for search-backed answers.
6. Reasoning effort controllable; multi-agent never gets client function tools.

### Media (BYOK required unless OAuth verified)

7. Imagine gen/edit (later video) from agent on **Grok sessions only**.
8. Clear error under OAuth-only if REST rejects OAuth.

### Non-Grok safety (every PR)

9. Claude / GPT / Ollama / OpenRouter turns: **zero** xAI server tool types in
   request body.
10. Non-Grok **tool registry**: no Imagine / XSearch (or tools refuse hard).
11. OpenRouter `x-ai/grok-4.5`: zero xAI server tool payloads.
12. Multi-agent: zero `type: "function"`; optional built-ins only when enabled.
13. No new required env vars for non-Grok users.
14. OAuth tokens never leave trusted xAI hosts.

Regression gates: `npm run typecheck`, `npm test`, plus TUI/daemon smokes when
touched.

---

## 7. Key file map

```
Auth
  runtime/src/config/env.ts
  runtime/src/config/resolve-provider.ts
  runtime/src/services/xai/oauth.ts
  runtime/src/utils/xaiOauthCredentials.ts
  runtime/src/commands/xai-auth.tsx

Grok provider / wire
  runtime/src/llm/provider.ts                 ← extra → GrokProvider
  runtime/src/llm/providers/grok/adapter.ts   ← G0 tool merge, vision allowlist
  runtime/src/llm/providers/grok/adapter-utils.ts
  runtime/src/llm/providers/grok/*            ← acp, auth-refresh, incremental
  runtime/src/llm/wire/responses-xai.ts
  runtime/src/llm/shape-request.ts            ← prompt_cache_key continuity
  runtime/src/llm/provider-native-search.ts
  runtime/src/llm/types.ts                    ← LLMXaiCapabilitySurface
  runtime/src/llm/structured-output.ts
  runtime/src/llm/provider-capabilities.ts
  runtime/src/llm/stream-parser.ts            ← CitationStreamParser (G12)
  runtime/src/llm/registry/model-catalog.ts
  runtime/src/llm/registry/provider-info.ts

Agent tools / permissions
  runtime/src/bin/model-facing-tools.ts       ← WebSearch native; add XSearch
  runtime/src/bin/bootstrap.ts                ← provider extra / tools attach
  runtime/src/tool-registry.ts
  runtime/src/utils/toolParamSchema.ts
  runtime/src/tools/WebSearchTool/**          ← G19 second stack
  runtime/src/tools.ts
  runtime/src/permissions/*
  runtime/src/session/turn-context.ts         ← ChatGPT image gate contrast

Cost / budget
  runtime/src/session/cost.ts
  runtime/src/budget/* (as applicable)

Config
  runtime/src/config/schema.ts                ← [llm.xai]
  runtime/src/config/loader.ts

Gateway (reference + G11)
  runtime/src/gateway/x-search.ts
  runtime/src/gateway/meme.ts
  runtime/src/gateway/voice.ts
  runtime/src/gateway/run.ts

Docs
  docs/grok-oauth.md
  docs/reference/providers.md
  docs/reference/config.md
  docs/reference/cli.md
  docs/INDEX.md
  docs/ARCHITECTURE.md                        ← default model drift
  docs/managed-openrouter.md                  ← G24 honesty
  docs/provider-tool-compat.md
  docs/gateway.md
  docs/reference/tools-permissions-sandbox.md
```

---

## 8. Verification log

| Pass | Result |
| --- | --- |
| Map A — AgenC Grok surface | HAVE / PARTIAL / MISSING inventory (auth, tools, gateway, gates) |
| Map B — xAI API docs | Full capability matrix (tools, media, audio, advanced) |
| Map C — Grok Build tools | Client vs server mapping; non-goals |
| Verify A — code (first pass) | 15 claims: 12 TRUE, 2 PARTIAL, 0 FALSE + extra gaps |
| Verify B — docs (first pass) | 11 claims: 9 CONFIRMED, 2 CORRECTED (shape only) |
| Senior review | **APPROVE-WITH-CHANGES** — blockers B1–B7 applied |
| **Absolute re-verify (this pass)** | See §8.1 |

### Senior blockers applied

| ID | Fix in this doc |
| --- | --- |
| B1 | Locked **Pattern A** (LIVE XSearch one-shot), not continuous injection |
| B2 | Defaults table: `x_search` / code / Imagine **off** |
| B3 | Imagine gate = session provider + BYOK + permissions, not auth-only |
| B4 | G4 = fail-closed only; no `webSearchToolType` cargo-cult |
| B5 | Acceptance splits OAuth (chat) vs BYOK (media) |
| B6 | **G6 schema before** G1/G2/G5/G7/G8 |
| B7 | G0 expanded: assembly strip, catalog, agent-count UX, allowlists |

### 8.1 Absolute re-verification (2026-07-12)

Independent re-audit of every Strong HAVE row, every gap row, every task G0–G24,
every §7 path, plus multi-agent + tool docs on docs.x.ai.

#### Strong HAVE — 14/14 CONFIRMED

| Claim | Verdict | Key evidence |
| --- | --- | --- |
| Default `grok` / `grok-4.5` | CONFIRMED | `config/schema.ts` L848–849 |
| BYOK key order | CONFIRMED | `config/env.ts` `resolveApiKey` L99–105 |
| OAuth + BYOK wins | CONFIRMED | `commands/xai-auth.tsx` L112–117 |
| Responses adapter | CONFIRMED | `providers/grok/*`, `wire/responses-xai.ts` |
| Native tool plumbing (5 + mcp) | CONFIRMED | `provider-native-search.ts` L171–230 |
| WebSearch one-shot Pattern A | CONFIRMED | `model-facing-tools.ts` L788–914; bootstrap does not set `webSearch` |
| Non-Grok → no native defs | CONFIRMED | `provider-native-search.ts` L174 |
| Reasoning allowlist | CONFIRMED | `structured-output.ts` L107–120 |
| `prompt_cache_key` | CONFIRMED | adapter + `shape-request.ts` + wire |
| CitationStreamParser | CONFIRMED | `stream-parser.ts` + `stream-model.ts` |
| Vision switch | CONFIRMED | `DEFAULT_VISION_MODEL`, `VISION_MODELS_WITH_TOOLS` |
| Composer ACP tools off | CONFIRMED | catalog + `acp-adapter.ts` |
| Gateway X/meme/TTS + `XAI_API_KEY` only | CONFIRMED | `gateway/run.ts` L269–281 |
| Tool schema normalizer | CONFIRMED | `toolParamSchema.ts` + doc |

**Nuance (not a FALSE):** if someone sets `extra.webSearch` on the **main**
session GrokProvider, continuous native injection is possible. Product default
does not. Pattern A remains correct for LIVE WebSearch.

#### Verified gaps — 12/12 CONFIRMED

| Gap | Verdict | Key evidence |
| --- | --- | --- |
| Multi-agent `supportsToolUse: true` + LIVE tools attached | CONFIRMED | `model-catalog.ts` L407; bootstrap `registry.toLLMTools()`; in `VISION_MODELS_WITH_TOOLS` L121 |
| Empty-model fail-open | CONFIRMED | `provider-native-search.ts` L42–45 |
| No `[llm.xai]` / config.toml for xSearch/code/collections/mcp | CONFIRMED | zero fields under `config/`; only `provider.ts` extra |
| No CLI XSearch | CONFIRMED | only gateway `x-search.ts` |
| code_interpreter plumbing only | CONFIRMED | needs `codeExecution === true` |
| No `enable_image_search` | CONFIRMED | zero matches in `runtime/src` |
| Imagine agent tools missing | CONFIRMED | only `gateway/meme.ts` generations |
| Collections/remote MCP config missing | CONFIRMED | plumbing only |
| Gateway auth `XAI_API_KEY` only | CONFIRMED | `run.ts` L269 |
| Docs still claim 4.3 seed | CONFIRMED | providers/config/cli/INDEX/**ARCHITECTURE** |
| Dual WebSearch stacks | CONFIRMED | model-facing + `tools/WebSearchTool/` |
| Files/TTS agent/video incomplete | CONFIRMED | no `/v1/videos`, no agent TTS/files mgmt |

#### Tasks G0–G24

| Status | Tasks |
| --- | --- |
| **CONFIRMED gap** (still open) | G0, G1, G2, G3, G4, G5, G6, G7, G8, G9, G10, G11, G13, G14, G15, G16, G17, G19, G22, G24 |
| **PARTIAL** (skeleton exists; product incomplete) | G12 (citations extract/parser partial), G18 (wire partial), G20 (usage fields partial) |
| **ALREADY FIXED** | **none** |
| **WRONG finding** | **none** |

Priorities and order **G0 → G4 → G6 → agent tools → media → polish** remain correct.

#### File map

- Every path listed in §7 **exists** (rechecked).
- Absolute verify added: `adapter.ts`/`adapter-utils.ts`, `shape-request.ts`,
  `stream-parser.ts`, `bootstrap.ts`, `tools/WebSearchTool/**`, `tools.ts`,
  `ARCHITECTURE.md`, `managed-openrouter.md`.

#### xAI multi-agent docs (re-fetched)

- **CONFIRMED:** “No client-side or custom tools” — only built-ins + remote MCP.
- **CONFIRMED:** `reasoning.effort` maps to 4 vs 16 agents on multi-agent model.
- **CONFIRMED:** Responses/xAI SDK only; no Chat Completions; no `max_tokens`.
- Source: https://docs.x.ai/developers/model-capabilities/text/multi-agent

#### Non-Grok safety (code truth)

| Gate | Present today? |
| --- | --- |
| `provider !== "grok"` → no native tool defs | **Yes** |
| OpenRouter slug cannot get native defs via that gate | **Yes** (docs still need honesty matrix G24) |
| Multi-agent strips client tools | **No** (G0) |
| Empty model fails closed for server tools | **No** (G4) |
| Imagine tools session-gated | N/A (tools not shipped yet — design lock required) |

---

## 9. PR checklist (do not break others)

- [ ] `provider !== "grok"` → no native xAI tools in request body  
- [ ] OpenRouter / non-direct hosts → no xAI server tools  
- [ ] Empty/unknown model → no server tools (after G4)  
- [ ] Multi-agent → zero client function tools (after G0)  
- [ ] Imagine tools not in non-Grok **registry**  
- [ ] No dual-bill search path for one user intent  
- [ ] No new required env for non-Grok users  
- [ ] Tool schema normalizer still applied for Grok function tools  
- [ ] OAuth tokens only to trusted xAI hosts  
- [ ] Snapshot tests: non-Grok request + registry; OpenRouter; multi-agent  

---

## 10. One-line summary

**AgenC has the Grok spine (auth, Responses, native web one-shot, reasoning,
caching). Ship correctness (multi-agent + fail-closed gates) and a single
`[llm.xai]` config, then productize X search / code interpreter / collections /
remote MCP and Imagine media with session-provider gates and deliberate defaults
so non-Grok models stay untouched.**
