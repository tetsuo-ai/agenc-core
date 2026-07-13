# AgenC product roadmap

**As of 2026-07-12.** Product line **0.6.0** (SDK package **0.2.0**). What is
shipped in-tree versus open backlog.

This replaces the competitive parity plan. Historical research and phase
narratives live under [`archive/`](archive/) and are **not** product truth.

| Historical doc | Notes |
| --- | --- |
| [`archive/parity-roadmap-2026-07.md`](archive/parity-roadmap-2026-07.md) | Competitive roadmap vs Hermes / OpenClaw (stale progress header) |
| [`archive/onboarding-plan-2026-07.md`](archive/onboarding-plan-2026-07.md) | Onboarding implementation plan (superseded by shipped acts + quickstart) |
| [`archive/README.md`](archive/README.md) | Archive index |

Operational task tracking for local engineers may use a gitignored root
`TODO.md` when present; public product truth for shipped vs open is this file
(open backlog + completed log with SHAs). This roadmap is the **product-facing**
shipped / open summary.

---

## Shipped (in product as of 2026-07-12 / 0.6.0)

### Core coding agent

- Daemon-backed CLI + fullscreen TUI (custom Ink fork, workbench default)
- Multi-provider LLM layer (default xAI / Grok; many built-ins)
- LIVE tool registry: shell, files, patch, search, web, LSP, MCP, tasks, skills, …
- Permissions modes + OS sandbox (bubblewrap / Seatbelt)
- MCP client + server, plugins, skills, hooks
- Browser automation tool (`Browser`): isolated Chromium over a CDP pipe,
  accessibility-ref actions, SSRF-proxy egress control (task 18)
- Multi-agent v2: `spawn_agent`, `wait_agent`, `close_agent`, `assign_task`,
  `send_message`, `list_agents`
- Background agents over the 41-method daemon protocol
- Embedding SDK `@tetsuo-ai/agenc-sdk` **0.2.0** (`connect`, `promptViaSubprocess`)
- Local agent-eval suite + regression gate (`runtime/eval/`)
- Trajectory export → SFT/DPO curation (`agenc trajectories export`)
- SLM transaction guard (Ollama court, fail closed, `agenc doctor`)
- Embedded Neovim BUFFER (`auto|neovim|inline|external`)

### Onboarding & distribution

- One-line installer / releases packaging, Docker, Homebrew paths
- `agenc onboard` (+ identity / channel / autonomy / recap acts)
- `agenc security audit [--fix]`
- `agenc update` self-update CLI
- Quickstart + migrate-from-OpenClaw / Hermes guides

### Channels & gateway

- Channel gateway core: pairing, bindings, in-channel approvals, session routing,
  untrusted-content framing
- **Discord**, **Slack**, **Telegram**, **WebChat**, stdio
- Inbound webhooks `POST /hooks/agent` (token header, loopback default)
- Cron delivery to channels + webhooks
- Gateway as daemon **client** via the SDK (not a runtime rewrite)

### Alive / autonomy

- Persona workspace files (`SOUL.md` / `USER.md` / `IDENTITY.md` / `BOOTSTRAP.md`)
- Heartbeat runner (budget-gated when budgets enabled)
- Budget enforcement on **heartbeat / cron / hooks** autonomous paths
- Hooks enablement + minted tokens as part of onboard autonomy

### Remote

- Remote-control surfaces (see [`remote-control.md`](remote-control.md))

---

## Open backlog

Grouped to match current product priority. Detail + acceptance criteria live in
`TODO.md` (local/gitignored).

### Channels still open

- **Signal + email** channels
- **WhatsApp** only via official Cloud API (business), with caveats — **not**
  Baileys / reverse-engineered bridges
- **iMessage** bridge (macOS-only) — deferred

### Hands / execution

- ~~Browser automation tool (dedicated Chromium profile, CDP, ARIA-ref actions,
  SSRF policy)~~ — **shipped** (task 18): `Browser` tool, CDP over
  `--remote-debugging-pipe`, loopback SSRF proxy
- Remote CDP + user-profile browser modes (rides browser tool) — **open** (task 19)
- Docker sandbox driver + SSH exec target
- Computer-use (OS screen/input) — deferred, highest risk

### Learning / memory

- **FTS session search** over history (`session_search`)
- Memory distillation as reviewed git commits
- **Skill curator** (eval-gated skill learning — anti-drift)
- USER model as proposed diffs only

### Moat / marketplace

- Signed skill registry (reject-before-publish) — needs registry infra owner
- Bounded agent spending as consumer UX over guard + budgets + channel approvals
- Marketplace protocol **mutating stages A3/A4** (claim → background agent →
  settle / proof / stake / delegate) — **owner approval required**; A1/A2
  readonly listing already landed
- Multi-user / team gateway (RBAC-lite, isolated workspaces)
- Hybrid model routing policy (local-first + frontier escalation)

### Growth / mobile

- Mobile app / nodes + realtime voice in WebChat — deferred / large
- Benchmark presence publishing — needs owner call
- **Guaranteed canned first-turn deep-links** (onboarding polish still partial
  for some TUI-greeting / morning-hint paths)

### Known verify / fix items

- AGENC.md tier content injection vs lazy-read documentation (task 35)
- System prompt re-prepend on provider retry (task 36)
- External identity service mock-device auto-approve hazard (service owner)

---

## What we deliberately do not build

Carried from the archived parity plan (still policy):

- WhatsApp via Baileys or any ToS-violating bridge
- Uncurated public skill registry (unsigned malware magnet)
- Moltbook-style agent social network
- Reshaping protocol payment rails for third parties without founder directive
- i18n until demonstrated demand

---

## How to read status

| Layer | Use |
| --- | --- |
| This file | Shipped vs open product summary |
| `TODO.md` (local/gitignored) | Engineer backlog, gates, completed SHAs |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the system is put together |
| [`archive/`](archive/) | Historical plans only |
