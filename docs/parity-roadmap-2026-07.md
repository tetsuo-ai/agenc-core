# AgenC Core: Parity-and-Beyond Roadmap vs Hermes Agent and OpenClaw

**Date:** 2026-07-08. **Status:** proposal for owner review, nothing here is started.
**Inputs:** full repo inventory of agenc-core (this repo, TODO backlog cleared as of
2026-07-08), full repo inventory of `hermes-agent` (workspace checkout, v0.17.0),
web research on OpenClaw (docs.openclaw.ai, GitHub, security postmortems) and on
adoption drivers/complaints for both (HN Algolia + GitHub API verified where noted).

---

## 1. The verdict in three sentences

agenc-core's coding-agent loop (daemon, TUI, tools, permissions, OS sandbox, MCP
client+server, subagents, sessions, 16 providers, cron, plugins, skills, realtime
voice) is already at Codex-class parity and more rigorously built than either
competitor (14k tests, 0 `@ts-nocheck`, eval-regression baseline, codex-rs surface
contract green). What it lacks is the **personal-agent reach layer** that made
OpenClaw (382k stars) and Hermes (211k stars) spread: messaging channels, one-command
onboarding, persona/heartbeat, browser hands, and a learning loop. The winning move is
not to clone them; it is to close four reach gaps and then ship the four things both
are being publicly hammered for lacking: **security by default, auditable learning,
bounded spending, and a real economy** (all four are things AgenC uniquely already
has primitives for).

## 2. Where they won, where they bleed (research summary)

**OpenClaw won on:** messaging reach (25+ channels), "Claude with hands" demos,
one-command install + onboarding wizard, persona files (SOUL.md) + heartbeat that
make it feel alive, ClawHub ecosystem (~13.7k skills), drama-as-distribution.

**OpenClaw bleeds on (verified):** 20k-42k exposed gateways (93% no auth), ClawHavoc
supply chain (~1,184 malicious skills, ~8.5% of registry, "five of the top seven
most-downloaded skills were malware"), token burn ($30-100/mo idle heartbeats,
$3,600/mo horror stories), WhatsApp bans (Baileys = ToS violation), memory chaos
(#43747), update roulette, prompt injection acknowledged unsolved.

**Hermes won on:** the self-learning loop ("the agent that grows with you"),
genuine model-agnosticism incl. local (captured OpenClaw refugees after Anthropic's
April subscription crackdown), $5-VPS framing, Nous community + X-driven growth,
stability positioning ("night and day more stable").

**Hermes bleeds on (verified):** the EvoMap plagiarism scrub (issue #10232 edited to
"`.`"), silent third-party data routing (#45058, web tools routed to a hosted MCP
without a key set), self-learning trust ("it always thinks it did a good job",
no audit trail or version control for generated skills, "subtle behavioral drift"),
~14K tokens fixed overhead per call, 27k open issues, unauthenticated API server
when key unset.

**Unmet in BOTH (demand-ranked from user signals):**
1. Reliability / memory that doesn't rot, with ops visibility
2. Mobile-native + realtime bidirectional voice
3. Multi-user / family / team isolation (OpenClaw closed RBAC as not-planned)
4. Bounded spending: hard caps, approval taps in chat, audit trails
5. Skill/agent trust: signing, publisher verification, reject-before-publish
6. Hybrid model routing: local for the 80%, frontier for the hard 20%

Items 4 and 5 are literally AgenC's existing on-chain trust stack (transaction
guard, signer policies, preview-approve, attestation roster). Item 1 is what our
eval-gated engineering culture produces. The "missing merchants" critique of x402
(~$28K/day real volume, 50% wash) is the marketplace we already run.

## 3. What we deliberately do NOT build

- **WhatsApp via Baileys or any ToS-violating bridge.** OpenClaw's ban stories are
  a trust tax. Ship official-API channels first; WhatsApp only via Cloud API
  (business) with explicit caveats, or not at all initially.
- **An uncurated skill registry.** ClawHub's malware rate is the cautionary tale.
  Ours launches signed + attested or it doesn't launch.
- **A Moltbook clone / agent social network.** Drama distribution without the
  incident is not replicable; the Wiz DB leak killed its credibility.
- **Interop reshaping of the protocol for anyone else's payment rails** (standing
  founder directive 2026-07-05).
- **i18n** (deliberately deleted in task 18; revisit only on demonstrated demand).

## 4. The build list, in order

Sizes: S = days, M = 1-2 weeks, L = 3-6 weeks, XL = multi-month. All phases assume
the existing daemon protocol + SDK as the substrate (verified: `packages/agenc-sdk`
already exposes `session.attach`, `message.stream`, `event.permission_request`
round-trips, i.e. everything a channel adapter needs; the gateway is a **client-side
build, not a runtime rewrite**).

### Phase 0: Frictionless, safe onboarding (the founder-stated burning problem)

| # | Work package | Size | Notes |
|---|---|---|---|
| 0.1 | `curl -fsSL get.agenc.ag/install.sh \| sh` + PowerShell equivalent: single script that installs Node-independent launcher or bundles runtime tarball, verifies SHA, installs daemon (systemd/launchd templates already exist in `packaging/`) | M | Copy OpenClaw's exact UX; ours verifies signatures |
| 0.2 | `agenc onboard` wizard: provider pick (incl. reuse of existing Claude/Codex/OpenRouter creds), key/OAuth entry, daemon install, first chat in terminal, optional channel pairing | M | The single highest-leverage adoption artifact |
| 0.3 | `agenc security audit [--fix]`: exposure check (bind mode, auth token, tool blast radius), fail-closed defaults, loopback-only unless tailnet/custom explicitly configured | S-M | Day-one differentiator; OpenClaw added theirs after the 42k-exposed disaster. We ship it before we ship channels |
| 0.4 | Distribution spread: Homebrew tap, Docker image + compose, one-click VPS templates (Railway/Hostinger/Hetzner docs) | M | The VPS-template ecosystem was a real OpenClaw adoption channel |
| 0.5 | Hosted docs quickstart with the 5-minute path, and a "Migrate from OpenClaw" + "Migrate from Hermes" guide (maps SOUL.md/AGENTS.md/skills to our equivalents) | S | The Hermes migration guide made HN front page (122 pts); refugees are a named acquisition channel |

**Exit criterion:** a non-developer reaches a working assistant conversation in
under 5 minutes on a fresh macOS/Linux box, and `agenc security audit` is green by
default.

### Phase 1: Channels (the defining reach gap)

Architecture: a `gateway` client process (or daemon module behind a flag) that
speaks the existing 41-method JSON-RPC protocol via agenc-sdk; each channel is a
plugin using the existing `plugins/` registration surface. Inbound sender identity
maps to sessions via deterministic bindings (OpenClaw's most-specific-wins model is
the right design; copy it). DM policy defaults to **pairing** (unknown senders get
expiring codes), never `open`.

| # | Work package | Size | Notes |
|---|---|---|---|
| 1.1 | Channel gateway core: session binding/routing, delivery, streaming-to-message coalescing, permission-approval round-trip rendered as tappable chat replies | L | The approval-tap-in-chat is also the spend-control UX later |
| 1.2 | Telegram channel (official Bot API) | S-M | Fastest setup, zero ban risk, OpenClaw's own recommended first channel |
| 1.3 | WebChat: chat UI served from the daemon dashboard | M | Also becomes the mobile PWA stopgap |
| 1.4 | Discord + Slack channels (official APIs) | M | |
| 1.5 | Signal + email channels | M | Signal for the privacy audience (on-brand for AgenC) |
| 1.6 | Untrusted-content hardening: every inbound channel message and fetched artifact wrapped in untrusted markers; channel text can never escalate permission mode, change signer config, or approve a previewed action (extends the existing marketplace untrusted-data rule to all channels) | M | This is where our permissions rigor becomes visible product |
| 1.7 | iMessage (macOS bridge) and WhatsApp Cloud API, both opt-in with explicit caveats | M-L | Later; not launch-blocking |

**Exit criterion:** talk to your agenc daemon from Telegram, approve a Bash
permission request with a tap, and a hostile DM sender cannot reach the agent
without pairing.

### Phase 2: Alive: persona, heartbeat, proactive delivery

We already have `memory/`, `AGENC.md`, cron with a live scheduler, and background
tasks (DreamTask!). This phase is mostly wiring + workspace convention.

| # | Work package | Size | Notes |
|---|---|---|---|
| 2.1 | Workspace persona files: `SOUL.md` (persona), `USER.md`, `IDENTITY.md`, one-time `BOOTSTRAP.md` naming ritual; injected at session bootstrap with a budget | S-M | Cheap, and it is what made OpenClaw feel alive; a souls-directory ecosystem exists to import from |
| 2.2 | Heartbeat: periodic agent turn reading `HEARTBEAT.md`, `HEARTBEAT_OK` suppression, activeHours, per-task intervals | M | Design cost-first (see 2.3); OpenClaw's is a token furnace |
| 2.3 | Cost-bounded autonomy: heartbeats/cron default to a cheap utility model + light context + `isolatedSession`; hard daily token/dollar budget enforced daemon-side with channel notification when hit | M | Direct answer to the $30-100/mo idle-burn complaint; "your agent has a budget" is also the marketplace mental model |
| 2.4 | Cron delivery to channels (`--announce`, webhook POST); wire the existing ScheduleCronTool runner to gateway delivery | S | Scheduler already exists and re-arms on restart |
| 2.5 | Inbound webhooks (`POST /hooks/agent`, bearer-only auth) | S-M | Zapier/CI integration surface |

**Exit criterion:** morning-brief demo: cron fires at 7am on a cheap model, posts
to Telegram, total cost visible, monthly idle cost under $5 on defaults.

### Phase 3: Hands: browser, then wider execution

| # | Work package | Size | Notes |
|---|---|---|---|
| 3.1 | Browser tool: dedicated Chromium profile, CDP-driven, snapshot returns stable ARIA-tree `ref` IDs (not CSS selectors), click/type/tabs/screenshot/PDF; SSRF policy blocking private networks by default; bundled browser-automation skill teaching snapshot-act-resnapshot | L | OpenClaw's design here is genuinely good; adopt the ref-ID model. Runs inside our sandbox policy, which they can't say |
| 3.2 | Remote CDP option (Browserless/user-profile mode) | S | Config, mostly |
| 3.3 | Docker execution driver for the sandbox (`sandbox.mode: docker`), then SSH remote exec target | L | Closes the Hermes 6-backend gap where it matters; Modal/Daytona-style serverless can wait for demand |
| 3.4 | Computer-use tool (screen, OS-level input) behind explicit opt-in | L-XL | Defer until browser tool proves demand; highest risk surface |

**Exit criterion:** "book/table/form/research behind JS" class tasks work from a
chat channel, sandboxed, with the same permission previews as Bash.

### Phase 4: The learning loop, done auditable (attack Hermes' trust wound)

Positioning: Hermes learns silently and drifts; AgenC learns in **reviewed,
versioned, eval-gated diffs**.

| # | Work package | Size | Notes |
|---|---|---|---|
| 4.1 | Cross-session recall: FTS5 index over session JSONL/SQLite + `session_search` tool with bounded, redacted results | M | Hermes' most-loved feature; we have the SQLite substrate |
| 4.2 | Memory distillation: daily notes -> periodic distill into MEMORY.md-equivalent, as **git commits in the workspace** with provenance (which sessions fed it); `/memory review` to diff/revert | M-L | Directly answers "memory management is in chaos" + "no audit trail" |
| 4.3 | Skill curator: agent proposes new/edited skills from repeated patterns, lands them as **draft PRs against the workspace skills dir**, gated by the existing eval harness (`runtime/eval/`) before activation; never overwrites manual edits | L | The eval-regression baseline is the moat here; nobody else can gate learned behavior on evals |
| 4.4 | User model (USER.md) maintained the same way: proposed diffs, never silent writes | S | |

**Exit criterion:** after two weeks of use the agent has proposed >=3 skills, every
one visible as a diff with an eval run attached, and reverting one is one command.

### Phase 5: The moat (what neither can follow into)

| # | Work package | Size | Notes |
|---|---|---|---|
| 5.1 | **Signed skill registry**: publisher identity = wallet signature, skills content-hashed, reject-before-publish scanning, attestation by the existing roster attestor (attest.agenc.ag) rather than scan-warn-install-anyway; provenance recorded on install | L | ClawHavoc (top-7 skills = malware) is the wedge. Reuses WP-C1/C2 attestation infra + marketplace store rails |
| 5.2 | **Bounded agent spending as product**: surface the transaction-guard + signer-policy + preview-approve stack as consumer UX: per-agent budgets, category caps, approval taps in any channel, immutable audit log. "A virtual card for your agent" | L | The #4 unmet need verbatim; we already run this on mainnet for real SOL |
| 5.3 | **Earn/hire loop (task 22 A3/A4, owner-gated)**: claim -> sandboxed worktree agent -> preview-first settle; plus creator-side: your assistant can post a task to the marketplace when it can't do something itself | L | This answers the x402 critique ("no actual merchants"): AgenC's marketplace IS the merchant layer. No other personal agent can say "my agent earned its own API budget this month" |
| 5.4 | Multi-user / team gateway: per-user agents, isolated workspaces + sessions, per-binding tool policy (RBAC-lite) | L | OpenClaw explicitly declined this (#8081 closed not-planned) with acknowledged demand (#61123 families/teams) |
| 5.5 | Hybrid model routing policy: cheap/local model for routine turns, frontier escalation on task-complexity signals; per-role model config (utility/heartbeat/main/image) | M | 16 providers incl. ollama/lmstudio already wired; this is a routing layer |
| 5.6 | Mobile companion (nodes): start with the WebChat PWA + push notifications; native iOS/Android node apps (camera, location, voice wake) only after gateway+channels are proven | XL | OpenClaw needed 7 months to ship an official iPhone app; not a year-one requirement. Our realtime WebRTC voice stack is already ahead; wire it into WebChat first |

### Phase 6: Growth mechanics (not code, but sequenced like code)

- **Benchmark presence:** neither OpenClaw nor Hermes appears on any rigorous
  coding-agent leaderboard; agenc-core is codex-surface-parity with an eval
  harness. Run Terminal-Bench / SWE-bench-class results and publish. "The personal
  agent that is also a top-tier coding agent" is a claim neither can make.
- **Security-first launch narrative:** publish the threat model + the security
  audit command + fail-closed defaults BEFORE launch, and invite the researchers
  who broke OpenClaw (O'Reilly, Koi, Wiz) to try. Every OpenClaw incident
  re-front-paged them; every AgenC non-incident is quiet compounding trust.
- **Migration guides + soul-file import** (from 0.5) as standing SEO/HN artifacts.
- **Weekly changelog cadence** on X (existing distribution), demo-led: morning
  brief, approval tap, agent-earned-its-keep.

## 5. Sequencing rationale (why this order)

1. **Phase 0 before everything:** founder-identified burning problem is onboarding;
   nothing downstream compounds without installs.
2. **Channels before persona/heartbeat:** a heartbeat with nowhere to deliver is a
   token furnace; channels give every later feature (approvals, cron, spend taps)
   its UX surface.
3. **Browser before learning loop:** "it did the thing" demos recruit users;
   learning loops retain them. Acquisition before retention.
4. **Moat last but designed-in from Phase 1:** the approval-tap plumbing (1.1),
   budget enforcement (2.3), and untrusted-content discipline (1.6) are the same
   primitives 5.2/5.3 need. Build them once, in order.
5. **Every phase ships behind the existing quality gates** (typecheck 0, ~14k
   vitest green, eval baseline, revert-sensitive tests). Stability was Hermes'
   entire wedge against OpenClaw; ours is structural, keep it.

## 6. Rough critical path

P0 (0.1-0.3) -> P1 (1.1+1.2+1.6) -> P2 (2.2+2.3+2.4) gives the minimum lovable
personal agent: install in 5 min, talk from Telegram, safe by default, morning
brief under budget. That slice is roughly 3 gateway-scale L packages plus a
handful of S/M, and everything in it is client-side or wiring on the existing
daemon. Browser (3.1) and auditable learning (4.1-4.3) are the second wave.
The moat items (5.1-5.3) can start in parallel any time after Phase 1 because
they reuse marketplace infra that already exists outside this repo.
