# agenc-core Capability-Gap Audit — 2026-06-28

**Question asked:** going through *everything* in agenc-core, is there anything **major** missing
for it to be a complete terminal-native agent framework on par with Anthropic Claude Code,
OpenAI Codex CLI, and category peers (Hermes, OpenClaw)?

**Method:** a 35-agent multi-pass workflow. 10 read-only Explore agents inventoried each capability
domain; 10 gap-finders diffed each against a Claude-Code/Codex completeness rubric (grep-confirming
absence); 1 cross-cutting critic swept top-down for whole-category absences; then **every claimed gap
got an adversarial verifier** that tried to *refute* it by finding the capability somewhere in the
1,627-file tree; a synthesis pass deduped and ranked the survivors.

**Result:** 13 candidate gaps → **13 confirmed real, 0 refuted**. **No verified criticals.** The
verifiers downgraded most severities (critical→medium) because the underlying backbones usually
already exist — the remediations are mostly thin adapters and wiring, not net-new subsystems.

**Implementation note — 2026-06-29:** this branch implements the remediations
from this audit. The fake observability/export item was resolved by deleting
the advertised event-export surface rather than wiring it. AgenC keeps local
diagnostics local; trajectory export is explicit opt-in to caller-selected
JSONL files.

---

## Bottom line

agenc-core is **broadly at peer parity**. The audit found no missing core capability that blocks the
product's primary daemon/TUI coding flow. The surviving gaps cluster into: one genuine
provider-native hole (Gemini), a cheap-but-high-leverage integration hole (no `stream-json` headless
I/O), provider streaming parity (Bedrock), and a band of enterprise/operational-hardening and
parity-polish items.

---

## Ranked findings

### 🔴 HIGH

**1. Gemini is an OpenAI-compat shim, not a native Google provider** · *Model/provider layer*
The Gemini provider is a ~35-line subclass of `OpenAIProvider` pointed at the
`generativelanguage.googleapis.com/v1beta/openai` compat endpoint
(`runtime/src/llm/providers/gemini/index.ts`). That surface structurally **cannot** carry
Gemini-native agentic features: **thought signatures** (Gemini 2.5 thinking models must echo them
across turns for correct multi-turn tool calling — the compat layer drops them, degrading tool
loops) and **`cachedContents` context caching** (Gemini's main cost lever on exactly the
large-context coding turns this framework targets). No native `generateContent`/`streamGenerateContent`
path, no Gemini-on-Vertex.
*Nuance:* a real Google auth subsystem already exists (`utils/geminiAuth.ts` — api-key / access-token /
ADC via `google-auth-library`), so a native transport plugs into existing credential handling.
**Fix:** build a native Google adapter; sequence this first (correctness + cost).

### 🟠 MEDIUM — the actionable middle

**2. No `stream-json` / `json` headless I/O on the CLI** · *Daemon/SDK* — **highest ROI**
`agenc -p`/`--print` emits only plain text; there's no `--output-format text|json|stream-json` and no
`--input-format stream-json`. Every peer offers this (`claude -p --output-format stream-json`,
`codex exec --json`) and it's the de-facto programmatic/CI/SDK integration surface. Anyone embedding
agenc from another language must hand-write a JSON-RPC daemon client instead.
*The hard part already exists:* `app-server/protocol` + `daemon-dispatcher` already emit the full
structured `session.*` event stream (tool calls, permission events, usage, cost, model, session id,
final result) that the TUI consumes. **Fix:** a thin CLI adapter serializing those existing events to
stdout/JSONL — low cost, unlocks the standard subprocess-SDK + GitHub-Action pattern.

**3. Amazon Bedrock provider doesn't stream** · *Model/provider layer*
The Bedrock adapter calls the buffered `/converse` endpoint and fakes streaming
(`chatStream()` awaits the whole response, emits it as one chunk). No `ConverseStream`. Every other
first-party provider (Anthropic/OpenAI/Grok) streams token-by-token via the shared `_deps/sse.js`
parser. Bedrock is the one provider enterprises are *forced* onto by procurement, so worst
time-to-first-token lands exactly where users can't opt out. **Fix:** wire `ConverseStream`/SigV4
`/converse-stream` through the existing SSE parser.

**4. Fake observability export surface removed** · *Observability* — **resolved by removal**
The old exporter knobs, inert provider slots, counter call-sites, and no-op reporting helpers
advertised a feature that never ran. The chosen fix is removal rather than wiring: AgenC does not
ship a product event export surface. Local diagnostics remain local, and the trajectory exporter is
explicitly opt-in via file path environment variables.

**5. No eval / benchmark harness** · *Observability* (two finders merged)
`runtime/src/eval/` contains only a report **schema** + an AJV **validator** — no runner. Nothing
loads a SWE-bench/Terminal-Bench-style suite, drives the agent loop, applies patches, runs tests, or
scores pass/fail. The framework can validate a report it's handed but can't produce one, so
agent-quality regressions from a prompt/tool/model change are **unmeasured**. **Fix:** a minimal
runnable harness emitting the already-defined schema, gated in CI on a small task set.

**6. No MCP Sampling (`sampling/createMessage`)** · *MCP*
Neither MCP client stack advertises `sampling` or registers a `CreateMessageRequestSchema` handler, so
a server that requires sampling fails outright. Elicitation, roots, progress, cancellation, OAuth-DCR
are all done — sampling is the last host-conformance hole. (`roots` is also wired only in the SDK
stack, not the primary transport stack `MCPManager` uses — secondary inconsistency.) Since agenc
already hosts multi-provider LLMs it's well-placed to add (and differentiate on) this. **Fix:**
implement `sampling/createMessage` on both stacks; fix the `roots` inconsistency.

**7. No request-side rate limiting / overload protection on the daemon** · *Daemon*
The control plane has output-side slow-consumer eviction + per-message size caps + auth-gated peer
reaping, but **nothing bounds inbound request rate/concurrency** from an authenticated client (no
token bucket, no in-flight cap, no 429/busy backpressure). The transport headers explicitly disclaim
it ("queue backpressure, overload responses … NOT carried"). Low-risk while local/single-operator, but
the new relay + `/remote` pairing (#1342, #4043eb004) extends the plane to **remote** authenticated
peers who can issue unbounded distinct-id requests. **Fix:** per-connection token bucket + in-flight cap.

**8. `/init` writes a static template, no codebase analysis** · *Config/memory*
`agenc init` writes a fixed fill-in-the-blanks `AGENC.md` with no repo scan and no model call, and
there's no interactive `/init` slash command. Peers' analyzed `/init` (scan README/manifests/
build-test-lint/layout → generate tailored memory) is the canonical onboarding step that makes the
agent immediately competent — and the project memory file is the single highest-leverage per-turn
context input. *Nuance:* the agent already has repo-reading tools + an Explore subagent + a
repo-mapping system prompt, so this is a one-shot tailored-generation command, not a new capability.

**9. No `/output-style` runtime switching or `/output-style:new`** · *Extensibility*
Output styles are **fully built** (presets + user/project/plugin styles, settings-resolved,
system-prompt-injected, shown in the status line) — but it's the *only* extensibility surface with no
runtime menu (skills/hooks/mcp/plugins/agents/model/permissions all ship one). Switching requires
hand-editing `settings.json`. Also the per-turn output-style system-reminder is a documented noop.
**Fix:** add `/output-style` (switch) + `/output-style:new` (agent-authored), matching the sibling menus.

**10. No SBOM / build provenance / supply-chain attestation for agenc's own distribution** · *Supply chain*
No CycloneDX/SPDX SBOM, no Syft/Grype, no SLSA/sigstore/cosign, no `npm publish --provenance`. A
SHA-256 build→manifest→install-time integrity gate exists (tamper-evidence), but it's not an SBOM and
not *independent* provenance (same pipeline emits both checksum and artifact). Lockfiles are
uncommitted (`npm install`, not `npm ci`). Material because the runtime holds wallet/signing + MCP
credentials and loads third-party MCP/plugins — and it already vets *others'* supply chain
(`mcp-client/supply-chain.ts`) but not its own. **Fix:** add an SBOM CI job + `npm --provenance`
(roughly a one-job add).

### 🟡 LOW — note, don't prioritize

**11. No i18n/l10n layer** · All user-facing strings are inline English; no message catalogs/Intl
runtime. *Low because* English-only is the category norm (Claude Code, Codex, Gemini CLI are all
English-only). Only caveat: building the extraction seam later is costlier than early.

**12. No fine-tune / distillation / trajectory-export hooks** · No SFT/DPO/JSONL export from
trajectories despite running a local self-hosted model (qwen3-coder via vLLM) and self-improvement
services (autoFix/autoDream operate at runtime-memory level, not weight level). *Low / aspirational* —
peers ship nothing here either — but more material for agenc specifically *because* it supports local
models, so an operator could otherwise close the loop and distill a cheaper local model from real runs.

---

## What verification taught us (nuance the raw gap list misses)

Several "gaps" are **management/adapter surfaces over working backbones**, which makes them cheap:
- structured daemon event protocol already exists → stream-json is a thin adapter (#2)
- real multi-provider SSE streaming already exists → Bedrock can adopt it, not reinvent (#3)
- output-style engine fully built → only the menu is missing (#9)
- Google auth fully built → native Gemini transport plugs in (#1)
- eval report schema is a deliberate seam → only the runner is missing (#5)

The former fake observability/export surface was reputationally risky because it implied a feature
that returned nothing; this branch resolves that by deleting the advertised export path.

## Noteworthy strengths (already at/above peer parity)

- Genuine multi-provider SSE streaming via a shared frame parser (OpenAI/Anthropic/Grok)
- Complete structured daemon JSON-RPC protocol carrying tool/permission/usage/cost/model/session events
- Strong MCP host conformance: elicitation (both stacks), roots (SDK), progress, cancellation, OAuth-DCR
- Mature, consistent extensibility UX — runtime menus for skills/hooks/mcp/plugins/agents/model/provider/permissions
- Supply-chain trust applied to third-party MCP servers + SHA-256 distribution integrity gate
- Daemon robustness: cooperative cancellation, output-side slow-consumer eviction, per-session caps, auth-gated transport

---

## Suggested sequence

1. **Gemini native provider** (#1) — correctness + cost, real capability hole
2. **`stream-json` headless I/O** (#2) — cheapest high-leverage; unlocks SDK/CI integration
3. **Bedrock streaming** (#3) — enterprise UX parity, reuses existing SSE
4. **OTel: wire it or remove the config** (#4) — stop advertising a dead feature
5. **Eval harness** (#5) — so quality regressions become detectable
6. Then the parity/hardening band: MCP sampling (#6), daemon rate-limiting (#7, before relay hardens),
   analyzed `/init` (#8), `/output-style` menu (#9), SBOM/provenance (#10)

_Generated by a 35-agent gap-audit workflow (run `wf_3458a728-8b4`). Every finding was
adversarially verified against the live tree; severities reflect post-verification downgrades._
