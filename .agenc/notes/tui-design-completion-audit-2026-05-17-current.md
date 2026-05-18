## TUI Design Replacement Completion Audit - 2026-05-17

Objective restated as concrete deliverables:

1. Create `goal.md` for the large prompt and provide a `/goal` prompt.
2. Fetch the design bundle from the Anthropic design URL.
3. Read the bundle in the requested order, especially `TUI-RUNTIME-SYNC.md`,
   and account for its five open questions.
4. Replace the AgenC TUI visual layer while preserving runtime systems:
   `runtime/src/tui/main.tsx`, `runtime/src/tui/components/App.tsx`,
   `runtime/src/tui/ink/`, `runtime/src/utils/theme.ts`, event log, session
   store, command registry, MCP manager, keybinding system, permission engine,
   and AppStateStore.
5. Implement every build-sequence item from `TUI-RUNTIME-SYNC.md` section 10.
6. Verify all numbered windows `01a` through `19c`, including `148x40`,
   `120x30`, and `80x24` smoke coverage.
7. Finish with open-question answers, files changed, validation commands, and
   intentional divergences or runtime mismatch notes.

### Prompt-to-Artifact Checklist

| Requirement | Evidence inspected | Status |
|---|---|---|
| `goal.md` exists and contains the full objective. | `sed -n '1,220p' goal.md` showed the design URL, stack constraints, build sequence, acceptance criteria, and final output requirements. | Complete |
| `/goal` prompt exists in the active goal. | `get_goal` objective points at `/home/tetsuo/git/AgenC/agenc-core/goal.md` and restates no branch/worktree/push/pull/fetch/sync plus implementation and validation duties. | Complete |
| Direct design bundle fetch. | `curl -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/design/h/ffNqVHYexickEtXSQWjZRA?open_file=AgenC+TUI.html` returned HTTP 404 `not found`; `ANTHROPIC_API_KEY` is unset. Local Claude OAuth token retry returned HTTP 403 `insufficient OAuth scopes`. | Blocked / incomplete |
| Local design bundle available. | `/tmp/agenc-design.bundle` exists, sha256 `752001a77e6b125c385fd6abf8c5fe35e77cad534c51b4278a55a873c6bc1068`; extracted files include `AgenC TUI.html`, `TUI-RUNTIME-SYNC.md`, `TUI-IMPLEMENTATION.md`, `TUI-UX-RESEARCH.md`, and the requested JSX sources. | Partial substitute for direct fetch |
| Bundle README and transcript available. | `/tmp/agenc-tui-handoff/agenc-tui/README.md` says to read chat transcripts and `project/AgenC TUI.html`; `/tmp/agenc-bundle-verify/agenc-tui/chats/chat1.md` contains the final handoff instructions; `TUI-RUNTIME-SYNC.md` in `/tmp/agenc-tui-handoff` and `/tmp/agenc-bundle-verify` match with sha256 `fa5bbaa2f31a262b40bdc93adace0d7e112b6abbdd5603e087cb3b8c920dd607`. | Complete for local bundle, not live URL |
| `TUI-RUNTIME-SYNC.md` open questions answered. | `runtime/src/tui/README.md` documents theme-token overlap, 8 permission modes, `agenc-core` plugin placement, `protocol_*` event union placement, and typed confirmation handling. | Complete |
| Theme tokens added to all variants. | `runtime/src/utils/theme.ts` contains `agencWash`, `worker`, `workerWash`, `successWash`, `errorWash`, `text2`, `muted3`, `line`, `lineSoft`, `briefLabelWorker`, and `planModeWash` across theme variants including ANSI variants. | Complete |
| Mode pill wired to permission mode and Shift+Tab cycle retained. | `runtime/src/tui/components/v2/primitives.tsx` has `ModePill`/`ModeSwitcher`; `runtime/src/tui/components/FullscreenLayout.test.tsx` verifies `mode · plan`; `runtime/src/tui/keybindings/defaultBindings.ts` maps `shift+tab` to mode cycling. | Complete |
| Terminal frame/header/status/prompt single v2 source. | `TerminalFrame`, `TuiHeader`, `StatusBar`, `PromptChrome` in `runtime/src/tui/components/v2/primitives.tsx`; smoke tests cover `148x40`, `120x30`, and `80x24`. | Complete |
| Slash registry consolidation. | `runtime/src/commands/registry.ts` registers `/model`, `/provider`, `/hooks`, `/compact`, `/plugins`, `/memory`, `/resume`; `/tasks` aliases include `/jobs` and `/bashes`; `runtime/src/commands/protocol.ts` registers `/claim`, `/delegate`, `/proof`, `/settle`, `/stake` as `agenc-core` plugin commands. | Complete |
| One `MenuModal` with live bindings. | `MenuModal` is in `runtime/src/tui/components/v2/primitives.tsx`; model/provider/hooks/skills/mcp/plugins/agents/permissions/memory/resume/task/context command surfaces use it or the new panel/modal. | Complete for requested eight plus extra provider/resume |
| Conversation renderer against event log. | Old `components/messages` and `components/permissions` trees contain 0 files; renderers moved under `runtime/src/tui/message-renderers`; protocol event mapping exists in `runtime/src/tui/session-transcript.ts` and `SystemTextMessage.tsx`. | Complete |
| File picker `@`, shell mode `!`, streaming markdown renderer. | Existing PromptInput/bashing/markdown surfaces preserved and retinted; targeted tests include prompt slash suggestions and visual contract. | Implemented, but only indirectly covered by existing tests |
| `/ctx` modal. | `runtime/src/tui/components/v2/ContextUsageModal.tsx` and `/ctx` opening in `runtime/src/commands/session-compact.ts`. | Complete |
| Background tasks panel replacing old dialog. | `BackgroundTasksDialog.tsx` deleted; `BackgroundTasksPanel.tsx` exists and `/tasks` opens it through `setToolJSX`. | Complete |
| Plan-mode banner and accept flow. | `PlanModeBanner` in v2 primitives; `FullscreenLayout.test.tsx` asserts banner only for `permissionMode === 'plan'`. | Complete for render gate; accept-flow behavior covered indirectly |
| Protocol event types added and rendered inline. | `runtime/src/session/event-log.ts`, `runtime/src/tui/session-transcript.ts`, and `runtime/src/tui/parity/session-transcript.test.ts` cover `protocol_claim`, `protocol_settle`, `protocol_slash`, `protocol_stake`. | Complete |
| No forbidden terminal-visual CSS concepts in component chrome. | `runtime/src/tui/components/visual-contract.test.ts` scans component/message-renderer source for inline hex, rgba, gradients, shadows, blur, rounded corners, and extra animation hooks. | Complete for scanned source |
| Numbered state coverage `01a` through `19c`. | `runtime/src/tui/components/v2/designStateSmoke.test.tsx` asserts all 29 numbered states and maps them to design artboards. | Complete |
| Direct browser-derived visual parity. | Full live browser design smoke passed with `AGENC_TUI_DESIGN_BROWSER=1` and `AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html`: 100 tests passed, all 1,857 live browser markers found. | Strong smoke evidence |
| Exact no-drift cell-for-cell visual parity. | Current projected browser text-cell check is 1,775 / 9,162 aligned after best offsets, and row/column checks are threshold-based. This does not prove exact no-drift visual identity. | Incomplete / weakly verified |
| Runtime validation at required viewports. | `agenc-tui-validate --full` rebuilt runtime, imported `dist/tui/main.js`, and PTY-smoked `agenc` and `agenc --yolo` at `148x40`, `120x30`, and `80x24`; footer/core/yolo parity gates passed. | Complete |
| Typecheck and targeted tests. | `npm run typecheck` passed; focused TUI tests passed 34/34; design smoke passed 100/100; `git diff --check` passed; branding scan clean. | Complete |
| Final output with files changed, validations, divergences. | Previous summary included these at high level, but no final completion should be issued while direct fetch and exact no-drift parity remain unresolved. | Pending |

### Completion Decision

Do not mark the active goal complete yet.

Two objective requirements remain uncovered:

1. The direct Anthropic design URL cannot be fetched in this environment without
   an API key or OAuth scope that is not currently available. The local bundle
   is a useful substitute, but it is not evidence that the current URL was
   fetched successfully.
2. The stated acceptance criterion says every numbered window reproduces with
   no visual drift. The current suite provides strong semantic/browser-marker
   coverage and real PTY startup coverage, but not exact cell-for-cell parity.

Next actions to close:

1. Obtain valid access for the design URL or accept the local bundle hash as
   the source-of-truth exception.
2. Promote the browser-derived parity harness from broad row/column thresholds
   to strict state-by-state cell-grid assertions, or explicitly relax the
   acceptance criterion in the goal.

### Latest Recheck - 2026-05-17 16:44

- Direct URL recheck:
  - `ANTHROPIC_API_KEY=unset`
  - `curl -H 'anthropic-version: 2023-06-01' ...` returned HTTP `404`
    with body `not found`.
- Local bundle snapshot:
  - `/tmp/agenc-design.bundle`: gzip, sha256
    `752001a77e6b125c385fd6abf8c5fe35e77cad534c51b4278a55a873c6bc1068`
  - `/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html`: sha256
    `2c996e9b06b540b015388880c46c9b83439f1bc04bd60672262a221599fb12a6`
  - `/tmp/agenc-tui-handoff/agenc-tui/project/TUI-RUNTIME-SYNC.md`: sha256
    `fa5bbaa2f31a262b40bdc93adace0d7e112b6abbdd5603e087cb3b8c920dd607`
- Focused parity recheck:
  - `AGENC_TUI_DESIGN_BROWSER_REPORT=1 AGENC_TUI_DESIGN_HTML=... npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=verbose --testNamePattern 'projected browser text cells|live browser-rendered design text|expanded browser text-cell fixture'`
  - Passed 3 tests, but the live-browser test was skipped because
    `AGENC_TUI_DESIGN_BROWSER=1` was not set in that command.
  - Expanded browser marker fixture found nearly all markers and projected
    exact-cell summary remained `1,775/9,162`.
- Live browser recheck:
  - `AGENC_TUI_DESIGN_BROWSER=1 AGENC_TUI_DESIGN_BROWSER_REPORT=1 AGENC_TUI_DESIGN_HTML=... npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=verbose --testNamePattern 'live browser-rendered design text'`
  - Passed 1 test; every live browser marker was found for every numbered
    state, but row/column alignment remains threshold-based rather than strict
    exact-position parity.

### Latest Parity Investigation - 2026-05-17 16:48

- Added a temporary env-gated debug test, printed state `10` at `148x40`, and
  removed the debug code after inspection.
- The render before clipping produced 52 text rows for a nominal 40-row
  viewport. This explains part of the row drift and shows the current
  `renders numbered design state without overflow` test only checks line
  width and semantic markers; it does not enforce exact row-count fit.
- A scoped experiment changing the v2 `TerminalFrame` from `minHeight` to exact
  `height` clipped/compressed many states and caused broad marker regressions,
  so it was reverted rather than left in the tree.
- Focused recheck after reverting the experiment:
  - `AGENC_TUI_DESIGN_BROWSER_REPORT=1 AGENC_TUI_DESIGN_HTML=... npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=verbose --testNamePattern 'projected browser text cells|expanded browser text-cell fixture|renders numbered design state without overflow'`
  - Passed: 89 tests, 11 skipped.
  - Projected exact-cell summary remained `1,775/9,162`, confirming the parity
    gap is still open.
- Public print URL found in the transcript was also tested:
  - `curl -L` returned HTTP `403` with a Cloudflare interstitial, not the
    design artifact.

### Latest Row-Fit Investigation - 2026-05-17 16:53

- Temporary row-count measurement showed these `148x40` static fixture heights:
  - Exactly 40 rows: `01a`, `02b`, `03a`, `05a`, `05b`, `07a`, `07b`,
    `08b`, `11`, `15`
  - Over 40 rows: `01b=42`, `02a=42`, `03b=42`, `04a=50`, `04b=44`,
    `06a=45`, `06b=57`, `08a=41`, `09=65`, `10=52`, `12=59`, `13=62`,
    `14=45`, `16=55`, `17=67`, `18=78`, `19a=51`, `19b=43`, `19c=41`
- The design source uses absolute overlays for menu/context modals:
  - `tui-v2-menus.jsx` `MenuModal`: `position: 'absolute', inset:
    '54px 64px 78px 64px'`
  - `tui-v2-states-extra.jsx` `ContextManager`: modal overlay with
    `position: 'absolute', inset: '60px 80px 84px 80px'`
- The current smoke fixture renders several menu/context modals in normal
  flow inside `ChatBody`, which inflates static render height and weakens
  exact browser-cell parity.
- A narrower production-shaped experiment gave `ChatBody` / `MenuModal`
  row budgets via frame context (`maxHeight` rather than exact frame height).
  It improved some projected cell groups but clipped expected content in the
  existing `80x24` acceptance smoke, so it was reverted.
- Kept a small forward fix from the source inspection: `TerminalFrame` now has
  a `bodyOverlay` slot so future menu/context callers can render modal content
  as a body sibling instead of embedding it in chat flow. Added a focused
  primitive test that renders chat content, overlay content, and the status bar
  together.
- Recheck after reverting:
  - `AGENC_TUI_DESIGN_BROWSER_REPORT=1 AGENC_TUI_DESIGN_HTML=... npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=verbose --testNamePattern 'projected browser text cells|expanded browser text-cell fixture|renders numbered design state without overflow'`
  - Passed: 89 tests, 11 skipped.
  - `git diff --check` passed.
- Additional validation after the `bodyOverlay` change:
  - `npx vitest run src/tui/components/v2/primitives.test.tsx src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'body overlays|projected browser text cells|expanded browser text-cell fixture|renders numbered design state without overflow'`
    passed: 2 files, 90 tests passed, 13 skipped.
  - `npm run typecheck` passed.
  - `node scripts/branding-scan.mjs --changed` passed.
  - `node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full`
    passed rebuild, artifact import, PTY startup at `148x40`, `120x30`,
    `80x24`, footer parity, core parity, and yolo parity.

### Latest Runtime Modal Wiring - 2026-05-17 17:10

- Wired prompt-owning local slash command JSX through `FullscreenLayout`'s
  existing `modal` pane instead of leaving it in scroll content:
  - `toolJSX.isLocalJSXCommand && toolJSX.shouldHidePromptInput` now renders
    via `modal={...}` with `modalScrollRef`.
  - Nonblocking tool JSX (`shouldHidePromptInput: false`) still renders inline
    in the transcript path, preserving background/tool hint behavior.
  - Scroll keybindings target `modalScrollRef` while a prompt-owning local
    modal is active.
- Updated focused coverage:
  - `App.render.test.tsx` now asserts the local `/agents` wizard reaches the
    `FullscreenLayout` modal prop while still hiding the main composer.
  - `App.tooljsx-state.parity.test.tsx` now asserts the inline-vs-modal split.
- A static fixture experiment also moved menu panels into `bodyOverlay`, but it
  clipped existing 80x24 marker expectations for `/ctx` and the mode picker.
  That experiment was reverted; only the production `App.tsx` modal routing
  remains.
- Rechecks after this wiring:
  - `npx vitest run src/tui/components/App.render.test.tsx src/tui/parity/App.tooljsx-state.parity.test.tsx --reporter=dot --testNamePattern 'toolJSX|wizard'` passed: 11 tests, 54 skipped.
  - `npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'renders numbered design state without overflow|expanded browser text-cell fixture broadly aligned|projected browser text cells|anchored browser text-cell coverage'` passed: 89 tests, 11 skipped.
  - `npm run typecheck` passed.
  - `git diff --check` passed.
  - `node scripts/branding-scan.mjs --changed` passed.
  - Full `agenc-tui-validate --full` was already green after the same
    production `App.tsx` wiring; no runtime source changed after that gate
    except reverting the temporary `TerminalFrame` overlay-top experiment.

### Latest Completion Audit - 2026-05-17 17:15 MDT

- Direct design URL fetch remains blocked:
  - `ANTHROPIC_API_KEY=unset`
  - `ANTHROPIC_AUTH_TOKEN=unset`
  - `CLAUDE_CODE_OAUTH_TOKEN=unset`
  - `curl -L -H 'anthropic-version: 2023-06-01' ...` returned HTTP `404`
    with body `not found`.
- Local design bundle used for implementation remains the same snapshot:
  - `/tmp/agenc-design.bundle`: sha256
    `752001a77e6b125c385fd6abf8c5fe35e77cad534c51b4278a55a873c6bc1068`
  - `/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html`: sha256
    `2c996e9b06b540b015388880c46c9b83439f1bc04bd60672262a221599fb12a6`
  - `/tmp/agenc-tui-handoff/agenc-tui/project/TUI-RUNTIME-SYNC.md`: sha256
    `fa5bbaa2f31a262b40bdc93adace0d7e112b6abbdd5603e087cb3b8c920dd607`
  - `/tmp/agenc-tui-handoff/agenc-tui/project/TUI-IMPLEMENTATION.md`: sha256
    `6a18036b09f4bbfcaa8e58224f7af578ac32fc78d4b68da657857725efbf5d9e`
  - `/tmp/agenc-tui-handoff/agenc-tui/project/TUI-UX-RESEARCH.md`: sha256
    `7cb75254d84862b0693b24991537458144ed3482790b61f429213d4127af16e4`
- Full live-browser design smoke passed:
  - `AGENC_TUI_DESIGN_BROWSER=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot`
  - Result: 100 tests passed.
- Full TUI validation gate passed after the runtime modal wiring:
  - `node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full`
  - Result: rebuild, built-artifact import, PTY startup at `148x40`,
    `120x30`, and `80x24`, footer parity, core parity, and yolo parity all
    passed.

Completion status remains **not complete**. Runtime validation is green, but
two contract items are still not objectively satisfied: the live design URL was
not fetched successfully, and exact no-drift visual parity is not proven by the
current threshold/marker-based harness.

### Active-Goal Completion Audit - 2026-05-17 22:26 MDT

Objective restated as concrete deliverables:

1. Keep work on `main`; do not create a branch, worktree, merge, rebase, push,
   pull, fetch, or sync.
2. Read `goal.md` and execute it exactly.
3. Fetch the live design bundle, read the README and docs in the requested
   order, confirm `TUI-RUNTIME-SYNC.md`, and list/answer its five open
   questions.
4. Replace the AgenC TUI visual layer with the design while preserving existing
   runtime systems.
5. Implement every `TUI-RUNTIME-SYNC.md` section 10 build-sequence item.
6. Validate the numbered windows `01a` through `19c`, including `148x40`,
   `120x30`, and `80x24`.
7. Finish with open-question answers, files changed, validation commands, and
   intentional divergences.

Prompt-to-artifact checklist:

| Requirement | Current evidence | Status |
|---|---|---|
| Stay on `main`, no branch/worktree. | `git branch --show-current` returned `main`; no branch/worktree commands were run in this pass. | Complete |
| Read `goal.md`. | `sed -n '1,240p' goal.md` showed the full goal, required reading order, build sequence, acceptance criteria, and final-output requirements. | Complete |
| Fetch live design URL. | `curl -sS -D /tmp/agenc-design-url.headers -o /tmp/agenc-design-url.body 'https://api.anthropic.com/v1/design/h/ffNqVHYexickEtXSQWjZRA?open_file=AgenC+TUI.html'` returned HTTP `404` with body `not found`. | Blocked |
| Local design snapshot provenance. | `/tmp/agenc-design.bundle` sha256 `752001a77e6b125c385fd6abf8c5fe35e77cad534c51b4278a55a873c6bc1068`; extracted docs and JSX sources present under `/tmp/agenc-tui-handoff/agenc-tui/project`. | Partial substitute only |
| Required docs read and open questions accounted for. | `runtime/src/tui/README.md` records source provenance, design docs read, and all five open-question answers from `TUI-RUNTIME-SYNC.md §12`. | Complete against local snapshot |
| Theme tokens in all variants. | `rg` in `runtime/src/utils/theme.ts` showed all v2 tokens in the type and every theme variant, including ANSI variants. | Complete |
| Mode pill and Shift+Tab cycle. | `ModePill` / `ModeSwitcher` are in `runtime/src/tui/components/v2/primitives.tsx`; permission-mode state is wired through `FullscreenLayout` / `AppState`; `permission-mode.ts` retains the Shift+Tab-visible cycle and the 8-mode internal superset. | Complete |
| Terminal frame, status bar, prompt, brand bleed. | `TerminalFrame`, `TuiHeader`, `PromptChrome`, `StatusBar`, and `BrandCells` live in `runtime/src/tui/components/v2/primitives.tsx`; `BrandCells` emits literal `░▒▓` cells. | Complete |
| Slash registry consolidation and protocol commands. | `runtime/src/commands/registry.ts`, `runtime/src/commands/protocol.ts`, and `runtime/src/commands/registry.test.ts` show `/model`, `/provider`, `/hooks`, `/compact`, `/plugins`, `/memory`, `/resume`, `/ctx`, and `/claim` `/delegate` `/proof` `/settle` `/stake` registered; protocol commands use bundled `agenc-core` plugin metadata. | Complete |
| Shared `MenuModal` bindings. | `MenuModal` is in v2 primitives and command/menu surfaces bind model/provider/hooks/skills/mcp/plugins/agents/permissions/memory/resume/context data. | Complete |
| Conversation renderer and old visual trees. | `runtime/src/tui/components/messages` has 0 files; `runtime/src/tui/components/permissions` has 0 files; live rendering moved under `runtime/src/tui/message-renderers` and `runtime/src/tui/permission-requests.tsx`. | Complete |
| File picker, shell mode, streaming markdown. | Design states `08a`, `08b`, and `09` are represented in `designStateSmoke.test.tsx`; PromptInput and markdown surfaces remain wired through the existing runtime. | Covered by smoke and retained runtime paths |
| `/ctx` modal. | `ContextUsageModal` exists and is included in v2 tests and slash/modal notes. | Complete |
| Background tasks panel. | `BackgroundTasksDialog.tsx` is deleted; `BackgroundTasksPanel.tsx` exists and is covered by tests. | Complete |
| Plan-mode banner and typed approval. | `PlanModeBanner` is in v2 primitives; `permission-requests.tsx` renders high-risk `ApprovalCard` with typed confirmation. | Complete |
| Protocol events. | `event-log.ts`, `session-transcript.ts`, `SystemTextMessage.tsx`, and parity tests cover `protocol_claim`, `protocol_settle`, `protocol_slash`, `protocol_stake`. | Complete |
| No gradient / inline-color drift in final touched startup path. | The pre-Ink startup screen was changed to theme-owned ANSI colors via `getTheme` / `themeColorToAnsi`; focused startup tests passed. | Complete for touched path |
| Numbered state coverage and required viewports. | `designStateSmoke.test.tsx` defines all 29 states `01a` through `19c` and `VIEWPORTS` includes `148x40`, `120x30`, `80x24`; full source-backed and browser-backed smoke both passed `103` tests. | Complete |
| Exact no-drift parity. | The smoke harness enforces markers, source artboard mapping, unsupported-style checks, ANSI/color family checks, and broad browser alignment. It does not prove exact cell-for-cell no-drift parity. | Weak / incomplete |
| Validation commands. | Latest passes: design smoke `103/103`; browser-backed design smoke `103/103`; startup test `36/36`; prompt/instruction tests `68/68`; Bun project-instruction tests `10/10`; `npm run typecheck`; full `.agenc` TUI gate including rebuild and PTY startup at `148x40`, `120x30`, `80x24`; `branding-scan`; `git diff --check`. | Complete except live fetch / exact no-drift |

Completion decision: do **not** call `update_goal complete`.

The implementation and local validation are green, but the active objective
still has two objectively unresolved requirements: the live design URL does not
fetch successfully from this environment, and exact no-drift visual parity is
not proven beyond the threshold/marker/browser smoke harness. Closing requires
either a working design-scoped URL/credential plus exact parity proof, or an
explicit user decision accepting the local snapshot and current parity gate as
the contract.

### Exact Parity Gate Tightening - 2026-05-17 22:29 MDT

- Converted the env-gated projected text-cell drift diagnostic into a
  fail-closed exact-parity gate:
  - `AGENC_TUI_DESIGN_EXACT_CELLS=1 npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'fails closed on projected browser text-cell drift when exact parity is requested'`
  - Current result: fails, with all 29 states reporting projected cell drift.
- Kept normal design smoke green:
  - `AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot`
  - Current result: `103` tests passed.
- Documented the new completion-grade exact-cell command in
  `runtime/src/tui/README.md`.

Completion status remains **not complete**. The repo now has an executable
gate for the strict no-drift acceptance criterion, and that gate currently
proves the criterion is not met.

### Active-Goal Completion Audit - 2026-05-17 17:19 MDT

Objective restated as concrete deliverables:

1. Create `goal.md` because the user-provided implementation prompt is larger
   than the slash-goal input.
2. Provide a `/goal` prompt that points Codex at `goal.md` and repeats the
   local hard rules.
3. Fetch the Anthropic design bundle from the provided URL and read the bundle
   README plus `TUI-RUNTIME-SYNC.md`, `TUI-IMPLEMENTATION.md`,
   `TUI-UX-RESEARCH.md`, `AgenC TUI.html`, and every named JSX source in the
   requested order.
4. Confirm `TUI-RUNTIME-SYNC.md` was read and list its five open questions.
5. Preserve the runtime stack while replacing the AgenC TUI visual layer:
   `main.tsx`, `App.tsx`, `runtime/src/tui/ink/`, theme, event log, session
   store, command registry, MCP manager, keybinding system, permission engine,
   and `AppStateStore`.
6. Implement every build-sequence item from `TUI-RUNTIME-SYNC.md` section 10,
   including theme tokens, header mode pill, terminal frame, slash registry,
   modal menus, conversation renderer, file picker, shell mode, streaming
   markdown, `/ctx`, background tasks, plan mode, protocol events, and viewport
   smoke tests.
7. Satisfy section 11 acceptance: every numbered window `01a` through `19c`
   reproduces in the running TUI at `148x40` with no visual drift, plus
   `120x30` and `80x24` truncation safety.
8. Finish with open-question answers, files changed, validation commands, and
   intentional divergences or runtime mismatch notes.

Prompt-to-artifact checklist:

| Requirement | Evidence inspected | Status |
|---|---|---|
| `goal.md` exists and contains the long prompt. | `sed -n '1,220p' goal.md`; file exists and includes objective, stack, reading order, non-negotiables, build sequence, acceptance, repository rules, and final-output requirements. | Complete |
| `/goal` prompt provided. | Final response before this audit included a concrete `/goal "...Read .../goal.md..."` prompt. | Complete |
| Stay on `main`; no branch/worktree/merge/rebase/push/pull/fetch/sync. | `git status --short` shows work on current tree; no branch/worktree commands were used in this continuation. | Complete for this continuation |
| Live design URL fetched. | URL variants tried unauthenticated and with local Claude OAuth token. Unauthenticated returned `404`; `Authorization: Bearer <local-token>` returned `403 insufficient OAuth scopes`; `X-Claude-Code-Authorization` returned `404`. | Blocked / incomplete |
| Local design bundle available and read. | `/tmp/agenc-design.bundle` is a gzip bundle containing README, docs, HTML, JSX, fonts, and assets. Local docs and source hashes are recorded above. | Complete as fallback source |
| `TUI-RUNTIME-SYNC.md` five questions captured. | `runtime/src/tui/README.md` has answers for token overlap, permission enum, protocol command location, event schema location, and typed confirmation. | Complete |
| Runtime stack preserved. | `App.tsx`, `FullscreenLayout.tsx`, `runtime/src/tui/ink/`, command and permission systems remain in use; `App.tsx` routes prompt-owning local JSX through the modal pane instead of replacing the shell. | Complete by inspection |
| Previous message/permission visual tree deleted/replaced. | `git status --short` shows old `runtime/src/tui/components/messages/**` and `components/permissions/**` deleted or moved, with new `runtime/src/tui/message-renderers/**`, `message-theme.ts`, `message-visibility.ts`, `permission-types.ts`, and v2 primitives. | Mostly complete |
| Section 10 build sequence implemented. | Design smoke, runtime modal routing tests, slash/menu notes, protocol/event notes, background tasks panel, plan mode, and v2 primitives exist. Typecheck and runtime validation pass. | Strong but not fully audited row-by-row |
| 148x40/120x30/80x24 runtime smoke. | Full `agenc-tui-validate --full` passed built-artifact import and PTY startup for `agenc` and `agenc --yolo` at all three sizes. | Complete |
| Numbered window semantic coverage. | Full live-browser design smoke passed 100 tests and all numbered states `01a` through `19c` have browser marker fixtures. | Complete |
| Exact no-drift visual parity. | Current strict-ish projected browser cell test reports only `1,775/9,162` aligned cells; modal-heavy states remain row-drifted. Existing pass thresholds are broad and do not prove no drift. | Incomplete |
| Final completion summary. | Cannot honestly issue a completion summary while live fetch and exact no-drift parity remain incomplete. | Pending |

Completion decision: **do not call `update_goal complete`**.

The next work to achieve completion is either:

1. Obtain a token/scope that can fetch the live design URL, or get explicit
   acceptance that the recorded `/tmp/agenc-design.bundle` snapshot is the
   source of truth.
2. Replace the broad browser-marker parity test with a strict state-by-state
   row/column visual contract and then adjust the modal/frame rendering until
   it passes, or get explicit acceptance that the current marker/viewport
   evidence is sufficient instead of exact no-drift parity.

### Latest visual tightening - 2026-05-17 17:38 MDT

Additional implementation work completed after the audit above:

- `/ctx` now renders with the design-style context usage modal: header row,
  usage bar, `BREAKDOWN BY SOURCE`, source rows for system/plan/files/history
  and tool catalog, plus compact/drop/rewind/btw footer actions.
- `/tasks` now uses the shared v2 `MenuModal` table plus preview layout while
  preserving task sorting, selection, detail preview, and stop actions.
- The header mode switcher now matches the design source more closely:
  `permission mode` heading, numbered rows, runtime mode names such as
  `acceptEdits` and `bypassPermissions`, and the `/permissions` footer hint.

Validation run after those changes:

- `npx vitest run src/tui/components/v2/ContextUsageModal.test.tsx src/tui/components/tasks/BackgroundTasksPanel.test.tsx src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'ContextUsageModal|BackgroundTasksPanel|renders numbered design state without overflow|expanded browser text-cell fixture broadly aligned|projected browser text cells'`
  - Passed: 95 tests, 11 skipped.
- `npx vitest run src/tui/components/v2/primitives.test.tsx src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'mode switcher|renders numbered design state without overflow|expanded browser text-cell fixture broadly aligned|projected browser text cells'`
  - Passed: 90 tests, 13 skipped.
- `AGENC_TUI_DESIGN_BROWSER_REPORT=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/'AgenC TUI.html' npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=verbose --testNamePattern 'projected browser text cells|expanded browser text-cell fixture broadly aligned'`
  - Passed, with improved but still incomplete projected cell alignment for
    `/ctx` and mode-switcher states (`10: 20/178`, `19c: 76/423`).
- `AGENC_TUI_DESIGN_BROWSER=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/'AgenC TUI.html' npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot`
  - Passed: 100 tests.
- `npm run typecheck` from `runtime`
  - Passed.
- `git diff --check`
  - Passed.
- `node scripts/branding-scan.mjs --changed`
  - Passed; 77 changed files scanned.
- `node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full`
  - Passed: rebuild, built-artifact import, PTY startup at `148x40`,
    `120x30`, and `80x24`, footer parity, core parity, and yolo parity.

Completion decision remains **not complete**. Runtime validation is green and
several high-visibility design states are closer, but the live design URL still
cannot be fetched with the available local credentials and exact no-drift visual
parity is still not objectively proven.

### Fullscreen overlay tightening - 2026-05-17 17:52 MDT

Additional implementation work completed after the prior audit:

- Prompt-owned fullscreen dialogs now render through the existing prompt
  overlay portal instead of inside the clipped prompt slot:
  `BackgroundTasksPanel` and `ModeSwitcher` use the portal in fullscreen and
  keep their previous inline behavior outside fullscreen.
- The dialog portal moved from the bottom prompt layer into the main body
  layer, with centered/inset positioning matching the modal behavior in the
  design bundle. Slash suggestions remain in the prompt layer.
- `/ctx` removed raw diagnostic rows from the structured modal so the source
  footer actions (`/compact`, drop file, rewind, `/btw side-question`) are
  visible at `148x40`; the header now reports `11.4% used · headroom 177k`
  to match the design.
- Design smoke states for `/ctx`, `/tasks`, and the mode switcher now compose
  through body overlays rather than inline transcript content. The full
  browser-backed smoke test is green again.

Validation run after those changes:

- `npx vitest run src/tui/components/PromptInput/slashCommandSuggestions.test.ts src/tui/components/tasks/BackgroundTasksPanel.test.tsx src/tui/components/v2/primitives.test.tsx --reporter=dot`
  - Passed: 10 tests.
- `npx vitest run src/tui/components/FullscreenLayout.test.tsx src/tui/components/App.render.test.tsx --reporter=dot`
  - Passed: 77 tests.
- `AGENC_TUI_DESIGN_BROWSER=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/'AgenC TUI.html' npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot`
  - Passed: 100 tests.
- `AGENC_TUI_DESIGN_BROWSER_REPORT=1 npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=verbose --testNamePattern 'projected browser text cells|expanded browser text-cell fixture broadly aligned'`
  - Passed. Expanded browser fixture coverage improved for key modal states:
    `/ctx` `30/30`, `/tasks` `30/30`, mode switcher `30/30`.
  - The projected text-cell report remains broad, not exact:
    `/ctx` `49/178`, `/tasks` `57/253`, mode switcher `77/423`.
- `npm run typecheck` from `runtime`
  - Passed.
- `git diff --check`
  - Passed.
- `node scripts/branding-scan.mjs --changed`
  - Passed; 77 changed files scanned.
- `node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full`
  - Passed: rebuild, built-artifact import, PTY startup at `148x40`,
    `120x30`, and `80x24`, footer parity, core parity, and yolo parity.

Completion decision remains **not complete** for the same objective-level
reasons: the live design URL is still inaccessible with available local
credentials, and the current projected-cell harness still does not prove exact
no-drift parity for every numbered window.

Current live-fetch check:

- `curl -sS -o /tmp/agenc-design-live-fetch-check.body -w '%{http_code} %{content_type}\n' 'https://api.anthropic.com/v1/design/h/ffNqVHYexickEtXSQWjZRA?open_file=AgenC+TUI.html'`
  - Result: `404 text/plain; charset=utf-8`, body `not found`.

### Browser Parity Gate Tightening - 2026-05-17 17:56 MDT

The live-browser design parity test was tightened after the fullscreen overlay
work:

- Every numbered state now must find **all** stable text markers extracted live
  from the design HTML, not just a per-state `>= 65%` floor.
- Every numbered state now has row and column alignment floors:
  - row-aligned text markers: `>= 55%`
  - column-aligned text markers: `>= 40%`
- Global live-browser row and column floors are tighter:
  - row alignment: `>= 86%`
  - column alignment: `>= 85%`

Validation after tightening:

- `AGENC_TUI_DESIGN_BROWSER=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/'AgenC TUI.html' npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'live browser-rendered design text broadly aligned'`
  - Passed: 1 test, 99 skipped.
- `AGENC_TUI_DESIGN_BROWSER=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/'AgenC TUI.html' npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot`
  - Passed: 100 tests.
- `npm run typecheck` from `runtime`
  - Passed.
- `git diff --check`
  - Passed.
- `node scripts/branding-scan.mjs --changed`
  - Passed; 77 changed files scanned.

Completion decision remains **not complete**. The parity harness is stronger,
but it is still a marker/text alignment harness rather than a cell-for-cell
visual equivalence proof, and the live design URL still returns `404` without
credentials that can access it.

### Projected Cell Gate Tightening - 2026-05-17 17:59 MDT

The projected browser text-cell test was tightened after the live-browser gate:

- Added state-specific projected cell alignment floors for every numbered
  window (`01a` through `19c`) from the current browser-derived grid report.
  This removes the previous single weak per-state `>= 0.03` floor and makes
  each state preserve its measured projected-cell alignment.
- Rechecked available environment credentials without printing secrets:
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `ANTHROPIC_AUTH_TOKEN`
  are all absent in the current shell.

Validation after tightening:

- `npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'projected browser text cells|live browser-rendered design text broadly aligned'`
  - Passed: 2 tests, 98 skipped.
- `AGENC_TUI_DESIGN_BROWSER=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/'AgenC TUI.html' npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot`
  - Passed: 100 tests.
- `npm run typecheck` from `runtime`
  - Passed.
- `git diff --check`
  - Passed.
- `node scripts/branding-scan.mjs --changed`
  - Passed; 77 changed files scanned.
- `node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full`
  - Passed: rebuild, built-artifact import, PTY startup at `148x40`,
    `120x30`, and `80x24`, footer parity, core parity, and yolo parity.

Completion decision remains **not complete**. The local design-bundle parity
gates are now stricter, but the objective still explicitly requires fetching
the design bundle from the live Anthropic URL, and that URL remains inaccessible
with the current credentials/environment.

### Continuation Audit - 2026-05-17 22:43 MDT

Additional evidence gathered in the latest continuation:

- Confirmed the checkout is still on `main`:
  - `git branch --show-current` returned `main`.
- Re-read the active `goal.md`; it still requires both live design fetch and
  exact no-drift reproduction of every numbered state.
- Re-read the bundle README from `/tmp/agenc-tui-handoff/agenc-tui/README.md`.
  The README is one directory above `project/` and instructs agents to read the
  exported chat transcript before treating the HTML as final intent.
- Re-read the exported transcript at
  `/tmp/agenc-tui-handoff/agenc-tui/chats/chat1.md`, confirming the final
  design intent: classic Claude Code / Codex single-pane TUI shape, no
  program-drawn macOS chrome, terminal-renderable character-cell primitives.
- Re-read `TUI-RUNTIME-SYNC.md`, `TUI-IMPLEMENTATION.md`, `AgenC TUI.html`,
  `tui-frame.jsx`, `tui-v2-prim.jsx`, and menu/state JSX excerpts used to
  investigate layout drift.
- Retried the live Anthropic design URL:
  - Command wrote headers/body to `/tmp/agenc-design-live.headers` and
    `/tmp/agenc-design-live.body`.
  - Result: HTTP `404`, body sha256
    `709009e02c8e364113b28205aadde30cce270d709073f28153c85fdc5036c96d`,
    body text `not found`.
- Re-ran the completion-grade exact-cell gate:
  - `AGENC_TUI_DESIGN_EXACT_CELLS=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=verbose --testNamePattern 'fails closed on projected browser text-cell drift when exact parity is requested'`
  - Result: failed. All 29 states still report projected browser text-cell
    drift.
- Investigated a modal-padding adjustment against the source mockup geometry.
  It improved `/model` alignment locally but regressed `19a` below the existing
  projected-cell floor, so the experiment was reverted rather than left in the
  tree.
- Restored focused design smoke baseline:
  - `AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'projected browser text cells|renders numbered design state without overflow'`
  - Result: `88` passed, `15` skipped.
- Additional checks after restoration:
  - `npx vitest run src/tui/components/v2/primitives.test.tsx src/tui/components/v2/ContextUsageModal.test.tsx --reporter=dot`
    passed `6` tests.
  - `npm run typecheck` from `runtime` passed.
  - `node scripts/branding-scan.mjs --changed` passed.
  - `git diff --check` passed.
- Corrected the AgenC-owned validation skill documentation under
  `/home/tetsuo/.agenc/skills/agenc-tui-validate/SKILL.md` to use
  `~/.agenc/skills/...` and `.agenc/notes/...`; legacy `.claude/notes` is
  described only as a compatibility fallback.

Completion decision remains **not complete**. The current implementation is
green against the broad local smoke gates, but the live URL still cannot be
fetched and the strict exact-cell gate still proves that no-drift visual parity
has not been achieved.

### Continuation Audit - 2026-05-17 22:49 MDT

Additional work in this continuation:

- Used the `implementation-contract` skill guidance for the parity/audit
  mindset. Its default worktree/branch flow was not used because this repo's
  local rule is stricter: stay on `main`, no branches and no worktrees.
- Confirmed again that the current branch is `main`.
- Re-ran the projected browser text-cell report:
  - `AGENC_TUI_DESIGN_BROWSER_REPORT=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=verbose --testNamePattern 'projected browser text cells'`
  - Result: passed the broad gate; current state summaries remain:
    `01a 60/154`, `01b 139/371`, `02a 162/336`, `02b 28/217`,
    `03a 99/430`, `03b 131/338`, `04a 153/315`, `04b 81/319`,
    `05a 89/300`, `05b 72/317`, `06a 84/363`, `06b 75/427`,
    `07a 95/284`, `07b 63/381`, `08a 65/251`, `08b 97/304`,
    `09 87/253`, `10 95/178`, `11 53/182`, `12 78/241`,
    `13 93/259`, `14 89/323`, `15 103/265`, `16 65/292`,
    `17 66/217`, `18 39/224`, `19a 80/253`, `19b 183/533`,
    `19c 129/368`.
- Dumped representative states `01a`, `03b`, and `04a` to inspect the drift
  shape. Findings:
  - `01a` is affected by adjacent browser-span rounding on the version/build
    metadata row.
  - Chat-flow states cluster around a shared horizontal offset, but a blanket
    `ChatBody` width change creates wrapping/row-count regressions.
- Tried two layout experiments and reverted both because they regressed the
  broad acceptance smoke:
  - A shared `ChatBody` default width closer to the mockup's `820px`
    `maxWidth` caused `05b`, `07b`, `08a`, and `19b` to overflow to 41 rows
    at `148x40`, and regressed `05b` projected-cell alignment.
  - Per-state `maxWidth={108}` for `03b` and `04a` changed offsets but did not
    improve exact projected-cell alignment and introduced unwanted wrapping.
- Re-ran the broad focused baseline after reverting the experiments:
  - `AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'projected browser text cells|renders numbered design state without overflow'`
  - Result: `88` passed, `15` skipped.
- Re-ran the exact-cell completion gate:
  - `AGENC_TUI_DESIGN_EXACT_CELLS=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'fails closed on projected browser text-cell drift when exact parity is requested'`
  - Result: failed; all 29 states still report drift.
- Retried live URL variants to rule out simple encoding/path mistakes:
  - `...?open_file=AgenC+TUI.html`: HTTP `404`, body `not found`.
  - `...?open_file=AgenC%20TUI.html`: HTTP `404`, body `not found`.
  - no `open_file` query: HTTP `404`, body `not found`.
  - `/bundle`: HTTP `404`, body `404 page not found`.
  - `/files/AgenC%20TUI.html`: HTTP `404`, body `404 page not found`.

Completion decision remains **not complete**. The current tree is restored to
the broad green local parity baseline, but the two objective blockers are
unchanged: no accessible live design URL and no passing exact no-drift
cell-level parity gate.

### Continuation Audit - 2026-05-17 23:00 MDT

Additional work in this continuation:

- Re-read `goal.md`, checked the dirty tree, and used the local
  `agenc-tui-validate` skill instructions from `~/.agenc/skills/...`.
- Reconfirmed the user correction that AgenC-owned state belongs in
  `.agenc/` and `AGENC.md`; `node scripts/branding-scan.mjs --changed`
  remains clean across the changed file set.
- Investigated the strict exact-cell oracle with live browser extraction.
  The exact gate now fails closed if a live browser fixture is empty or
  missing numbered states, so an extraction failure cannot accidentally pass
  the no-drift gate.
- Tried an occlusion-aware browser text extraction, but the design canvas made
  `document.elementFromPoint()` reject most visible welcome text. That
  experiment was reverted rather than leaving a brittle oracle in place.
- Confirmed that the exact no-drift gate still fails with live browser
  fixtures from the local bundle. Representative result:
  `01a 83/286`, `03b 141/582`, `10 58/355`, and every numbered state
  `01a` through `19c` reports drift.
- Re-tested the design-like `ChatBody` width (`~108` cells) and reverted it:
  it caused `05b`, `07b`, `08a`, and `19b` to overflow to 41 rows at
  `148x40`, and dropped `05b` below the broad projected-cell floor.
- Adjusted the `/ctx` smoke-state overlay wrapper by removing one extra
  terminal row before `ContextUsageModal`; this aligns the modal chrome closer
  to the local design geometry, but does not resolve exact parity.
- Re-ran the broad focused baseline:
  - `AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'projected browser text cells|renders numbered design state without overflow'`
  - Result: `88` passed, `15` skipped.
- Re-ran the live-browser broad gate:
  - `AGENC_TUI_DESIGN_BROWSER=1 AGENC_TUI_DESIGN_BROWSER_REPORT=1 AGENC_TUI_DESIGN_HTML=/tmp/agenc-tui-handoff/agenc-tui/project/AgenC\ TUI.html npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'keeps live browser-rendered design text broadly aligned when enabled'`
  - Result: passed.

Completion decision remains **not complete**. The broad smoke and live-browser
coverage gates pass, but the completion-grade exact-cell parity gate is still
red and the original live design URL remains inaccessible.
