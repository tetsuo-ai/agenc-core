# T-15 History Resume Parity

## Scope

T-15 owns prompt history storage helpers, Ctrl+R history search, resume conversation selection, and transcript search extraction under `runtime/src/tui/history/`.

## Absorbed Files

- `history.ts`
- `HistorySearchDialog.tsx`
- `ResumeConversation.tsx`
- `transcriptSearch.ts`

## Live Wiring

- `runtime/src/tui/components/PromptInput/PromptInput.tsx` imports paste-reference helpers and `HistorySearchDialog` from `runtime/src/tui/history/`.
- `runtime/src/tui/components/Messages.tsx` and `runtime/src/agenc/upstream/components/VirtualMessageList.tsx` import transcript search from `runtime/src/tui/history/transcriptSearch.ts`.
- `runtime/src/agenc/upstream/dialogLaunchers.tsx` imports `ResumeConversation` from `runtime/src/tui/history/ResumeConversation.tsx`.
- Upstream prompt/history hooks import history helpers from `runtime/src/tui/history/history.ts`.

## Verification

- `history.test.ts` covers paste-reference formatting, parsing, and expansion.
- `transcriptSearch.test.ts` covers visible-text extraction for user, assistant, and tool-result messages.
- `scripts/goal/verify.mjs T-15` checks deleted upstream files and retired import paths.
