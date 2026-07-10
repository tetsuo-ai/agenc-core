# AgenC First-Run Onboarding — Complete Plan (2026-07)

> **ARCHIVED — NOT PRODUCT TRUTH.** Superseded by
> [`../onboarding.md`](../onboarding.md) and [`../roadmap.md`](../roadmap.md).
> Historical implementation plan only.
>
> **Audience (historical):** an AI code assistant implementing onboarding
> work. Related archive: [`parity-roadmap-2026-07.md`](parity-roadmap-2026-07.md).
>
> **Delivery status (2026-07-10):** O-2/O-3/O-4/O-5/O-6 shipped (PR #1454);
> O-1 shipped (detection + annotation + guaranteed first turn); O-7 shipped
> (this doc + quickstart Acts 2–3); O-8 deferred by design; O-9 partial (see
> its section).
>
> **Status of the ground this stands on (verified 2026-07-09):** Phase 0
> install/onboard/audit shipped (PRs #1401–#1411). Phase 1–2 shipped live:
> channels (Telegram #1413, Discord/Slack #1444, WebChat #1415, stdio),
> personas (#1426), heartbeat (#1418), budgets (#1417), cron delivery
> (#1420), inbound webhooks (#1453), gateway daemon agents (#1419). **None
> of the Phase 1–2 surfaces has an onboarding path** — they are env vars,
> hand-edited `gateway/config.json`, and flags, discoverable only by reading
> docs. That is the gap this plan closes.

---

## 1. North star

Two clocks, measured from `curl … | sh`:

- **T2M — time to magic (first useful reply): < 5 minutes.** Already
  roughly true for a user holding an API key; broken for a user with none.
- **T2A — time to *agent* (a NAMED agent, reachable from your phone, with a
  spend cap): < 15 minutes.** Today this takes an experienced operator an
  afternoon of doc reading. This is the number that decides adoption,
  because it is the moment AgenC stops being "another CLI chatbot" and
  becomes the product the roadmap describes.

The structural insight: **onboarding currently ends exactly where the
product begins.** The wizard (`runtime/src/onboarding/Onboarding.tsx`:
preflight → theme → provider → api-key → connection-test → security →
terminal-setup) produces a configured *TUI*. The differentiated product —
persistent identity + channels + bounded autonomy — starts one step later
and has no guided path. The plan is therefore not "polish the wizard"; it
is **give onboarding a second and third act**.

## 2. Principles (non-negotiable)

1. **Secure by default is a feature, not a toll.** Every step that opens a
   surface shows its posture in one line ("loopback only · token minted ·
   pairing required") and never asks the user to weaken anything. The
   security audit runs green at the end of every act — we advertise that.
2. **Budget before autonomy.** No step may enable heartbeat/cron/hooks
   before a spend envelope exists. The wizard order enforces what the
   runtime already enforces (task-15 admit gate).
3. **The live smoke IS the step.** Every act ends by *doing the thing once
   for real* (send yourself a Telegram message; watch the hook POST land),
   exactly like this repo's landing discipline. A step that ends with
   "now it's configured" instead of "you just saw it work" is not done.
4. **Progressive disclosure, resumable forever.** Act 1 alone must leave a
   complete, useful tool. Acts 2–3 are invitations, not gates; every act is
   re-enterable via `agenc onboard <act>` at any time, and the wizard
   remembers per-act completion (`projectOnboardingState.ts` already has
   the persistence shape).
5. **No phone-home.** Success is measured from local state and the existing
   get.agenc.ag/Vercel edge (§7), never runtime telemetry. Privacy is the
   brand.
6. **One writer per file.** The wizard writes the same files the runtime
   reads (`gateway/config.json`, `SOUL.md`, `HEARTBEAT.md`, `[budget]` in
   config.toml) through the same loaders/normalizers — no parallel config
   surface, no wizard-only formats.

## 3. The journey (target state)

```
S0 Discover     get.agenc.ag / README / migration guides
S1 Install      curl|sh · npm · brew · docker · VPS          [SHIPPED]
S2 Converse     provider → key → first reply                 [SHIPPED, gaps]
────────────────────────── Act 1 ends: a working assistant ─────────────
S3 Identity     name the agent (BOOTSTRAP ritual) + SOUL.md  [runtime ✓, no scaffold]
S4 Channel      Telegram/Discord/Slack/WebChat + pairing     [runtime ✓, no wizard]
────────────────────────── Act 2 ends: YOUR agent, on your phone ───────
S5 Guardrails   budget caps → heartbeat → cron → webhooks    [runtime ✓, no wizard]
S6 Posture      gateway-aware audit recap + what-to-try card [audit ✓, recap missing]
────────────────────────── Act 3 ends: a bounded autonomous agent ──────
```

### S0 — Discover (get.agenc.ag, README, guides)

What exists: `get.agenc.ag` 307→installer, README, quickstart,
migrate-from-openclaw/hermes guides (all current as of #1453).

Target: the landing copy and README lead with the Act-2/Act-3 outcome
("a named agent on your phone in 15 minutes, spend-capped"), show the
three-command journey (`install → agenc onboard → agenc onboard channel`),
and link one **end-to-end asciinema/GIF** of the full journey. The
quickstart gains Act 2/Act 3 sections mirroring the wizard (§ workstream
O-7). Keep the OpenClaw/Hermes migration guides as the comparison surface —
they already convert the "what you gain/lose" question.

### S1 — Install [SHIPPED — keep, one gap]

`curl|sh` (sha256-verified, user service), `npm i -g`, brew tap, ghcr
docker, VPS notes. **Gap:** Node ≥ 25 is a prerequisite the installer
reports but does not solve. Workstream O-8 evaluates bundling a runtime
(node SEA / bun compile) — L-sized, deferred unless install-drop data
(§7) says the Node prerequisite is the cliff.

### S2 — First conversation [SHIPPED, two gaps]

What exists: the wizard's provider → api-key (live-verified) →
connection-test path, 16 providers.

**Gap A — the zero-key user bounces.** A user with no API key hits a wall
at the provider step. Fix (O-1): a "no key?" branch that (a) autodetects
local runtimes — probe `127.0.0.1:11434` (Ollama) and LM Studio's default
port, offer detected models instantly; (b) offers guided key acquisition
deep-links per provider; (c) once id.agenc.ag device-code flow is fixed
(TODO task 33, external), offers hosted free-tier login. Local-runtime
autodetect alone converts the "just evaluating" cohort.

**Gap B — the first prompt is the user's problem.** After connection-test
the wizard drops into an empty chat. Fix (O-1): end Act 1 by *running one
turn for them* — a canned prompt against the current directory ("summarize
what's in this folder" / repo-aware if `.git` present) so the first magic
moment is guaranteed, not hoped for.

### S3 — Identity: name your agent [runtime ✓ (#1426), scaffold missing]

The BOOTSTRAP.md machinery already runs a one-time naming ritual and gates
on IDENTITY.md mechanically — but nothing ever *writes* BOOTSTRAP.md, so no
real user ever sees it. Fix (O-2): a wizard act that

1. asks "where does your agent live?" (workspace dir, default `~/agent` —
   created, git-init'd, trusted via the existing project-trust store);
2. writes `SOUL.md` from 3 quick choices (tone: direct/warm/terse ·
   verbosity · boundaries preset) and `USER.md` from name + a free line;
3. writes `BOOTSTRAP.md` (naming ceremony template) and runs ONE turn in
   that workspace so the agent introduces itself, names itself, writes
   `IDENTITY.md`, and deletes `BOOTSTRAP.md` — the task-13 ritual, live;
4. prints where the files live and that editing them is the API.

This is ~an afternoon of work sitting on finished machinery, and it is the
single highest emotional-payoff step in the journey: the user watches the
agent choose its own name.

### S4 — Channel: take it with you [runtime ✓ (#1413/#1444/#1415), wizard missing]

The defining Act-2 step and the largest workstream (O-3):
`agenc onboard channel` (also reachable from the main wizard):

1. **Pick a surface**: Telegram (recommended first — 2-minute BotFather
   flow), Discord, Slack, WebChat (zero-account fallback that always
   works — it's a URL on loopback).
2. **Guided token acquisition** per channel, with the exact steps inline
   (Telegram: @BotFather `/newbot` → paste token. Discord: portal link,
   *call out the MESSAGE_CONTENT privileged-intent toggle* — the known
   first-real-token trap. Slack: app manifest JSON we print for one-click
   app creation → xoxb + xapp tokens). Tokens go to the daemon-env-
   sanitized stores (`AGENC_*` env or a wizard-written systemd override /
   launchd plist for the user service — decide in O-3; never plaintext in
   config.json).
3. **Policy, explained in one sentence**, default pairing: "strangers who
   message your bot get a pairing code; approve them with
   `agenc gateway pairing list`." Writes `gateway/config.json` through the
   existing normalizer.
4. **The live smoke as the finale**: start `gateway run` (or restart the
   service with the channel enabled), user DMs the bot, wizard shows the
   pairing code arriving, user approves, agent replies *on their phone*.
   Wizard confirms it saw the turn (gateway log line) before marking the
   act complete.
5. Ends with the persistence question answered: enable the gateway in the
   user service so it survives reboots (O-4).

### S5 — Guardrails, then autonomy [runtime ✓ (#1417/#1418/#1420/#1453), wizard missing]

Order is the design (O-5): **budget → heartbeat → cron → hooks.**

1. **Budget**: propose `[budget] daily_usd` with a sane default ($2/day,
   editable), write config.toml, show `agenc budget status`. One line on
   the guarantee: "when the cap is hit, autonomy pauses and tells you —
   never silently spends or silently stops."
2. **Heartbeat**: opt-in; writes a starter `HEARTBEAT.md` ("check my
   inbox-directory / summarize overnight repo activity" templates), sets
   `[heartbeat]` with the channel from S4 as target, fires ONE tick live.
3. **Cron**: one example scheduled job created via the real CronCreate
   surface with `announceChannel` from S4 ("every morning at 9: …").
4. **Webhooks**: prints the minted hooks token + a copy-paste `curl` the
   user runs from another terminal; the reply lands in their channel.
   (The task-17 smoke, productized.)

Each sub-step independently skippable; each ends with the live proof.

### S6 — Posture recap + what-now card [audit ✓, recap missing]

O-6: final screen = `agenc security audit` result (should be green) plus a
one-screen summary of what was opened and its posture (channels + policy,
hooks loopback+token, budget cap, heartbeat cadence), then a "what to try"
card (5 curated prompts exercising channels/cron/memory) and pointers:
`/help`, `agenc onboard --status`, the migration guides.

## 4. Workstreams (TODO-task format, priority order)

### O-1. Act-1 completion: zero-key path + guaranteed first magic — M
- **Build:** provider step branch "I don't have a key": Ollama/LM Studio
  port autodetect (offer detected models), per-provider key deep-links;
  post-connection-test canned first turn (cwd-aware). Hosted free tier
  plugs in here later (blocked on TODO task 33, external).
- **Pointers:** `runtime/src/onboarding/Onboarding.tsx` (provider/api-key
  steps), `useApiKeyVerification.ts`, provider registry
  `runtime/src/llm/registry/`.
- **Acceptance:** a machine with Ollama running and NO key reaches a real
  first reply without leaving the wizard; a keyless machine gets working
  deep-links, not a dead end; wizard e2e scenario covers both (drive
  input→waitForIdle per the TUI e2e gotcha).

### O-2. Act 2a: identity scaffold ("name your agent") — S/M
- **Build:** new wizard act writing SOUL.md/USER.md/BOOTSTRAP.md into a
  chosen+trusted workspace, then running one live turn so the task-13
  ritual completes on screen. `agenc onboard identity` entry.
- **Pointers:** `runtime/src/memory/persona.ts` (templates must satisfy
  its budget/caps), project-trust store
  `runtime/src/permissions/trust/project-trust.ts`, onboarding state
  `projectOnboardingState.ts` (add per-act completion keys).
- **Acceptance:** fresh user ends the act with IDENTITY.md written BY THE
  AGENT and BOOTSTRAP.md deleted; re-running the act with an existing
  identity offers edit, never re-runs the ritual (the mechanical gate,
  surfaced); files pass `capPersonaContent` untruncated.

### O-3. Act 2b: channel wizard — M/L (the centerpiece)
- **Build:** `agenc onboard channel`: surface picker, per-channel guided
  token acquisition (Telegram BotFather script, Discord portal +
  MESSAGE_CONTENT intent callout, Slack app-manifest JSON printout,
  WebChat zero-account fallback), secret storage decision (user-service
  env override file, 0600 — never gateway/config.json), policy writer via
  the existing config normalizer, then the LIVE pairing walkthrough:
  start/restart gateway, show the pairing code arrive, approve, see the
  agent answer in-channel before completing.
- **Pointers:** `runtime/src/gateway/run.ts` (token env names +
  `sanitizeGatewayDaemonEnv` — new secrets must join the strip list),
  `pairing.ts` (`PairingStore`, `evaluateDmAccess`), `config.ts`
  normalizers, channel adapters for verification calls (Telegram `getMe`,
  Slack `auth.test`, Discord `/gateway/bot` — all already exist as
  transport methods usable as token validators).
- **Acceptance:** a user with only a phone completes Telegram end-to-end
  inside the wizard (token validated live before proceeding; pairing
  completed; a real turn delivered in-channel); every failure mode
  (bad token, missing Discord intent, half Slack pair) produces a specific
  next step, not a stack trace; `security audit` green after.

### O-4. Always-on: gateway in the user service — S/M
- **Build:** installer's user service currently runs the daemon only; add
  opt-in gateway unit (`agenc gateway install-service` or a flag in O-3's
  finale) with the sanitized env file; `agenc onboard --status` reports
  daemon + gateway + channels in one line.
- **Pointers:** `packaging/` (systemd/launchd units from Phase 0),
  `runtime/src/bin/gateway-cli.ts`.
- **Acceptance:** after reboot (or service restart in tests), the paired
  channel still answers with no manual step; status output covers it.

### O-5. Act 3: guardrails-then-autonomy wizard — M
- **Build:** budget-cap step (writes `[budget]`, shows `budget status`),
  heartbeat opt-in (HEARTBEAT.md template + `[heartbeat]` targeting the
  S4 channel + one live tick), cron example via real CronCreate with
  `announceChannel`, hooks intro (print token + copy-paste curl, watch it
  land). HARD ORDER: autonomy steps refuse to enable while budget is
  unset unless the user explicitly picks "no cap" (visibly).
- **Pointers:** `runtime/src/budget/config.ts` (`resolveBudgetPolicy`),
  `runtime/src/heartbeat/wire.ts`, `runtime/src/gateway/cron-delivery.ts`
  + CronCreate surfaces (BOTH tool catalogs), `runtime/src/gateway/hooks.ts`.
- **Acceptance:** completing the act yields: a cap in config.toml, one
  live heartbeat tick delivered, one cron job listed with delivery
  routing, one hook POST answered — all observed by the wizard itself;
  skipping everything is one keypress per sub-step.

### O-6. Posture recap + what-now card — S
- **Build:** final wizard screen running the audit + rendering the
  opened-surfaces summary and 5 curated starter prompts; same summary
  available as `agenc onboard --status` (human) and `--json`.
- **Pointers:** `runtime/src/bin/security-cli.ts`
  (`buildSecurityAuditReport` is importable), onboarding state.
- **Acceptance:** the recap names every surface the wizard opened with its
  posture line; audit red blocks act completion with the remediation
  inline.

### O-7. Docs + landing alignment — S
- **Build:** quickstart gains Act 2/Act 3 sections; README + get.agenc.ag
  copy lead with the 15-minute T2A outcome and the three-command journey;
  record ONE end-to-end terminal cast of install→channel→phone-reply.
  (agenc.ag marketplace copy rules apply where the landing overlaps the
  marketplace story.)
- **Acceptance:** every wizard act has a doc section that matches its
  actual screens; the cast shows the real product, not a mock.

### O-8. Node-free install (bundled runtime) — L **[DEFERRED]**
- Evaluate node SEA / bun compile for the tarball so `curl|sh` works on a
  bare VPS. Take up only if §7 funnel data shows the Node ≥ 25
  prerequisite is the biggest drop.

### O-9. First-week retention loop — S **[PARTIAL — act-completion hints + recap prompts + --status next-act shipped; TUI-greeting and heartbeat-morning hints remain]**
- **Build:** day-2+ nudges through surfaces we already own: heartbeat's
  first morning message includes "3 things you can ask me"; `agenc` TUI
  greeting shows one unexplored-capability hint (local state only).
- **Acceptance:** hints derive from local completion state; each shows at
  most once; zero network calls.

## 5. Sequencing & effort

```
Week 1: O-2 (identity, S/M) + O-1 (zero-key + first magic, M)   → Act 1+2a done
Week 2: O-3 (channel wizard, M/L)                               → the centerpiece
Week 3: O-4 (service, S/M) + O-5 (autonomy, M)                  → Act 3 done
Week 4: O-6 + O-7 (recap + docs, S+S), O-9 (S)                  → polish + retention
```

Each workstream = one branch/PR with the standard gates (TODO.md protocol);
O-1/O-2/O-3/O-5 all need wizard e2e scenarios (mind the TUI e2e gotchas:
input→waitForIdle, no phrase anchors on diff repaints; pre-clear stray
daemons before gate runs).

## 6. Explicit non-goals

- **Marketplace onboarding** (wallets, tasks, mainnet) — owned by the
  AgenC Marketplace kit and its own rails; the CLI wizard never touches
  signing surfaces. At most, the what-now card may *mention* the kit.
- **Web-based signup/account** — nothing here requires an account; hosted
  free tier (id.agenc.ag) is an optional provider branch, blocked
  externally (task 33).
- **Runtime telemetry** — see §7.
- **Windows-native wizard parity** in v1 — install docs cover Windows;
  wizard parity tracked separately after funnel data.

## 7. Measurement (no phone-home)

- **Server side (already ours):** get.agenc.ag request counts + installer
  download completions per channel (curl/npm/brew/docker) from the
  existing Vercel edge — the only remote funnel signal, and it's ours.
- **Local, inspectable, consent-free:** `agenc onboard --status --json`
  gains per-act completion timestamps (extends
  `projectOnboardingState.ts`). Anyone (including support conversations
  and CI images) can read the funnel from the machine itself; nothing
  leaves it.
- **Definition of success:** cold VM → Act 2 complete in < 15 min without
  reading docs; `security audit` green at every act boundary; the
  install→phone-reply cast reproducible on every release.

## 8. Risks & dependencies

| Risk | Mitigation |
|---|---|
| id.agenc.ag device-code flow auto-approves mocks (task 33, external) | Free-tier branch ships DARK behind the fix; Ollama autodetect carries the zero-key path meanwhile |
| Discord MESSAGE_CONTENT privileged intent confuses users | O-3 calls it out inline with a portal deep-link; token validator distinguishes "bad token" from "missing intent" |
| Channel tokens at rest | Service env override files 0600 + `sanitizeGatewayDaemonEnv`; audit check extension for token-file perms (fold into `sensitive-file-perms`) |
| Wizard drift vs. runtime config | Principle 6: wizard writes ONLY through existing loaders/normalizers; contract tests import both sides |
| First-token live smokes flake in CI | Wizard e2e uses injected fake transports (the task-9 pattern); ONLY the human-run journey uses real tokens |
| Repo velocity (multiple sessions landing daily) | Same discipline as tasks 9/17: branch early, rebase before merge, expect `run.ts`/CLI-parse conflicts |

---

*Written 2026-07-09. Grounded against agenc-core @ `3d2eedb9c` (task 17
merge). Companion to `docs/parity-roadmap-2026-07.md`; lift workstreams
into TODO.md as tasks when scheduled.*
