# Memory Command Parity

Upstream reference: TUI/source reference at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/commands/memory/index.ts`
- `src/commands/memory/memory.tsx`

This directory owns the MM-06 TUI memory command port:
- `index.ts` exposes `/memory` as a local JSX command for the interactive TUI.
- `memory.tsx` creates missing user/project memory files, opens the selected file through the argv-safe editor launcher, and reports the editor/source hint or launch failure.
- `slash.ts` gives dispatcher/headless callers a non-throwing fallback instead of trying to render the Ink dialog.
