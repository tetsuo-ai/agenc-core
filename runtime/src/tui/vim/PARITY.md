# TUI Vim Parity

Donor source: `/home/tetsuo/git/openclaude/src/vim/{types,motions,operators,textObjects,transitions}.ts` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow donor citation in local parity artifact -->

AgenC destinations:

- `runtime/src/tui/vim/types.ts`
- `runtime/src/tui/vim/motions.ts`
- `runtime/src/tui/vim/operators.ts`
- `runtime/src/tui/vim/text-objects.ts`
- `runtime/src/tui/vim/transitions.ts`

The state machine, motion resolver, operator executor, and text-object resolver are ported onto AgenC's `TextCursor` primitive. `textObjects.ts` is intentionally renamed to `text-objects.ts` for the OC-06 destination contract.

AgenC-required extensions beyond the pinned donor files:

- `ip` and `ap` paragraph text objects.
- `it` and `at` balanced tag text objects.
- `ge` and `gE` previous-word-end motions, including operator-pending use.
- `n` and `N` repeat the stored find motion because this composer has no slash-search state.
- `tui.vimMode` is the canonical config flag; legacy `editorMode="vim"` remains a fallback when the nested flag is absent.
- `StatusLine` renders the visible `-- INSERT --` / `-- NORMAL --` indicator when the custom status line is active; `PromptInputFooterLeftSide` renders the same built-in prompt status when the custom status line is absent.
- `processTextPrompt` exposes route-level vim finalization for callers that need state-machine processing before prompt message construction. `processUserInput` applies that same finalization before bash, slash, or prompt dispatch when a `VimRoutingState` is supplied.

Coverage:

- `runtime/src/tui/vim/types.test.ts`
- `runtime/src/tui/vim/motions.test.ts`
- `runtime/src/tui/vim/operators.test.ts`
- `runtime/src/tui/vim/text-objects.test.ts`
- `runtime/src/tui/vim/transitions.test.ts`
- `runtime/src/tui/input/processTextPrompt.test.ts`
- `runtime/src/tui/components/PromptInput/PromptInput.vimMode.test.tsx`
- `runtime/src/tui/components/PromptInput/utils.test.ts`
- `runtime/src/tui/components/PromptInput/PromptInputFooterLeftSide.test.tsx`
- `runtime/src/tools/ConfigTool/ConfigTool.test.ts`
