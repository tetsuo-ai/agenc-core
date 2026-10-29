# TUI typecheck investigation for 0.19.25

**Completed triage:** 305 → 19 diagnostics; 286 original type-only errors fixed,
19 diagnostics retained for nine runtime bugs. See [Real bugs](#real-bugs) and
[Completed triage](#completed-triage-2026-10-30) for the ledger and validation.

This initial investigation records commit `2d8d9e731`; the completed triage below supersedes its unresolved-error status.

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


## Completed triage (2026-10-30)

Starting point: `2d8d9e731`. The initial 305 diagnostics classify as **286 B
(type-only) and 19 A (runtime defects)**. After the fixes, **19 diagnostics in
five files remain**, all A, representing the nine issues below. No compiler
gate, include/exclude setting, runtime branch, daemon response, or permission
policy was changed. All 442 TUI source/declaration files remain selected.

Resolving imports temporarily exposed 14 additional diagnostics. All were B:
one extra Bash progress option, eight false `never` errors after the legacy
`any` message predicate, one search-focus setter, one PR-result assignment,
one redundant Bash-mode comparison, and two overly narrow tool-error content
parameters. These are fixed too. Their locations are recorded separately below.

The changes preserve runtime logic. An independent TypeScript transpilation
comparison of all 70 changed production files found identical JavaScript ASTs
when normalizing equivalent relative ESM `.js` specifiers, parentheses, and
object-property shorthand. Every normalized import names the same existing
source module. Runtime `require()` strings remain unchanged. No `any`,
`@ts-ignore`, `@ts-expect-error`, or compiler exclusion was added.

### Classification ledger

Every entry below identifies an original diagnostic by `line:column/code` at
`2d8d9e731`; positions are not deduplicated. `A/Rn` points to the runtime defect
below. `B/import` means NodeNext import resolution (including erased type
imports); other B entries use the per-file explanation in the change inventory.
There are exactly 305 entries, including all three diagnostics on line 134 of
AttachmentMessage. Paths are relative to `runtime/`.

| File | Original diagnostic locations and classification |
| --- | --- |
| `src/tools/BashTool/prompt.ts` | `175:28/TS2345` B; `178:28/TS2345` B; `182:7/TS2345` B |
| `src/tui/completion-pipeline-watcher.ts` | `84:5/TS2322` B |
| `src/tui/components/App.tsx` | `331:7/TS2322` A/R1; `866:9/TS2345` B; `1254:63/TS2345` B; `1259:7/TS2322` B; `1279:44/TS2339` B; `1324:7/TS2322` A/R2; `1648:52/TS2551` B; `2620:45/TS2345` B; `2861:54/TS2345` A/R3; `3236:9/TS2328` B; `3237:9/TS2322` B; `3687:13/TS2322` B; `3759:15/TS2322` A/R4; `3760:15/TS2322` A/R4; `3761:15/TS2741` A/R4; `3968:26/TS2345` B; `4237:54/TS2339` B; `4280:40/TS2339` B; `4285:25/TS2339` B; `4839:13/TS2322` A/R3 |
| `src/tui/components/AutoModeOptInDialog.tsx` | `6:24/TS2835` B/import; `7:24/TS2835` B/import |
| `src/tui/components/BashModeProgress.tsx` | `5:26/TS2835` B/import; `6:36/TS2835` B/import; `9:38/TS2835` B/import |
| `src/tui/components/DiagnosticsDisplay.tsx` | `5:43/TS2835` B/import; `6:33/TS2835` B/import; `7:24/TS2835` B/import; `8:31/TS2835` B/import; `9:33/TS2835` B/import |
| `src/tui/components/ExitFlow.tsx` | `6:36/TS2835` B/import |
| `src/tui/components/FullscreenLayout.tsx` | `8:30/TS2835` B/import; `10:33/TS2835` B/import; `16:30/TS2835` B/import; `29:35/TS2835` B/import; `468:67/TS2339` B; `468:95/TS2339` B; `768:74/TS2322` B |
| `src/tui/components/GlobalSearchDialog.tsx` | `5:36/TS2835` B/import; `6:33/TS2835` B/import; `15:24/TS2835` B/import; `16:42/TS2835` B/import; `17:53/TS2835` B/import; `18:32/TS2835` B/import; `19:33/TS2835` B/import; `20:31/TS2835` B/import; `21:26/TS2835` B/import; `23:29/TS2835` B/import; `24:30/TS2835` B/import; `114:25/TS2339` B; `133:54/TS2339` B; `134:41/TS2339` B; `140:11/TS2353` B; `140:25/TS2339` B; `141:25/TS2339` B; `150:11/TS2353` B; `150:25/TS2339` B; `151:25/TS2339` B; `173:25/TS2339` B; `182:7/TS2322` B; `191:7/TS2322` B; `271:27/TS2339` B; `271:48/TS18047` B; `271:163/TS18047` B; `312:19/TS2345` B |
| `src/tui/components/MessageSelector.tsx` | `13:68/TS2835` B/import; `17:52/TS2835` B/import; `36:37/TS2835` B/import; `37:23/TS2835` B/import; `38:49/TS2835` B/import; `39:28/TS2835` B/import |
| `src/tui/components/PasteConfirmDialog.tsx` | `48:13/TS2322` A/R5; `61:28/TS2322` A/R5 |
| `src/tui/components/PromptInput/PromptInput.tsx` | `242:18/TS2339` B; `296:22/TS2345` B; `1494:24/TS2345` B; `1733:15/TS2741` B; `1878:90/TS2345` B; `2959:24/TS2345` B; `3165:26/TS2345` B |
| `src/tui/components/PromptInput/PromptInputFooter.tsx` | `142:23/TS2345` B |
| `src/tui/components/PromptInput/PromptInputFooterLeftSide.tsx` | `86:29/TS2345` B |
| `src/tui/components/PromptInput/useSwarmBanner.ts` | `124:7/TS2322` B |
| `src/tui/components/QuickOpenDialog.tsx` | `5:36/TS2835` B/import; `6:41/TS2835` B/import; `7:33/TS2835` B/import; `10:24/TS2835` B/import; `11:42/TS2835` B/import; `12:53/TS2835` B/import; `13:32/TS2835` B/import; `14:26/TS2835` B/import; `15:33/TS2835` B/import; `20:94/TS2835` B/import; `21:30/TS2835` B/import; `147:11/TS2353` B; `156:11/TS2353` B; `232:27/TS2339` B; `232:113/TS18047` B |
| `src/tui/components/ScrollKeybindingHandler.tsx` | `2:34/TS2835` B/import; `3:54/TS2835` B/import |
| `src/tui/components/ThinkingToggle.tsx` | `8:42/TS2835` B/import; `9:24/TS2835` B/import; `10:24/TS2835` B/import; `11:38/TS2835` B/import; `12:22/TS2835` B/import; `105:32/TS2345` B |
| `src/tui/components/WorktreeExitDialog.tsx` | `9:24/TS2835` B/import; `10:24/TS2835` B/import |
| `src/tui/components/compact/CompactSummary.tsx` | `6:44/TS2835` B/import; `8:42/TS2835` B/import; `9:33/TS2835` B/import |
| `src/tui/components/design-system/FuzzyPicker.tsx` | `4:32/TS2835` B/import; `5:33/TS2835` B/import; `10:27/TS2835` B/import; `11:24/TS2835` B/import; `12:38/TS2835` B/import; `13:26/TS2835` B/import; `14:22/TS2835` B/import |
| `src/tui/components/tasks/BackgroundTaskStatus.tsx` | `15:38/TS2835` B/import |
| `src/tui/components/teams/TeamsDialog.tsx` | `6:36/TS2835` B/import; `27:24/TS2835` B/import; `28:24/TS2835` B/import; `507:24/TS2345` B; `510:24/TS2345` B |
| `src/tui/hooks/fileSuggestions.ts` | `14:8/TS2835` B/import; `16:49/TS2834` B/import; `22:37/TS2835` B/import; `34:30/TS2835` B/import |
| `src/tui/hooks/notifs/useMcpConnectivityStatus.tsx` | `6:33/TS2835` B/import; `8:42/TS2835` B/import |
| `src/tui/hooks/unifiedSuggestions.ts` | `109:11/TS2322` B |
| `src/tui/hooks/useCancelRequest.ts` | `15:34/TS2835` B/import; `16:41/TS2835` B/import; `17:33/TS2835` B/import; `25:34/TS2835` B/import; `29:8/TS2835` B/import; `34:8/TS2835` B/import |
| `src/tui/hooks/useCopyOnSelect.ts` | `2:26/TS2835` B/import |
| `src/tui/hooks/useGlobalKeybindings.tsx` | `55:91/TS2835` B/import; `56:81/TS18046` B; `100:71/TS2835` B/import; `147:71/TS2835` B/import |
| `src/tui/hooks/useHistorySearch.ts` | `13:38/TS2835` B/import; `14:35/TS2835` B/import |
| `src/tui/hooks/useIdeAtMentioned.ts` | `8:8/TS2835` B/import; `9:39/TS2835` B/import; `10:28/TS2835` B/import |
| `src/tui/hooks/usePrStatus.ts` | `3:40/TS2835` B/import; `4:51/TS2835` B/import; `72:35/TS2339` B; `73:40/TS2339` B; `79:24/TS2339` B |
| `src/tui/hooks/useSearchInput.ts` | `16:33/TS2835` B/import |
| `src/tui/hooks/useTypeahead.tsx` | `18:8/TS2835` B/import; `33:8/TS2835` B/import; `34:38/TS2835` B/import; `73:8/TS2835` B/import; `74:44/TS2835` B/import |
| `src/tui/input/dollar-skill-command.ts` | `74:28/TS2722` B; `84:9/TS18046` B; `88:29/TS2339` B; `89:18/TS2339` B; `103:15/TS2339` B; `107:15/TS2339` B; `109:15/TS2339` B; `115:5/TS2322` B; `121:5/TS2322` B |
| `src/tui/input/processBashCommand.tsx` | `110:25/TS2345` B; `117:19/TS18046` B; `118:19/TS18046` B; `128:7/TS2698` B |
| `src/tui/main.tsx` | `237:9/TS2322` B |
| `src/tui/message-renderers/AdvisorMessage.tsx` | `4:31/TS2835` B/import; `5:33/TS2835` B/import; `6:31/TS2835` B/import |
| `src/tui/message-renderers/AssistantTextMessage.tsx` | `8:59/TS2835` B/import; `11:39/TS2835` B/import; `12:31/TS2835` B/import; `13:35/TS2835` B/import; `16:33/TS2835` B/import; `17:47/TS2835` B/import |
| `src/tui/message-renderers/AssistantToolUseMessage.tsx` | `9:78/TS2835` B/import; `10:38/TS2835` B/import; `15:33/TS2835` B/import; `16:38/TS2835` B/import; `17:34/TS2835` B/import; `19:37/TS2835` B/import; `76:5/TS2345` B; `586:166/TS2322` B |
| `src/tui/message-renderers/AttachmentMessage.tsx` | `11:33/TS2835` B/import; `13:33/TS2835` B/import; `14:36/TS2835` B/import; `21:29/TS2835` B/import; `23:76/TS2835` B/import; `25:40/TS2835` B/import; `27:31/TS2835` B/import; `28:26/TS2835` B/import; `29:30/TS2835` B/import; `31:38/TS2835` B/import; `121:11/TS18046` A/R6; `124:14/TS18046` A/R6; `127:11/TS18046` A/R6; `134:12/TS18046` A/R6; `134:52/TS18046` A/R6; `134:144/TS18046` A/R6; `337:23/TS1360` A/R7; `427:13/TS2339` B; `439:21/TS2339` B; `440:26/TS2339` B; `441:17/TS2339` B; `456:44/TS2339` B; `457:71/TS2339` B; `459:17/TS2339` B |
| `src/tui/message-renderers/CollapsedReadSearchContent.tsx` | `4:35/TS2835` B/import; `7:44/TS2835` B/import; `8:39/TS2835` B/import; `9:75/TS2835` B/import; `16:31/TS2835` B/import; `17:38/TS2835` B/import; `18:25/TS2835` B/import; `19:31/TS2835` B/import; `21:41/TS2835` B/import |
| `src/tui/message-renderers/GroupedToolUseContent.tsx` | `2:72/TS2835` B/import |
| `src/tui/message-renderers/HighlightedThinkingText.tsx` | `5:34/TS2835` B/import; `13:47/TS2835` B/import |
| `src/tui/message-renderers/HookProgressMessage.tsx` | `6:33/TS2835` B/import |
| `src/tui/message-renderers/PlanApprovalMessage.tsx` | `8:43/TS2835` B/import; `9:42/TS2835` B/import |
| `src/tui/message-renderers/SystemTextMessage.tsx` | `10:33/TS2835` B/import; `11:30/TS2835` B/import; `13:37/TS2835` B/import; `16:33/TS2835` B/import; `17:146/TS2835` B/import; `22:24/TS2835` B/import; `23:31/TS2835` B/import; `25:50/TS2835` B/import; `26:30/TS2835` B/import; `27:38/TS2835` B/import |
| `src/tui/message-renderers/UserBashOutputMessage.tsx` | `2:35/TS2835` B/import; `4:28/TS2835` B/import |
| `src/tui/message-renderers/UserLocalCommandOutputMessage.tsx` | `8:26/TS2835` B/import; `9:33/TS2835` B/import |
| `src/tui/message-renderers/UserPromptMessage.tsx` | `3:50/TS2835` B/import; `7:29/TS2835` B/import; `12:47/TS2835` B/import; `13:41/TS2835` B/import |
| `src/tui/message-renderers/UserTeammateMessage.tsx` | `10:33/TS2835` B/import; `11:46/TS2835` B/import; `12:42/TS2835` B/import; `13:48/TS2835` B/import |
| `src/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.tsx` | `5:67/TS2835` B/import; `6:38/TS2835` B/import; `10:45/TS2835` B/import; `11:35/TS2835` B/import; `12:33/TS2835` B/import; `14:42/TS2835` B/import |
| `src/tui/message-renderers/UserToolResultMessage/UserToolRejectMessage.tsx` | `4:33/TS2835` B/import; `6:67/TS2835` B/import; `7:38/TS2835` B/import; `9:48/TS2835` B/import |
| `src/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.tsx` | `3:28/TS2835` B/import; `4:61/TS2835` B/import; `9:38/TS2835` B/import; `10:39/TS2835` B/import; `11:40/TS2835` B/import; `12:66/TS2835` B/import |
| `src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.tsx` | `6:67/TS2835` B/import; `7:61/TS2835` B/import; `10:33/TS2835` B/import; `11:37/TS2835` B/import |
| `src/tui/message-renderers/UserToolResultMessage/utils.tsx` | `3:55/TS2835` B/import; `5:42/TS2835` B/import |
| `src/tui/message-renderers/teamMemCollapsed.tsx` | `4:47/TS2835` B/import; `47:20/TS2345` B; `68:18/TS2345` B; `81:20/TS2345` B; `92:18/TS2345` B; `105:20/TS2345` B; `126:18/TS2345` B |
| `src/tui/message-renderers/teamMemSaved.ts` | `1:47/TS2835` B/import |
| `src/tui/startup/StatusLine.tsx` | `17:45/TS2307` B; `252:9/TS2322` B |
| `src/tui/startup/statusNoticeDefinitions.tsx` | `182:46/TS2339` A/R8 |
| `src/tui/submission-terminal.ts` | `31:28/TS2550` B |
| `src/utils/agencInChrome/setupPortable.ts` | `161:7/TS2322` B; `171:30/TS2339` B; `173:24/TS2339` B; `173:52/TS2339` B; `175:27/TS2339` B |
| `src/utils/autoUpdater.ts` | `278:5/TS2322` B; `285:5/TS2322` B; `291:7/TS18047` B; `295:10/TS18047` B |
| `src/utils/env.ts` | `34:61/TS2345` B; `35:62/TS2345` B; `36:62/TS2345` B; `44:54/TS2345` B; `45:55/TS2345` B; `46:55/TS2345` B |
| `src/utils/user.ts` | `88:38/TS2339` A/R9; `90:18/TS2339` A/R9 |

### Diagnostics exposed by import resolution

These are additional B diagnostics at the original source positions; they do
not inflate the original 305 count.

| File | Locations | Explanation |
| --- | --- | --- |
| `src/tui/components/BashModeProgress.tsx` | 32:7 | The options object legitimately carries an ignored fullscreen flag; type the full object. |
| `src/tui/components/GlobalSearchDialog.tsx` | 281:214 | Focus can hold a match, not just undefined. |
| `src/tui/components/MessageSelector.tsx` | 856:13, 857:13, 858:13, 859:13, 859:36, 862:13, 863:27, 872:13 | The imported compatibility predicate narrows to `any`, so its false branch incorrectly becomes never; retain its boolean result without that narrowing. |
| `src/tui/hooks/usePrStatus.ts` | 64:9 | The awaited result can hold PrStatus or null. |
| `src/tui/hooks/useTypeahead.tsx` | 2037:11 | The earlier Bash return makes this defensive comparison redundant; widen only the expression's type and retain the comparison. |
| `src/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.tsx` | 60:39, 66:40 | Error renderers accept the AgenC transcript content union, including non-string content that produces a generic error label. |

## Real bugs

All nine issues remain unchanged. Locations below refer to the final source;
the ledger above preserves their original locations. Triggers are derived from
producer/consumer code inspection, not live daemon or provider experiments.

| ID | File:line | User impact and trigger | Smallest fix |
| --- | --- | --- | --- |
| R1 | `src/tui/components/App.tsx:329` | A successful recovered-submission notification requests `info`, which is absent from Theme. Trigger a `message_submission_recovered` event with a successful result: its intended informational color is lost. | Use an existing informational theme key such as `text` or `accent`, matching the intended visual treatment. |
| R2 | `src/tui/components/App.tsx:1322` | A user-input question may omit `options`, but AskUserQuestionOverlay immediately reads `question.options.length`. A free-text-only request crashes the picker instead of accepting an answer. | Normalize omitted options to an empty array before passing the question to the picker; retain the free-text choice. |
| R3 | `src/tui/components/App.tsx:2859` and `:4837` | First-run BYOK onboarding receives a general AuthBackend. RemoteAuthBackend lacks `saveByokKey`; selecting BYOK with such a backend reaches a missing-method call in onboarding. LocalAuthBackend does implement it. | Supply an actual BYOK-capable backend/adapter, or narrow capability and route unsupported backends to the existing key-save path. Do not cast AuthBackend to the BYOK interface. |
| R4 | `src/tui/components/App.tsx:3757`, `:3758`, `:3759` | Submit `$skill`: the queued input array contains raw XML metadata as a string and `{content: blocks}` without a role. Neither is an LLMMessage; message admission/provider serialization receives malformed input, so skill context is rejected or lost. | Wrap both entries as role-tagged user messages, converting SDK blocks to the canonical LLM content shape where necessary. |
| R5 | `src/tui/components/PasteConfirmDialog.tsx:48` and `:61` | Open shell-paste confirmation. Named `yellow` and `green` are neither Theme keys nor accepted raw colors in resolveThemedColor; the warning/confirmation emphasis is uncolored. | Use `warning` and `success`. |
| R6 | `src/tui/message-renderers/AttachmentMessage.tsx:121`, `:124`, `:127`, `:134` (three diagnostics at 134) | A fresh `@file` attachment is produced using CanonicalFileReadTool data (`content`/`metadata`), while the renderer assumes the legacy `{type, file}` payload. Rendering a normal canonical text-file attachment reaches `content.file.originalSize` with no `file` and throws. Cached already-read attachments still use the legacy shape. | Normalize canonical read results at the attachment boundary or add a renderer branch for canonical metadata, retaining legacy support for cached/persisted attachments. |
| R7 | `src/tui/message-renderers/AttachmentMessage.tsx:337` | `bagel_console` is in Attachment but has neither a switch case nor a null-rendering classification. If a persisted/imported attachment with that discriminator is replayed, it renders nothing while still counting toward the visible-message budget. No current producer was found, so this is a latent replay/contract defect. | Deliberately retire/filter this discriminator or add its intended console-summary renderer; do not merely weaken the exhaustiveness assertion. |
| R8 | `src/tui/startup/statusNoticeDefinitions.tsx:182` | With JetBrains and `ideConnector.autoInstallExtension: false`, the notice still reads retired runtime-state field `autoInstallIdeExtension`, falls back to true, and can show the unwanted install notice. | Read the canonical configuration's `ideConnector.autoInstallExtension` through the notice context. |
| R9 | `src/utils/user.ts:88` and `:90` | Request account metadata after migration with a subscription: `agencCodeFirstTokenDate` has been retired from GlobalRuntimeState, so the old lookup cannot populate `firstTokenTime`. Consumers lose that account-age metadata. | Obtain the timestamp from a supported account/auth authority if available, or deliberately retire the metadata field and this dead lookup. Do not reintroduce the retired state key. |

### Other observations left unchanged

- `shouldPreserveEditorRecoveryOnTeardown` is passed by main but is not consumed
  by App. The optional prop is now declared; this makes no claim that editor
  recovery preservation is implemented. That wiring deserves a separate review.
- Dollar-skill loading returns `model`, `effort`, and `allowedTools`, but this
  submission path only consumes metadata/blocks. Whether those overrides should
  apply is a separate behavioral question; no propagation was added.
- The old ultrareview helper reads a deliberately constant-null configuration.
  Its type is widened at the optional access; the feature remains disabled.

### Changes per production file

All changes here are B. For rows saying “import extensions”, only module
resolution spelling changed; runtime require paths were retained.

| File | Change |
| --- | --- |
| `src/commands.ts` | Declare prompt loaders and their SDK block results, optional skill root and hook metadata. |
| `src/commands/types.ts` | Use the existing nullable SetToolJSXFn for the slash-command bridge. |
| `src/services/PromptSuggestion/speculation.ts` | Make abortSpeculation generic over the caller state, preserving the full state in its spread updater. |
| `src/tools/AgentTool/agentColorManager.ts` | Infer the exact theme-key union already returned by the color map. |
| `src/tools/BashTool/prompt.ts` | Annotate the restrictions string array. |
| `src/tools/Tool.ts` | Accept AgenC transcript content in the error-renderer contract. |
| `src/tools/canonicalToolSurface.ts` | Declare the already-ignored permission callback and parent-message arguments optional on canonical tools; admission still runs unchanged. |
| `src/tui/completion-pipeline-watcher.ts` | Contextually type the injected/default scheduler as ScheduleTimeout. |
| `src/tui/components/App.tsx` | Type elicitation state/ref; preserve the findIndex-established MCP URL narrowing; remove two unused required submission fields; retain the tui_mount discriminant; annotate the legacy unknown updater boundary and membership argument. |
| `src/tui/components/AutoModeOptInDialog.tsx` | Import extensions. |
| `src/tui/components/BashModeProgress.tsx` | Import extensions and type the existing progress options including fullscreen. |
| `src/tui/components/DiagnosticsDisplay.tsx` | Import extensions. |
| `src/tui/components/ExitFlow.tsx` | Import extensions. |
| `src/tui/components/FallbackToolUseErrorMessage.tsx` | Use the AgenC transcript result-content type. |
| `src/tui/components/FullscreenLayout.tsx` | Import extensions and annotate StickyPrompt state. |
| `src/tui/components/GlobalSearchDialog.tsx` | Import extensions; type focus, preview, abort/timer refs, parsed matches, and preview callback argument. |
| `src/tui/components/MessageSelector.tsx` | Import extensions; prevent the compatibility any predicate from narrowing the false branch to never. |
| `src/tui/components/PromptInput/PromptInput.tsx` | Use the task-state type returned by selectors; widen the constant-null optional property access without enabling it. |
| `src/tui/components/PromptInput/PromptInputFooterLeftSide.tsx` | Declare countdown state as number or null. |
| `src/tui/components/QuickOpenDialog.tsx` | Import extensions; type preview state and its string path callback. |
| `src/tui/components/ScrollKeybindingHandler.tsx` | Import extensions. |
| `src/tui/components/ThinkingToggle.tsx` | Import extensions and nullable boolean confirmation state. |
| `src/tui/components/WorktreeExitDialog.tsx` | Import extensions. |
| `src/tui/components/compact/CompactSummary.tsx` | Import extensions. |
| `src/tui/components/design-system/FuzzyPicker.tsx` | Import extensions. |
| `src/tui/components/statusLineLayout.ts` | Admit the existing Theme.subtle key used by the Web badge. |
| `src/tui/components/tasks/BackgroundTaskStatus.tsx` | Import extensions. |
| `src/tui/components/teams/TeamsDialog.tsx` | Import extensions and string subtitle array. |
| `src/tui/context/promptOverlayContext.tsx` | Accept null when callers clear the overlay, matching the setter/context. |
| `src/tui/hooks/fileSuggestions.ts` | Import extensions and infer the hook input instead of importing a nonexistent erased type. |
| `src/tui/hooks/notifs/useMcpConnectivityStatus.tsx` | Import extensions. |
| `src/tui/hooks/useCancelRequest.ts` | Import extensions. |
| `src/tui/hooks/useCopyOnSelect.ts` | Import extensions. |
| `src/tui/hooks/useGlobalKeybindings.tsx` | Add extensions only to typeof import types; keep runtime require strings unchanged. |
| `src/tui/hooks/useHistorySearch.ts` | Import extensions. |
| `src/tui/hooks/useIdeAtMentioned.ts` | Import extensions. |
| `src/tui/hooks/usePrStatus.ts` | Import extensions and annotate the awaited nullable PR result. |
| `src/tui/hooks/useSearchInput.ts` | Import extensions. |
| `src/tui/hooks/useTypeahead.tsx` | Import extensions and retain the existing redundant mode comparison with a widened type. |
| `src/tui/input/dollar-skill-command.ts` | Return the command contract’s string effort metadata; the submission consumer does not apply it. |
| `src/tui/input/processBashCommand.tsx` | Record the existing PowerShell/result correlation in branch-local types and the matched tool/result boundary. |
| `src/tui/message-renderers/AdvisorMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/AssistantTextMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/AssistantToolUseMessage.tsx` | Import extensions; admit null pending requests; use Box’s background-color prop type. |
| `src/tui/message-renderers/AttachmentMessage.tsx` | Import extensions and type the cached task selector/result. The canonical file-content bug remains. |
| `src/tui/message-renderers/CollapsedReadSearchContent.tsx` | Import extensions. |
| `src/tui/message-renderers/GroupedToolUseContent.tsx` | Import extensions. |
| `src/tui/message-renderers/HighlightedThinkingText.tsx` | Import extensions. |
| `src/tui/message-renderers/HookProgressMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/PlanApprovalMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/SystemTextMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserBashOutputMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserLocalCommandOutputMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserPromptMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserTeammateMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserToolResultMessage/UserToolRejectMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.tsx` | Import extensions. |
| `src/tui/message-renderers/UserToolResultMessage/utils.tsx` | Import extensions. |
| `src/tui/message-renderers/teamMemCollapsed.tsx` | Import extension and ReactNode array annotation. |
| `src/tui/message-renderers/teamMemSaved.ts` | Import extensions. |
| `src/tui/session-types.ts` | Declare the existing permission-context subscription and the optional teardown flag passed by main. |
| `src/tui/startup/StatusLine.tsx` | Infer the status-command input instead of importing a nonexistent type; admit undefined command output, already supported by state. |
| `src/tui/state/AppStateStore.ts` | Reuse the service’s SpeculationState type, including the existing overlayPath and compatible context. |
| `src/tui/state/collabAgentTaskSync.ts` | Type its state-preserving updater with AppState rather than an unknown return. |
| `src/tui/submission-terminal.ts` | Reference ES2024 Promise declarations for the existing Node 26 Promise.withResolvers call. |
| `src/utils/agencInChrome/setupPortable.ts` | Annotate the readdir result array as Dirent[]. |
| `src/utils/autoUpdater.ts` | Annotate the nullable awaited process result. |
| `src/utils/env.ts` | Annotate package-manager and runtime string arrays. |

Added `runtime/tests/utils/agencInChrome/setupPortable.test.ts` because no direct
suite existed for that helper. Its two hermetic tests cover missing browsers,
profile files versus directories, numbered profiles, and non-profile folders.
Both pass against the original implementation and the annotated implementation.

### Validation

No production behavior change was intended or retained, so no behavioral
red-to-green claim is made for any A issue. Tests use the supplied hermetic
runner, Node 26.12.1, and `--maxWorkers=2`; no whole-suite command was run.

- Initial selected batch: 256 files passed, 2 failed; 1,896 tests passed,
  12 failed. All selected TUI tests passed.
- Additional dependency batch: 32 files passed, 566 tests passed, one existing
  skipped test. Fallback renderer batch: one file / six tests passed.
- The new browser-profile suite passed both tests with its source annotation
  temporarily removed, then again with the annotation restored.
- First combined after run: 280 files passed, 4 failed; 2,320 tests passed,
  14 failed, one skipped. Two new failures were due to changing require strings
  alongside type imports. Those runtime path edits were reverted.
- Final focused run: 283 files passed; 2,296 tests passed, one existing skip. The two known unrelated failing files from
  the initial wider selection were excluded from this final green rerun; their
  unchanged failures were reproduced in the combined after run.

Existing failures, not fixed:

1. `tests/managed-prompt-hermetic.test.ts`: one test creates a case-only symlink
   alias and fails with EEXIST on this case-insensitive filesystem.
2. `tests/bin/print-cli-main.test.ts`: 11 provisional-route coordination tests
   fail (three 30-second timeouts and related mock/assertion failures).

The initially requested `tests/design-hermetic-env.test.ts` is excluded by the
default Vitest configuration and was not discovered in either batch.
The one existing skip is in `tests/tools/system/signed-allowed-roots.test.ts`; it is not a new skip.

Compiler commands from `runtime/`, before and after:

```sh
export PATH=/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.12.1/bin:$PATH
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.test-support.json
```

The after attempt additionally set `npm_config_offline=true` and
`npm_config_cache="$PWD/../.tui-npm-cache"` on each npx invocation.
The prescribed npx wrapper exits 1 with EBADDEVENGINES before running either
compiler: installed npm 11.20.0 versus required 11.17.0. Dependencies were not
changed. The equivalent installed compiler commands were run directly:

```sh
node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.test-support.json
node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.tui.json
```

Base and test-support projects: **exit 0 / zero diagnostics before and after**.
No origin/main baseline compiler errors: production sources at the starting
commit match local origin/main (`7a772dac1`), verified without checkout or
network access. TUI: **exit 2, 305 diagnostics before; exit 2, 19 after**.
`git diff --check` and the emitted-runtime comparison pass.

### Exact test commands

All commands below run from `runtime/`, after the PATH export above and
`mkdir -p /private/tmp/tt/vt`. Wrapped argument lists are literal file selections.

<details>
<summary>Initial before batch</summary>

```sh
TMPDIR=/private/tmp/tt/vt node scripts/run-hermetic-vitest.mjs run \
  tests/app-server/client-env-snapshot.test.ts \
  tests/bin/agenc-main-daemon-audit.test.ts \
  tests/bin/agenc-main-recovery-operator.test.ts \
  tests/bin/agenc.user-prompt-submit.test.ts \
  tests/bin/daemon-child-main.test.ts \
  tests/bin/daemon-provisional-child-main.test.ts \
  tests/bin/print-cli-main.test.ts \
  tests/bin/prompt-stdin.test.ts \
  tests/bin/tui-trust-prompt.test.tsx \
  tests/bootstrap/node-env.test.ts \
  tests/config/env-documentation-coverage.architecture.test.ts \
  tests/config/policy-env-authority.architecture.test.ts \
  tests/contracts/no-user-visible-em-dash.test.ts \
  tests/conversation/realtime/prompt.contract.test.ts \
  tests/design-hermetic-env.test.ts \
  tests/elicitation/request-user-input.test.ts \
  tests/eval/eval-executor-literal-env.test.ts \
  tests/gaphunt3/prompts-system-prompt.test.ts \
  tests/gaphunt3/tools-WebFetchTool-prompt.test.ts \
  tests/gaphunt3/utils-hooks.test.ts \
  tests/gaphunt3/utils-sessionStorage.test.ts \
  tests/gateway/prompt-injection.test.ts \
  tests/hermetic-env.test.ts \
  tests/hooks/user-prompt-ingress.test.ts \
  tests/hooks/user-prompt-submit.test.ts \
  tests/llm-pipeline-harness-env.test.ts \
  tests/llm/providers/grok/adapter-utils.test.ts \
  tests/managed-prompt-hermetic.test.ts \
  tests/prompts/lean-system-prompt.test.ts \
  tests/prompts/light-permissions-prompt.test.ts \
  tests/prompts/permissions-prompt.test.ts \
  tests/prompts/system-prompt-authority.architecture.test.ts \
  tests/prompts/system-prompt.test.ts \
  tests/sdk-package/prompt-event-overflow.contract.test.ts \
  tests/sdk-package/prompt-event-queue.test.ts \
  tests/sdk-package/prompt-race-safety.contract.test.ts \
  tests/services/PromptSuggestion/prompt-suggestion.contract.test.ts \
  tests/session/contextual-user-message.test.ts \
  tests/session/local-user-stop-admission.test.ts \
  tests/session/prompt-cache-share.test.ts \
  tests/session/prompt-cache-state.test.ts \
  tests/session/prompt-input-byte-bound.test.ts \
  tests/session/user-stop-durability.test.ts \
  tests/session/user-stop-state.test.ts \
  tests/subprocess-env-scrub.test.ts \
  tests/tools/BashTool/utils.test.ts \
  tests/tools/ask-user-question-tui-routing.test.tsx \
  tests/tools/ask-user-question/tool.test.ts \
  tests/tools/ask-user-question/tui-tool.test.tsx \
  tests/tui-e2e-harness-env.test.ts \
  tests/tui/completion-pipeline-watcher.test.ts \
  tests/tui/components/App.completion-pipeline.test.tsx \
  tests/tui/components/App.coverage2.test.tsx \
  tests/tui/components/App.daemon-stall-watchdog.test.ts \
  tests/tui/components/App.local-agents.test.tsx \
  tests/tui/components/App.render.test.tsx \
  tests/tui/components/App.wave200-002.coverage.test.tsx \
  tests/tui/components/AutoModeOptInDialog.coverage.test.tsx \
  tests/tui/components/BashModeProgress.test.tsx \
  tests/tui/components/BashModeProgress.wave200-138.coverage.test.tsx \
  tests/tui/components/DiagnosticsDisplay.coverage.test.tsx \
  tests/tui/components/DiagnosticsDisplay.wave200-120.coverage.test.tsx \
  tests/tui/components/ExitFlow.test.tsx \
  tests/tui/components/ExitFlow.wave200-139.coverage.test.tsx \
  tests/tui/components/FullscreenLayout.coverage2.test.tsx \
  tests/tui/components/FullscreenLayout.render-branches.test.tsx \
  tests/tui/components/FullscreenLayout.session-usage.test.tsx \
  tests/tui/components/FullscreenLayout.test.tsx \
  tests/tui/components/FullscreenLayout.usage-indicators.test.tsx \
  tests/tui/components/FullscreenLayout.wave200-018.coverage.test.tsx \
  tests/tui/components/GlobalSearchDialog.layout.test.ts \
  tests/tui/components/GlobalSearchDialog.render.test.tsx \
  tests/tui/components/GlobalSearchDialog.wave200-129.coverage.test.tsx \
  tests/tui/components/MessageSelector.coverage.test.tsx \
  tests/tui/components/MessageSelector.coverage2.test.tsx \
  tests/tui/components/MessageSelector.filter.test.ts \
  tests/tui/components/MessageSelector.layout.test.ts \
  tests/tui/components/MessageSelector.render.test.tsx \
  tests/tui/components/MessageSelector.wave200-013.coverage.test.tsx \
  tests/tui/components/PasteConfirmDialog.test.tsx \
  tests/tui/components/PromptInput/PromptInput.busyPolicy.test.ts \
  tests/tui/components/PromptInput/PromptInput.coverage2.test.tsx \
  tests/tui/components/PromptInput/PromptInput.helpers.test.ts \
  tests/tui/components/PromptInput/PromptInput.promptSuggestion.test.ts \
  tests/tui/components/PromptInput/PromptInput.render.test.tsx \
  tests/tui/components/PromptInput/PromptInput.wave200-001.coverage.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooter.wave200-085.coverage.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooterLeftSide.render.runtime-coverage.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooterLeftSide.render.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooterLeftSide.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooterLeftSide.wave200-090.coverage.test.tsx \
  tests/tui/components/PromptInput/useSwarmBanner.wave200-037.coverage.test.ts \
  tests/tui/components/PromptInput/utils.test.ts \
  tests/tui/components/QuickOpenDialog.layout.test.ts \
  tests/tui/components/QuickOpenDialog.render.test.tsx \
  tests/tui/components/ScrollKeybindingHandler.coverage2.test.tsx \
  tests/tui/components/ScrollKeybindingHandler.logic.test.ts \
  tests/tui/components/ScrollKeybindingHandler.render.test.tsx \
  tests/tui/components/ScrollKeybindingHandler.wave200-015.coverage.test.tsx \
  tests/tui/components/ThinkingToggle.coverage.test.tsx \
  tests/tui/components/WorktreeExitDialog.loading.test.tsx \
  tests/tui/components/WorktreeExitDialog.runtime-coverage.test.tsx \
  tests/tui/components/WorktreeExitDialog.test.tsx \
  tests/tui/components/design-system/FuzzyPicker.layout.test.ts \
  tests/tui/components/design-system/FuzzyPicker.test.tsx \
  tests/tui/components/spinner/utils.wave200-128.coverage.test.ts \
  tests/tui/components/tasks/BackgroundTaskStatus.coverage.test.tsx \
  tests/tui/components/tasks/BackgroundTaskStatus.layout.test.ts \
  tests/tui/components/tasks/BackgroundTaskStatus.test.tsx \
  tests/tui/components/tasks/BackgroundTaskStatus.wave200-023.coverage.test.tsx \
  tests/tui/components/teams/TeamsDialog.test.tsx \
  tests/tui/components/teams/TeamsDialog.wave200-005.coverage.test.tsx \
  tests/tui/coverage-swarm/swarm-001-components-PromptInput-PromptInput.test.tsx \
  tests/tui/coverage-swarm/swarm-002-components-App.test.tsx \
  tests/tui/coverage-swarm/swarm-007-message-renderers-SystemTextMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-009-hooks-useTypeahead.test.tsx \
  tests/tui/coverage-swarm/swarm-010-ink-components-App.test.tsx \
  tests/tui/coverage-swarm/swarm-012-components-MessageSelector.test.tsx \
  tests/tui/coverage-swarm/swarm-016-components-teams-TeamsDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-019-components-FullscreenLayout.test.tsx \
  tests/tui/coverage-swarm/swarm-023-components-ScrollKeybindingHandler.test.tsx \
  tests/tui/coverage-swarm/swarm-025-message-renderers-AttachmentMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-028-components-tasks-BackgroundTaskStatus.test.tsx \
  tests/tui/coverage-swarm/swarm-029-message-renderers-CollapsedReadSearchContent.test.tsx \
  tests/tui/coverage-swarm/swarm-032-message-renderers-AssistantToolUseMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-034-hooks-fileSuggestions.test.ts \
  tests/tui/coverage-swarm/swarm-039-message-renderers-AssistantTextMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-042-main.test.tsx \
  tests/tui/coverage-swarm/swarm-044-message-renderers-UserToolResultMessage-UserToolSuccessMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-047-components-PromptInput-PromptInputFooterLeftSide.test.tsx \
  tests/tui/coverage-swarm/swarm-051-message-renderers-UserLocalCommandOutputMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-056-message-renderers-AdvisorMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-066-hooks-useIdeAtMentioned.test.ts \
  tests/tui/coverage-swarm/swarm-067-message-renderers-PlanApprovalMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-073-components-ThinkingToggle.test.tsx \
  tests/tui/coverage-swarm/swarm-080-components-PromptInput-PromptInputFooterSuggestions.test.tsx \
  tests/tui/coverage-swarm/swarm-082-hooks-notifs-useMcpConnectivityStatus.test.tsx \
  tests/tui/coverage-swarm/swarm-083-message-renderers-UserToolResultMessage-UserToolResultMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-086-components-compact-CompactSummary.test.tsx \
  tests/tui/coverage-swarm/swarm-092-components-design-system-FuzzyPicker.test.tsx \
  tests/tui/coverage-swarm/swarm-094-input-processBashCommand.test.tsx \
  tests/tui/coverage-swarm/swarm-105-message-renderers-UserTeammateMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-107-components-AutoModeOptInDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-109-hooks-useCancelRequest.test.ts \
  tests/tui/coverage-swarm/swarm-110-message-renderers-HookProgressMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-114-message-renderers-UserPromptMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-127-components-GlobalSearchDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-131-components-DiagnosticsDisplay.test.tsx \
  tests/tui/coverage-swarm/swarm-133-startup-StatusLine.test.tsx \
  tests/tui/coverage-swarm/swarm-138-message-renderers-UserToolResultMessage-UserToolErrorMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-145-message-renderers-UserToolResultMessage-UserToolRejectMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-152-hooks-usePrStatus.test.ts \
  tests/tui/coverage-swarm/swarm-153-hooks-useSearchInput.test.ts \
  tests/tui/coverage-swarm/swarm-162-components-PromptInput-PromptInputModeIndicator.test.tsx \
  tests/tui/coverage-swarm/swarm-165-components-QuickOpenDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-169-message-renderers-UserBashOutputMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-172-hooks-useGlobalKeybindings.test.tsx \
  tests/tui/coverage-swarm/swarm-174-message-renderers-UserToolResultMessage-utils.test.tsx \
  tests/tui/coverage-swarm/swarm-180-components-PromptInput-PromptInputQueuedCommands.test.tsx \
  tests/tui/coverage-swarm/swarm-187-components-WorktreeExitDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-192-hooks-useHistorySearch.test.ts \
  tests/tui/coverage-swarm/swarm-201-components-teams-TeamsDialog-layout.test.ts \
  tests/tui/coverage-swarm/swarm-207-hooks-unifiedSuggestions.test.ts \
  tests/tui/coverage-swarm/swarm-215-components-tasks-BackgroundTaskStatus-layout.test.ts \
  tests/tui/coverage-swarm/swarm-220-components-PromptInput-inputPaste.test.ts \
  tests/tui/coverage-swarm/swarm-227-message-renderers-HighlightedThinkingText.test.tsx \
  tests/tui/coverage-swarm/swarm-229-components-PromptInput-SandboxPromptFooterHint.test.tsx \
  tests/tui/coverage-swarm/swarm-240-components-PasteConfirmDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-242-components-PromptInput-PromptInputHelpMenu.test.tsx \
  tests/tui/coverage-swarm/swarm-243-components-PromptInput-useSwarmBanner.test.ts \
  tests/tui/hooks/fileSuggestions.coverage2.test.ts \
  tests/tui/hooks/fileSuggestions.runtime-coverage.test.ts \
  tests/tui/hooks/fileSuggestions.test.ts \
  tests/tui/hooks/fileSuggestions.wave200-081.coverage.test.ts \
  tests/tui/hooks/notifs/useMcpConnectivityStatus.test.tsx \
  tests/tui/hooks/unifiedSuggestions.wave200-057.coverage.test.ts \
  tests/tui/hooks/useCancelRequest.test.tsx \
  tests/tui/hooks/useCancelRequest.wave200-149.coverage.test.tsx \
  tests/tui/hooks/useCopyOnSelect.wave200-135.coverage.test.tsx \
  tests/tui/hooks/useGlobalKeybindings.coverage.test.tsx \
  tests/tui/hooks/useGlobalKeybindings.wave200-030.coverage.test.tsx \
  tests/tui/hooks/useHistorySearch.runtime-coverage.test.tsx \
  tests/tui/hooks/useHistorySearch.test.tsx \
  tests/tui/hooks/usePrStatus.wave200-052.coverage.test.tsx \
  tests/tui/hooks/useSearchInput.coverage2.test.ts \
  tests/tui/hooks/useSearchInput.test.tsx \
  tests/tui/hooks/useSearchInput.wave200-048.coverage.test.tsx \
  tests/tui/hooks/useTypeahead.coverage2.test.tsx \
  tests/tui/hooks/useTypeahead.hook.test.tsx \
  tests/tui/hooks/useTypeahead.test.ts \
  tests/tui/hooks/useTypeahead.wave200-006.coverage.test.tsx \
  tests/tui/ink/components/App.coverage2.test.tsx \
  tests/tui/ink/components/App.render-error.test.tsx \
  tests/tui/ink/components/App.wave200-011.coverage.test.tsx \
  tests/tui/input/dollar-skill-command-authority.test.ts \
  tests/tui/input/dollar-skill-command.test.ts \
  tests/tui/input/processBashCommand.test.tsx \
  tests/tui/main.coverage.test.ts \
  tests/tui/main.terminal-close.test.tsx \
  tests/tui/main.wave200-064.coverage.test.ts \
  tests/tui/message-renderers/AdvisorMessage.coverage.test.tsx \
  tests/tui/message-renderers/AssistantTextMessage.coverage.test.tsx \
  tests/tui/message-renderers/AssistantTextMessage.test.tsx \
  tests/tui/message-renderers/AssistantTextMessage.wave200-124.coverage.test.tsx \
  tests/tui/message-renderers/AssistantToolUseMessage.coverage.test.tsx \
  tests/tui/message-renderers/AssistantToolUseMessage.coverage2.test.tsx \
  tests/tui/message-renderers/AssistantToolUseMessage.test.tsx \
  tests/tui/message-renderers/AssistantToolUseMessage.wave200-047.coverage.test.tsx \
  tests/tui/message-renderers/AttachmentMessage.coverage.test.tsx \
  tests/tui/message-renderers/AttachmentMessage.render.test.tsx \
  tests/tui/message-renderers/AttachmentMessage.rendering.test.ts \
  tests/tui/message-renderers/AttachmentMessage.wave200-071.coverage.test.tsx \
  tests/tui/message-renderers/CollapsedReadSearchContent.render.test.tsx \
  tests/tui/message-renderers/CollapsedReadSearchContent.test.tsx \
  tests/tui/message-renderers/CollapsedReadSearchContent.wave200-059.coverage.test.tsx \
  tests/tui/message-renderers/GroupedToolUseContent.coverage.test.tsx \
  tests/tui/message-renderers/GroupedToolUseContent.test.ts \
  tests/tui/message-renderers/HighlightedThinkingText.coverage.test.tsx \
  tests/tui/message-renderers/HookProgressMessage.coverage.test.tsx \
  tests/tui/message-renderers/PlanApprovalMessage.coverage.test.tsx \
  tests/tui/message-renderers/PlanApprovalMessage.glyphs.test.ts \
  tests/tui/message-renderers/SystemTextMessage.behavior.test.ts \
  tests/tui/message-renderers/SystemTextMessage.coverage.test.tsx \
  tests/tui/message-renderers/SystemTextMessage.coverage2.test.tsx \
  tests/tui/message-renderers/SystemTextMessage.render.test.tsx \
  tests/tui/message-renderers/SystemTextMessage.wave200-010.coverage.test.tsx \
  tests/tui/message-renderers/UserBashOutputMessage.coverage.test.tsx \
  tests/tui/message-renderers/UserLocalCommandOutputMessage.coverage.test.tsx \
  tests/tui/message-renderers/UserLocalCommandOutputMessage.wave200-125.coverage.test.tsx \
  tests/tui/message-renderers/UserPromptMessage.coverage.test.tsx \
  tests/tui/message-renderers/UserPromptMessage.test.tsx \
  tests/tui/message-renderers/UserTeammateMessage.coverage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.wave200-049.coverage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolRejectMessage.wave200-072.coverage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.coverage2.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.wave200-035.coverage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.wave200-060.coverage.test.tsx \
  tests/tui/message-renderers/teamMemCollapsed.test.tsx \
  tests/tui/message-renderers/teamMemSaved.test.ts \
  tests/tui/parity/App.no-runningtoolprogress.parity.test.tsx \
  tests/tui/parity/App.streaming-tool-use.parity.test.tsx \
  tests/tui/parity/App.tooljsx-gating.parity.test.tsx \
  tests/tui/parity/App.tooljsx-state.parity.test.tsx \
  tests/tui/parity/HookProgressMessage.live.parity.test.ts \
  tests/tui/pending-user-echo.test.ts \
  tests/tui/session-transcript.user-timestamps.test.ts \
  tests/tui/startup/StatusLine.test.tsx \
  tests/tui/startup/StatusLine.wave200-093.coverage.test.tsx \
  tests/tui/startup/statusNoticeDefinitions.test.tsx \
  tests/tui/startup/statusNoticeDefinitions.wave200-142.coverage.test.tsx \
  tests/tui/submission-terminal.test.ts \
  tests/unified-exec/scrub-env.test.ts \
  tests/unified-exec/subprocess-env-node-import.test.ts \
  tests/utils/autoUpdater.background.test.ts \
  tests/utils/autoUpdater.permissions.test.ts \
  tests/utils/env.test.ts \
  tests/utils/memory/memory-utils.contract.test.ts \
  tests/utils/user.test.ts \
  --maxWorkers=2
```

</details>

<details>
<summary>Additional before batch</summary>

```sh
TMPDIR=/private/tmp/tt/vt node scripts/run-hermetic-vitest.mjs run \
  tests/budget/admitted-legacy-canonical-tool.test.ts \
  tests/commands.test.ts \
  tests/config/session-home-authority.architecture.test.ts \
  tests/elicitation/session.test.ts \
  tests/prompts/attachments/extractors.test.ts \
  tests/sandbox/execution-surfaces.test.ts \
  tests/services/PromptSuggestion/speculation.test.ts \
  tests/session/exec-agent-hook-run-turn.test.ts \
  tests/tools/AgentTool/agentColorManager.test.ts \
  tests/tools/bash-permission-keeps-args.test.ts \
  tests/tools/canonical-input-schemas.lazy.test.ts \
  tests/tools/system/file-edit.test.ts \
  tests/tools/system/signed-allowed-roots.test.ts \
  tests/tools/tool-surface-consolidation.test.ts \
  tests/tui/components/FullscreenLayout.test.tsx \
  tests/tui/components/PromptInput/PromptInput.render.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooter.wave200-085.coverage.test.tsx \
  tests/tui/components/statusLineLayout.test.ts \
  tests/tui/context/promptOverlayContext.test.tsx \
  tests/tui/coverage-swarm/swarm-001-components-PromptInput-PromptInput.test.tsx \
  tests/tui/coverage-swarm/swarm-019-components-FullscreenLayout.test.tsx \
  tests/tui/coverage-swarm/swarm-094-input-processBashCommand.test.tsx \
  tests/tui/coverage-swarm/swarm-113-context-promptOverlayContext.test.tsx \
  tests/tui/coverage-swarm/swarm-140-state-collabAgentTaskSync.test.ts \
  tests/tui/daemon-session.contract.test.ts \
  tests/tui/daemon-session.ihunt-error-clears-active-turn.test.ts \
  tests/tui/input/processBashCommand.test.tsx \
  tests/tui/moved-source-markers.test.ts \
  tests/tui/state/AppState.test.tsx \
  tests/tui/state/collabAgentTaskSync.test.ts \
  tests/tui/state/collabAgentTaskSync.wave200-116.coverage.test.ts \
  tests/utils/promptShellExecution.test.ts \
  --maxWorkers=2
```

</details>

<details>
<summary>Fallback renderer before batch</summary>

```sh
TMPDIR=/private/tmp/tt/vt node scripts/run-hermetic-vitest.mjs run \
  tests/tui/components/FallbackToolUseErrorMessage.test.tsx \
  --maxWorkers=2
```

</details>

<details>
<summary>Final focused after batch</summary>

```sh
TMPDIR=/private/tmp/tt/vt node scripts/run-hermetic-vitest.mjs run \
  tests/app-server/client-env-snapshot.test.ts \
  tests/bin/agenc-main-daemon-audit.test.ts \
  tests/bin/agenc-main-recovery-operator.test.ts \
  tests/bin/agenc.user-prompt-submit.test.ts \
  tests/bin/daemon-child-main.test.ts \
  tests/bin/daemon-provisional-child-main.test.ts \
  tests/bin/prompt-stdin.test.ts \
  tests/bin/tui-trust-prompt.test.tsx \
  tests/bootstrap/node-env.test.ts \
  tests/budget/admitted-legacy-canonical-tool.test.ts \
  tests/commands.test.ts \
  tests/config/env-documentation-coverage.architecture.test.ts \
  tests/config/policy-env-authority.architecture.test.ts \
  tests/config/session-home-authority.architecture.test.ts \
  tests/contracts/no-user-visible-em-dash.test.ts \
  tests/conversation/realtime/prompt.contract.test.ts \
  tests/design-hermetic-env.test.ts \
  tests/elicitation/request-user-input.test.ts \
  tests/elicitation/session.test.ts \
  tests/eval/eval-executor-literal-env.test.ts \
  tests/gaphunt3/prompts-system-prompt.test.ts \
  tests/gaphunt3/tools-WebFetchTool-prompt.test.ts \
  tests/gaphunt3/utils-hooks.test.ts \
  tests/gaphunt3/utils-sessionStorage.test.ts \
  tests/gateway/prompt-injection.test.ts \
  tests/hermetic-env.test.ts \
  tests/hooks/user-prompt-ingress.test.ts \
  tests/hooks/user-prompt-submit.test.ts \
  tests/llm-pipeline-harness-env.test.ts \
  tests/llm/providers/grok/adapter-utils.test.ts \
  tests/prompts/attachments/extractors.test.ts \
  tests/prompts/lean-system-prompt.test.ts \
  tests/prompts/light-permissions-prompt.test.ts \
  tests/prompts/permissions-prompt.test.ts \
  tests/prompts/system-prompt-authority.architecture.test.ts \
  tests/prompts/system-prompt.test.ts \
  tests/sandbox/execution-surfaces.test.ts \
  tests/sdk-package/prompt-event-overflow.contract.test.ts \
  tests/sdk-package/prompt-event-queue.test.ts \
  tests/sdk-package/prompt-race-safety.contract.test.ts \
  tests/services/PromptSuggestion/prompt-suggestion.contract.test.ts \
  tests/services/PromptSuggestion/speculation.test.ts \
  tests/session/contextual-user-message.test.ts \
  tests/session/exec-agent-hook-run-turn.test.ts \
  tests/session/local-user-stop-admission.test.ts \
  tests/session/prompt-cache-share.test.ts \
  tests/session/prompt-cache-state.test.ts \
  tests/session/prompt-input-byte-bound.test.ts \
  tests/session/user-stop-durability.test.ts \
  tests/session/user-stop-state.test.ts \
  tests/subprocess-env-scrub.test.ts \
  tests/tools/AgentTool/agentColorManager.test.ts \
  tests/tools/BashTool/utils.test.ts \
  tests/tools/ask-user-question-tui-routing.test.tsx \
  tests/tools/ask-user-question/tool.test.ts \
  tests/tools/ask-user-question/tui-tool.test.tsx \
  tests/tools/bash-permission-keeps-args.test.ts \
  tests/tools/canonical-input-schemas.lazy.test.ts \
  tests/tools/system/file-edit.test.ts \
  tests/tools/system/signed-allowed-roots.test.ts \
  tests/tools/tool-surface-consolidation.test.ts \
  tests/tui-e2e-harness-env.test.ts \
  tests/tui/completion-pipeline-watcher.test.ts \
  tests/tui/components/App.completion-pipeline.test.tsx \
  tests/tui/components/App.coverage2.test.tsx \
  tests/tui/components/App.daemon-stall-watchdog.test.ts \
  tests/tui/components/App.local-agents.test.tsx \
  tests/tui/components/App.render.test.tsx \
  tests/tui/components/App.wave200-002.coverage.test.tsx \
  tests/tui/components/AutoModeOptInDialog.coverage.test.tsx \
  tests/tui/components/BashModeProgress.test.tsx \
  tests/tui/components/BashModeProgress.wave200-138.coverage.test.tsx \
  tests/tui/components/DiagnosticsDisplay.coverage.test.tsx \
  tests/tui/components/DiagnosticsDisplay.wave200-120.coverage.test.tsx \
  tests/tui/components/ExitFlow.test.tsx \
  tests/tui/components/ExitFlow.wave200-139.coverage.test.tsx \
  tests/tui/components/FallbackToolUseErrorMessage.test.tsx \
  tests/tui/components/FullscreenLayout.coverage2.test.tsx \
  tests/tui/components/FullscreenLayout.render-branches.test.tsx \
  tests/tui/components/FullscreenLayout.session-usage.test.tsx \
  tests/tui/components/FullscreenLayout.test.tsx \
  tests/tui/components/FullscreenLayout.usage-indicators.test.tsx \
  tests/tui/components/FullscreenLayout.wave200-018.coverage.test.tsx \
  tests/tui/components/GlobalSearchDialog.layout.test.ts \
  tests/tui/components/GlobalSearchDialog.render.test.tsx \
  tests/tui/components/GlobalSearchDialog.wave200-129.coverage.test.tsx \
  tests/tui/components/MessageSelector.coverage.test.tsx \
  tests/tui/components/MessageSelector.coverage2.test.tsx \
  tests/tui/components/MessageSelector.filter.test.ts \
  tests/tui/components/MessageSelector.layout.test.ts \
  tests/tui/components/MessageSelector.render.test.tsx \
  tests/tui/components/MessageSelector.wave200-013.coverage.test.tsx \
  tests/tui/components/PasteConfirmDialog.test.tsx \
  tests/tui/components/PromptInput/PromptInput.busyPolicy.test.ts \
  tests/tui/components/PromptInput/PromptInput.coverage2.test.tsx \
  tests/tui/components/PromptInput/PromptInput.helpers.test.ts \
  tests/tui/components/PromptInput/PromptInput.promptSuggestion.test.ts \
  tests/tui/components/PromptInput/PromptInput.render.test.tsx \
  tests/tui/components/PromptInput/PromptInput.wave200-001.coverage.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooter.wave200-085.coverage.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooterLeftSide.render.runtime-coverage.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooterLeftSide.render.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooterLeftSide.test.tsx \
  tests/tui/components/PromptInput/PromptInputFooterLeftSide.wave200-090.coverage.test.tsx \
  tests/tui/components/PromptInput/useSwarmBanner.wave200-037.coverage.test.ts \
  tests/tui/components/PromptInput/utils.test.ts \
  tests/tui/components/QuickOpenDialog.layout.test.ts \
  tests/tui/components/QuickOpenDialog.render.test.tsx \
  tests/tui/components/ScrollKeybindingHandler.coverage2.test.tsx \
  tests/tui/components/ScrollKeybindingHandler.logic.test.ts \
  tests/tui/components/ScrollKeybindingHandler.render.test.tsx \
  tests/tui/components/ScrollKeybindingHandler.wave200-015.coverage.test.tsx \
  tests/tui/components/ThinkingToggle.coverage.test.tsx \
  tests/tui/components/WorktreeExitDialog.loading.test.tsx \
  tests/tui/components/WorktreeExitDialog.runtime-coverage.test.tsx \
  tests/tui/components/WorktreeExitDialog.test.tsx \
  tests/tui/components/design-system/FuzzyPicker.layout.test.ts \
  tests/tui/components/design-system/FuzzyPicker.test.tsx \
  tests/tui/components/spinner/utils.wave200-128.coverage.test.ts \
  tests/tui/components/statusLineLayout.test.ts \
  tests/tui/components/tasks/BackgroundTaskStatus.coverage.test.tsx \
  tests/tui/components/tasks/BackgroundTaskStatus.layout.test.ts \
  tests/tui/components/tasks/BackgroundTaskStatus.test.tsx \
  tests/tui/components/tasks/BackgroundTaskStatus.wave200-023.coverage.test.tsx \
  tests/tui/components/teams/TeamsDialog.test.tsx \
  tests/tui/components/teams/TeamsDialog.wave200-005.coverage.test.tsx \
  tests/tui/context/promptOverlayContext.test.tsx \
  tests/tui/coverage-swarm/swarm-001-components-PromptInput-PromptInput.test.tsx \
  tests/tui/coverage-swarm/swarm-002-components-App.test.tsx \
  tests/tui/coverage-swarm/swarm-007-message-renderers-SystemTextMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-009-hooks-useTypeahead.test.tsx \
  tests/tui/coverage-swarm/swarm-010-ink-components-App.test.tsx \
  tests/tui/coverage-swarm/swarm-012-components-MessageSelector.test.tsx \
  tests/tui/coverage-swarm/swarm-016-components-teams-TeamsDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-019-components-FullscreenLayout.test.tsx \
  tests/tui/coverage-swarm/swarm-023-components-ScrollKeybindingHandler.test.tsx \
  tests/tui/coverage-swarm/swarm-025-message-renderers-AttachmentMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-028-components-tasks-BackgroundTaskStatus.test.tsx \
  tests/tui/coverage-swarm/swarm-029-message-renderers-CollapsedReadSearchContent.test.tsx \
  tests/tui/coverage-swarm/swarm-032-message-renderers-AssistantToolUseMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-034-hooks-fileSuggestions.test.ts \
  tests/tui/coverage-swarm/swarm-039-message-renderers-AssistantTextMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-042-main.test.tsx \
  tests/tui/coverage-swarm/swarm-044-message-renderers-UserToolResultMessage-UserToolSuccessMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-047-components-PromptInput-PromptInputFooterLeftSide.test.tsx \
  tests/tui/coverage-swarm/swarm-051-message-renderers-UserLocalCommandOutputMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-056-message-renderers-AdvisorMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-066-hooks-useIdeAtMentioned.test.ts \
  tests/tui/coverage-swarm/swarm-067-message-renderers-PlanApprovalMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-073-components-ThinkingToggle.test.tsx \
  tests/tui/coverage-swarm/swarm-080-components-PromptInput-PromptInputFooterSuggestions.test.tsx \
  tests/tui/coverage-swarm/swarm-082-hooks-notifs-useMcpConnectivityStatus.test.tsx \
  tests/tui/coverage-swarm/swarm-083-message-renderers-UserToolResultMessage-UserToolResultMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-086-components-compact-CompactSummary.test.tsx \
  tests/tui/coverage-swarm/swarm-092-components-design-system-FuzzyPicker.test.tsx \
  tests/tui/coverage-swarm/swarm-094-input-processBashCommand.test.tsx \
  tests/tui/coverage-swarm/swarm-105-message-renderers-UserTeammateMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-107-components-AutoModeOptInDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-109-hooks-useCancelRequest.test.ts \
  tests/tui/coverage-swarm/swarm-110-message-renderers-HookProgressMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-113-context-promptOverlayContext.test.tsx \
  tests/tui/coverage-swarm/swarm-114-message-renderers-UserPromptMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-127-components-GlobalSearchDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-131-components-DiagnosticsDisplay.test.tsx \
  tests/tui/coverage-swarm/swarm-133-startup-StatusLine.test.tsx \
  tests/tui/coverage-swarm/swarm-138-message-renderers-UserToolResultMessage-UserToolErrorMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-140-state-collabAgentTaskSync.test.ts \
  tests/tui/coverage-swarm/swarm-145-message-renderers-UserToolResultMessage-UserToolRejectMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-152-hooks-usePrStatus.test.ts \
  tests/tui/coverage-swarm/swarm-153-hooks-useSearchInput.test.ts \
  tests/tui/coverage-swarm/swarm-162-components-PromptInput-PromptInputModeIndicator.test.tsx \
  tests/tui/coverage-swarm/swarm-165-components-QuickOpenDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-169-message-renderers-UserBashOutputMessage.test.tsx \
  tests/tui/coverage-swarm/swarm-172-hooks-useGlobalKeybindings.test.tsx \
  tests/tui/coverage-swarm/swarm-174-message-renderers-UserToolResultMessage-utils.test.tsx \
  tests/tui/coverage-swarm/swarm-180-components-PromptInput-PromptInputQueuedCommands.test.tsx \
  tests/tui/coverage-swarm/swarm-187-components-WorktreeExitDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-192-hooks-useHistorySearch.test.ts \
  tests/tui/coverage-swarm/swarm-201-components-teams-TeamsDialog-layout.test.ts \
  tests/tui/coverage-swarm/swarm-207-hooks-unifiedSuggestions.test.ts \
  tests/tui/coverage-swarm/swarm-215-components-tasks-BackgroundTaskStatus-layout.test.ts \
  tests/tui/coverage-swarm/swarm-220-components-PromptInput-inputPaste.test.ts \
  tests/tui/coverage-swarm/swarm-227-message-renderers-HighlightedThinkingText.test.tsx \
  tests/tui/coverage-swarm/swarm-229-components-PromptInput-SandboxPromptFooterHint.test.tsx \
  tests/tui/coverage-swarm/swarm-240-components-PasteConfirmDialog.test.tsx \
  tests/tui/coverage-swarm/swarm-242-components-PromptInput-PromptInputHelpMenu.test.tsx \
  tests/tui/coverage-swarm/swarm-243-components-PromptInput-useSwarmBanner.test.ts \
  tests/tui/daemon-session.contract.test.ts \
  tests/tui/daemon-session.ihunt-error-clears-active-turn.test.ts \
  tests/tui/hooks/fileSuggestions.coverage2.test.ts \
  tests/tui/hooks/fileSuggestions.runtime-coverage.test.ts \
  tests/tui/hooks/fileSuggestions.test.ts \
  tests/tui/hooks/fileSuggestions.wave200-081.coverage.test.ts \
  tests/tui/hooks/notifs/useMcpConnectivityStatus.test.tsx \
  tests/tui/hooks/unifiedSuggestions.wave200-057.coverage.test.ts \
  tests/tui/hooks/useCancelRequest.test.tsx \
  tests/tui/hooks/useCancelRequest.wave200-149.coverage.test.tsx \
  tests/tui/hooks/useCopyOnSelect.wave200-135.coverage.test.tsx \
  tests/tui/hooks/useGlobalKeybindings.coverage.test.tsx \
  tests/tui/hooks/useGlobalKeybindings.wave200-030.coverage.test.tsx \
  tests/tui/hooks/useHistorySearch.runtime-coverage.test.tsx \
  tests/tui/hooks/useHistorySearch.test.tsx \
  tests/tui/hooks/usePrStatus.wave200-052.coverage.test.tsx \
  tests/tui/hooks/useSearchInput.coverage2.test.ts \
  tests/tui/hooks/useSearchInput.test.tsx \
  tests/tui/hooks/useSearchInput.wave200-048.coverage.test.tsx \
  tests/tui/hooks/useTypeahead.coverage2.test.tsx \
  tests/tui/hooks/useTypeahead.hook.test.tsx \
  tests/tui/hooks/useTypeahead.test.ts \
  tests/tui/hooks/useTypeahead.wave200-006.coverage.test.tsx \
  tests/tui/ink/components/App.coverage2.test.tsx \
  tests/tui/ink/components/App.render-error.test.tsx \
  tests/tui/ink/components/App.wave200-011.coverage.test.tsx \
  tests/tui/input/dollar-skill-command-authority.test.ts \
  tests/tui/input/dollar-skill-command.test.ts \
  tests/tui/input/processBashCommand.test.tsx \
  tests/tui/main.coverage.test.ts \
  tests/tui/main.terminal-close.test.tsx \
  tests/tui/main.wave200-064.coverage.test.ts \
  tests/tui/message-renderers/AdvisorMessage.coverage.test.tsx \
  tests/tui/message-renderers/AssistantTextMessage.coverage.test.tsx \
  tests/tui/message-renderers/AssistantTextMessage.test.tsx \
  tests/tui/message-renderers/AssistantTextMessage.wave200-124.coverage.test.tsx \
  tests/tui/message-renderers/AssistantToolUseMessage.coverage.test.tsx \
  tests/tui/message-renderers/AssistantToolUseMessage.coverage2.test.tsx \
  tests/tui/message-renderers/AssistantToolUseMessage.test.tsx \
  tests/tui/message-renderers/AssistantToolUseMessage.wave200-047.coverage.test.tsx \
  tests/tui/message-renderers/AttachmentMessage.coverage.test.tsx \
  tests/tui/message-renderers/AttachmentMessage.render.test.tsx \
  tests/tui/message-renderers/AttachmentMessage.rendering.test.ts \
  tests/tui/message-renderers/AttachmentMessage.wave200-071.coverage.test.tsx \
  tests/tui/message-renderers/CollapsedReadSearchContent.render.test.tsx \
  tests/tui/message-renderers/CollapsedReadSearchContent.test.tsx \
  tests/tui/message-renderers/CollapsedReadSearchContent.wave200-059.coverage.test.tsx \
  tests/tui/message-renderers/GroupedToolUseContent.coverage.test.tsx \
  tests/tui/message-renderers/GroupedToolUseContent.test.ts \
  tests/tui/message-renderers/HighlightedThinkingText.coverage.test.tsx \
  tests/tui/message-renderers/HookProgressMessage.coverage.test.tsx \
  tests/tui/message-renderers/PlanApprovalMessage.coverage.test.tsx \
  tests/tui/message-renderers/PlanApprovalMessage.glyphs.test.ts \
  tests/tui/message-renderers/SystemTextMessage.behavior.test.ts \
  tests/tui/message-renderers/SystemTextMessage.coverage.test.tsx \
  tests/tui/message-renderers/SystemTextMessage.coverage2.test.tsx \
  tests/tui/message-renderers/SystemTextMessage.render.test.tsx \
  tests/tui/message-renderers/SystemTextMessage.wave200-010.coverage.test.tsx \
  tests/tui/message-renderers/UserBashOutputMessage.coverage.test.tsx \
  tests/tui/message-renderers/UserLocalCommandOutputMessage.coverage.test.tsx \
  tests/tui/message-renderers/UserLocalCommandOutputMessage.wave200-125.coverage.test.tsx \
  tests/tui/message-renderers/UserPromptMessage.coverage.test.tsx \
  tests/tui/message-renderers/UserPromptMessage.test.tsx \
  tests/tui/message-renderers/UserTeammateMessage.coverage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.wave200-049.coverage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolRejectMessage.wave200-072.coverage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.coverage2.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.wave200-035.coverage.test.tsx \
  tests/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.wave200-060.coverage.test.tsx \
  tests/tui/message-renderers/teamMemCollapsed.test.tsx \
  tests/tui/message-renderers/teamMemSaved.test.ts \
  tests/tui/moved-source-markers.test.ts \
  tests/tui/parity/App.no-runningtoolprogress.parity.test.tsx \
  tests/tui/parity/App.streaming-tool-use.parity.test.tsx \
  tests/tui/parity/App.tooljsx-gating.parity.test.tsx \
  tests/tui/parity/App.tooljsx-state.parity.test.tsx \
  tests/tui/parity/HookProgressMessage.live.parity.test.ts \
  tests/tui/pending-user-echo.test.ts \
  tests/tui/session-transcript.user-timestamps.test.ts \
  tests/tui/startup/StatusLine.test.tsx \
  tests/tui/startup/StatusLine.wave200-093.coverage.test.tsx \
  tests/tui/startup/statusNoticeDefinitions.test.tsx \
  tests/tui/startup/statusNoticeDefinitions.wave200-142.coverage.test.tsx \
  tests/tui/state/AppState.test.tsx \
  tests/tui/state/collabAgentTaskSync.test.ts \
  tests/tui/state/collabAgentTaskSync.wave200-116.coverage.test.ts \
  tests/tui/submission-terminal.test.ts \
  tests/unified-exec/scrub-env.test.ts \
  tests/unified-exec/subprocess-env-node-import.test.ts \
  tests/utils/agencInChrome/setupPortable.test.ts \
  tests/utils/autoUpdater.background.test.ts \
  tests/utils/autoUpdater.permissions.test.ts \
  tests/utils/env.test.ts \
  tests/utils/memory/memory-utils.contract.test.ts \
  tests/utils/promptShellExecution.test.ts \
  tests/utils/user.test.ts \
  --maxWorkers=2
```

</details>

The first combined after batch used the sorted union of the three before lists in one identical runner invocation. The new browser-profile baseline used:

```sh
TMPDIR=/private/tmp/tt/vt node scripts/run-hermetic-vitest.mjs run \
  tests/utils/agencInChrome/setupPortable.test.ts \
  --maxWorkers=2
```

### Local commits

- `50a826853` Fix TUI theme color types
- `30f8eed8f` Fix transcript renderer types
- `bdfb7cfad` Fix TUI session and command types
- `a56777b56` Fix TUI utility types
- `0fc03ca1a` Fix TUI input and dialog types

The documentation is committed separately as `Document TUI typecheck triage`.
No push or pull request was made.
