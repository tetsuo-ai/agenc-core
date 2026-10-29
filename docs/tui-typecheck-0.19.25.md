# TUI typecheck investigation for 0.19.25

The TUI project now selects all 442 TUI TypeScript source/declaration files.
It still fails with 305 diagnostics across 65 files. No source errors were fixed,
and no required gate was changed: the job permits source fixes only below 40
errors and permits gate integration only after this project passes.

## Config change

`runtime/tsconfig.tui.json` extends `./tsconfig.json`. Its original
`include: ["src/tui/**/*"]` resolves correctly relative to `runtime/`, but it
inherits the base config's entire `exclude` array, including `src/tui/**/*`
and individual TUI paths. The result was zero root input files and TS18003.
`rootDir: "./src"` does not select inputs. The `src/*` and `bun:bundle` path
aliases already resolve correctly to `./src/*` and `./src/build/feature.ts`;
neither the aliases nor the extends path needed changing.

The child config now overrides `exclude` with only dependencies, build output,
and test-file exclusions. Its include list also adds `src/**/*.d.ts` so existing
shared declarations for Markdown, runtime globals, optional modules, and the SDK
are available. Merely overriding exclude produced 400 errors; including those
existing declarations reduces the final count to 305. Compiler options and
runtime source files are unchanged. Existing JavaScript files retain the base
config's default unchecked-JavaScript behavior.

## Commands and results

All compiler commands ran with:

```sh
export PATH=/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.12.1/bin:$PATH
cd runtime
```

`npx --no-install tsc --noEmit -p tsconfig.tui.json` failed before launching tsc:
`EBADDEVENGINES`, installed npm 11.20.0 versus required npm 11.17.0.
The installed compiler was therefore invoked directly without changing or
installing dependencies:

```sh
node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.tui.json
```

Before (exit 2; the diagnostic's long exclude list is abbreviated here):

```text
error TS18003: No inputs were found in config file '.../runtime/tsconfig.tui.json'.
Specified 'include' paths were '["src/tui/**/*"]' and 'exclude' paths were '[...,"src/tui/**/*"]'.
Root input files: 0
Errors: 1 (configuration diagnostic)
```

After (exit 2; first diagnostic shown, all per-file counts below):

```text
src/tools/BashTool/prompt.ts(175,28): error TS2345: Argument of type 'string' is not assignable to parameter of type 'never'.
Root input files: 452 (442 TUI files plus 10 shared declaration files)
Errors: 305 in 65 files
Configuration diagnostics: 0
```

File counts were measured using TypeScript's config parser. An independent
recursive enumeration of `.ts`/`.tsx` files under `runtime/src/tui`, with the
same test exclusions, confirmed zero missing TUI inputs.

The required baseline checks ran successfully using the same direct compiler:

```sh
node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.test-support.json
```

Both passed with no diagnostics (exit 0). There are no baseline errors to report
against local `origin/main`: HEAD initially equaled that ref at
`7a772dac1d8b04e96e98b4946db7d82ea1b62723`, and neither baseline config nor any
source file changed. This differs from the job's stated `01ea2915`; no branch
reset or fetch was performed.

`git diff --check` passed. No Vitest tests were run: this changes only compiler
input selection and documentation, which were checked directly with TypeScript.
No runtime behavior changed, so there is no behavioral fail/pass test claim.

## Gate locations and missing integration

The following remain unchanged because the TUI check fails:

- Root `package.json`: `typecheck` delegates to the runtime workspace;
  `validate:runtime` also invokes that workspace's typecheck.
- `runtime/package.json`: `typecheck` runs `tsc --noEmit` then
  `typecheck:test-support`; `validate:required` invokes `typecheck`.
  A passing TUI check must be appended here.
- `scripts/run-fast-checks.mjs` and `scripts/release-state.mjs` run
  `npm run typecheck`, so they inherit the package-script gate.
- `runtime/scripts/run-hermetic-test-boundary.mjs`: `HERMETIC_SUITE_COMMAND`
  invokes the runtime and test-support compilers directly. This needs a separate
  `node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.tui.json` step
  after the TUI errors are resolved.
- `scripts/required-gate-contract.mjs` inventories the base, bundle, and
  test-support configs but not the TUI config. Add the TUI config to that
  inventory and its corresponding contract expectations when enabling the gate.
- `docs/ci-required-gates.md` describes release/required gate 5 and its two
  compiler passes; update that description when enabling the third pass.
  `docs/ARCHITECTURE.md` and
  `docs/design/daemon-session-control-plane-audit.md` use `npm run typecheck`
  in their command batches, so those commands inherit the package-script change.
  The historical `docs/core-publication-validation-2026-09-07.md` records
  direct runtime and test-support compiler commands. There is no separately
  named 0.19.25 release-batch document in this checkout.
- `.github/workflows/platform-tests.yml` also invokes `npm run typecheck`.

Excluded files can still enter the baseline program through imports; the
previous base exclusion was not a guarantee that every TUI file escaped all
checking. The dedicated config now covers the entire TUI TypeScript input set.

## Remaining diagnostics per file

Paths are relative to `runtime/`. These are diagnostic counts, not counts of
unique root causes. They include imported non-TUI source dependencies.

| File | Errors |
| --- | ---: |
| `src/tools/BashTool/prompt.ts` | 3 |
| `src/tui/completion-pipeline-watcher.ts` | 1 |
| `src/tui/components/App.tsx` | 20 |
| `src/tui/components/AutoModeOptInDialog.tsx` | 2 |
| `src/tui/components/BashModeProgress.tsx` | 3 |
| `src/tui/components/DiagnosticsDisplay.tsx` | 5 |
| `src/tui/components/ExitFlow.tsx` | 1 |
| `src/tui/components/FullscreenLayout.tsx` | 7 |
| `src/tui/components/GlobalSearchDialog.tsx` | 27 |
| `src/tui/components/MessageSelector.tsx` | 6 |
| `src/tui/components/PasteConfirmDialog.tsx` | 2 |
| `src/tui/components/PromptInput/PromptInput.tsx` | 7 |
| `src/tui/components/PromptInput/PromptInputFooter.tsx` | 1 |
| `src/tui/components/PromptInput/PromptInputFooterLeftSide.tsx` | 1 |
| `src/tui/components/PromptInput/useSwarmBanner.ts` | 1 |
| `src/tui/components/QuickOpenDialog.tsx` | 15 |
| `src/tui/components/ScrollKeybindingHandler.tsx` | 2 |
| `src/tui/components/ThinkingToggle.tsx` | 6 |
| `src/tui/components/WorktreeExitDialog.tsx` | 2 |
| `src/tui/components/compact/CompactSummary.tsx` | 3 |
| `src/tui/components/design-system/FuzzyPicker.tsx` | 7 |
| `src/tui/components/tasks/BackgroundTaskStatus.tsx` | 1 |
| `src/tui/components/teams/TeamsDialog.tsx` | 5 |
| `src/tui/hooks/fileSuggestions.ts` | 4 |
| `src/tui/hooks/notifs/useMcpConnectivityStatus.tsx` | 2 |
| `src/tui/hooks/unifiedSuggestions.ts` | 1 |
| `src/tui/hooks/useCancelRequest.ts` | 6 |
| `src/tui/hooks/useCopyOnSelect.ts` | 1 |
| `src/tui/hooks/useGlobalKeybindings.tsx` | 4 |
| `src/tui/hooks/useHistorySearch.ts` | 2 |
| `src/tui/hooks/useIdeAtMentioned.ts` | 3 |
| `src/tui/hooks/usePrStatus.ts` | 5 |
| `src/tui/hooks/useSearchInput.ts` | 1 |
| `src/tui/hooks/useTypeahead.tsx` | 5 |
| `src/tui/input/dollar-skill-command.ts` | 9 |
| `src/tui/input/processBashCommand.tsx` | 4 |
| `src/tui/main.tsx` | 1 |
| `src/tui/message-renderers/AdvisorMessage.tsx` | 3 |
| `src/tui/message-renderers/AssistantTextMessage.tsx` | 6 |
| `src/tui/message-renderers/AssistantToolUseMessage.tsx` | 8 |
| `src/tui/message-renderers/AttachmentMessage.tsx` | 24 |
| `src/tui/message-renderers/CollapsedReadSearchContent.tsx` | 9 |
| `src/tui/message-renderers/GroupedToolUseContent.tsx` | 1 |
| `src/tui/message-renderers/HighlightedThinkingText.tsx` | 2 |
| `src/tui/message-renderers/HookProgressMessage.tsx` | 1 |
| `src/tui/message-renderers/PlanApprovalMessage.tsx` | 2 |
| `src/tui/message-renderers/SystemTextMessage.tsx` | 10 |
| `src/tui/message-renderers/UserBashOutputMessage.tsx` | 2 |
| `src/tui/message-renderers/UserLocalCommandOutputMessage.tsx` | 2 |
| `src/tui/message-renderers/UserPromptMessage.tsx` | 4 |
| `src/tui/message-renderers/UserTeammateMessage.tsx` | 4 |
| `src/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.tsx` | 6 |
| `src/tui/message-renderers/UserToolResultMessage/UserToolRejectMessage.tsx` | 4 |
| `src/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.tsx` | 6 |
| `src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.tsx` | 4 |
| `src/tui/message-renderers/UserToolResultMessage/utils.tsx` | 2 |
| `src/tui/message-renderers/teamMemCollapsed.tsx` | 7 |
| `src/tui/message-renderers/teamMemSaved.ts` | 1 |
| `src/tui/startup/StatusLine.tsx` | 2 |
| `src/tui/startup/statusNoticeDefinitions.tsx` | 1 |
| `src/tui/submission-terminal.ts` | 1 |
| `src/utils/agencInChrome/setupPortable.ts` | 5 |
| `src/utils/autoUpdater.ts` | 4 |
| `src/utils/env.ts` | 6 |
| `src/utils/user.ts` | 2 |
| **Total (65 files)** | **305** |

## Other observations left unchanged

The npm version mismatch prevents the prescribed npx wrapper from reaching the
compiler. The newly exposed errors include an `info` theme key absent from
`Theme`, a `subscribeToContextChange` method absent from
`PermissionModeRegistryLike`, and incompatible approval-response types in
`src/tui/components/App.tsx`. These need separate investigation; the diagnostics
alone do not establish their runtime impact.
