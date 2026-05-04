# T-14 Startup Status Parity

## Scope

T-14 owns the first-frame startup screen, status-line mount/update surface, and startup notices under `runtime/src/tui/startup/`.

## Absorbed Files

- `StartupScreen.ts`
- `StatusLine.tsx`
- `StatusNotices.tsx`
- `statusNoticeDefinitions.tsx`

## Live Wiring

- `runtime/src/agenc/upstream/entrypoints/cli.tsx` imports `printStartupScreen` from `runtime/src/tui/startup/StartupScreen.ts`.
- `runtime/src/tui/components/Messages.tsx` renders startup notices from `runtime/src/tui/startup/StatusNotices.tsx`.
- `runtime/src/tui/components/PromptInput/PromptInputFooter.tsx` renders the status line from `runtime/src/tui/startup/StatusLine.tsx`.

## Verification

- `StartupScreen.test.ts` covers provider-label precedence for the startup screen.
- `statusNoticeDefinitions.test.tsx` covers active daemon, auth, provider, memory, agent-description, and JetBrains notice text.
- `scripts/goal/verify.mjs T-14` checks deleted upstream files and retired import paths.
