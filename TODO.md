# Embedded Neovim BUFFER Implementation Plan

This plan replaces the custom Vim-like BUFFER path with an enterprise-grade
embedded Neovim editor surface. The goal is not to reimplement Vim. The goal is
to let Neovim own Vim semantics and make AgenC own process lifecycle, workbench
integration, rendering, file safety, and end-to-end verification.

## Decision

- Primary editor path: embedded `nvim --embed`.
- Fallback editor path: current inline BUFFER remains available only as a basic
  fallback and must not claim exact Vim behavior.
- External editor path: remains explicit handoff for users who want their normal
  terminal or GUI editor.
- No custom Vim behavior should be added as a substitute for real Neovim
  semantics unless it is fallback-only and clearly named as such.

## Current State

- `runtime/src/tui/workbench/surfaces/BufferSurface.tsx` renders BUFFER inside
  the workbench and routes keybindings/input capture to `WorkbenchBufferStore`.
- `runtime/src/tui/workbench/buffer/BufferStore.ts` owns file open/save,
  dirty-state checks, LSP notifications, and a custom Vim-ish state machine.
- `runtime/src/tui/workbench/buffer/editing.ts` uses `@codemirror/state` for
  document state, selections, transactions, and undo/redo stacks.
- `runtime/src/tui/vim/*` implements a partial Vim-like command/motion/operator
  layer. It is not real Vim and should not be expanded into a clone.
- `runtime/src/tui/workbench/buffer/externalEditor.ts` already resolves
  `$VISUAL`, `$EDITOR`, and fallback editors including `nvim`, `vim`, `vi`, and
  `nano`.

## Target Architecture

### Editor Provider Boundary

Create a provider boundary so the workbench can switch editor implementations
without coupling BUFFER UI directly to a process or fallback store.

Target files:

- `runtime/src/tui/workbench/buffer/providers/types.ts`
- `runtime/src/tui/workbench/buffer/providers/inline/InlineBufferProvider.ts`
- `runtime/src/tui/workbench/buffer/providers/external/ExternalEditorProvider.ts`
- `runtime/src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.ts`
- `runtime/src/tui/workbench/buffer/providers/selectBufferEditorProvider.ts`

Required provider contract:

- open file at path and optional line/column
- close with clean shutdown semantics
- save and force-save
- report dirty state
- report status/error state
- handle terminal input bytes and parsed key/mouse events
- handle resize and focus changes
- emit render snapshots
- expose capabilities:
  - `vimExact`
  - `terminalUi`
  - `mouse`
  - `clipboard`
  - `dirtyState`
  - `lspPassthrough`
  - `multiBuffer`

### Embedded Neovim Runtime

Add a supervised Neovim subprocess layer.

Target files:

- `runtime/src/tui/workbench/buffer/neovim/NeovimProcess.ts`
- `runtime/src/tui/workbench/buffer/neovim/NeovimRpc.ts`
- `runtime/src/tui/workbench/buffer/neovim/NeovimUi.ts`
- `runtime/src/tui/workbench/buffer/neovim/NeovimGrid.ts`
- `runtime/src/tui/workbench/buffer/neovim/NeovimInput.ts`
- `runtime/src/tui/workbench/buffer/neovim/NeovimLifecycle.ts`

Required behavior:

- discover usable `nvim`
- reject unsupported or missing `nvim` with a clear fallback reason
- spawn `nvim --embed --clean` by default unless config explicitly opts into a
  user init
- implement msgpack-RPC request/response/notification handling
- attach as a Neovim UI with a bounded grid matching the BUFFER pane
- maintain grid cells, highlights, cursor, mode, command line, popup menu, and
  messages from UI events
- forward input, mouse, paste, focus, and resize to Neovim
- shut down cleanly on close, surface switch, app exit, crash, or parent process
  termination
- guarantee no orphaned Neovim process remains after TUI exit or test failure

### Workbench BUFFER Surface

Refactor BUFFER surface to render provider snapshots instead of assuming the
inline store.

Target files:

- `runtime/src/tui/workbench/surfaces/BufferSurface.tsx`
- `runtime/src/tui/workbench/buffer/render.tsx`
- `runtime/src/tui/workbench/buffer/useBufferStore.ts`
- `runtime/src/tui/workbench/surfaces/ActiveWorkSurface.tsx`
- `runtime/src/tui/workbench/WorkbenchFooter.tsx`

Required behavior:

- BUFFER opens Neovim-backed editor by default when Neovim is available
- the pane renders only inside its bounded workbench region
- root workbench focus and composer focus never steal editor-owned keys
- commands like `:w`, `:q`, `:q!`, `:wq`, search, visual mode, macros, registers,
  and undo are owned by Neovim, not reinterpreted by AgenC
- status/footer truthfully indicates embedded Neovim vs fallback inline mode
- fallback inline mode remains functional for environments without Neovim
- external editor remains explicit and does not conflict with embedded mode

### State And File Safety

The Neovim provider must integrate with AgenC file safety instead of bypassing
it.

Required behavior:

- open target files relative to AgenC cwd with safe absolute path resolution
- preserve existing binary/max-file rejection policy before launching embedded
  mode when possible
- track dirty state from Neovim buffer state
- update workbench active file and cursor position after Neovim cursor moves
- notify existing LSP bridge when buffers open/change/save/close if the Neovim
  provider remains responsible for AgenC-side LSP state
- handle disk changes and agent edit conflicts deterministically
- prevent close/surface switch when dirty unless user saves, discards, or force
  quits from Neovim

## Implementation Contract Rows

The implementation goal must create a checked contract matrix before coding.
Minimum required rows:

1. `provider-boundary`
   - editor provider API, capability flags, fallback selection, and no false
     exact-Vim claims.
2. `neovim-discovery`
   - binary detection, version check, config defaults, clear fallback reasons.
3. `rpc-transport`
   - msgpack-RPC framing, request IDs, notifications, errors, cancellation, and
     process death.
4. `ui-attach-grid`
   - Neovim UI attach, grid resize, linegrid events, highlights, cursor, mode,
     command line, and messages.
5. `input-routing`
   - keyboard, escape sequences, paste, mouse, focus, resize, and workbench
     keybinding ownership.
6. `buffer-lifecycle`
   - open, save, force-save, quit, force-quit, dirty close prevention, surface
     switch, app exit, crash cleanup.
7. `file-safety`
   - path resolution, binary files, max-size files, disk conflicts, in-flight
     agent edits, line-ending preservation where applicable.
8. `workbench-rendering`
   - bounded pane rendering, no overlap with explorer/agents/composer, resize,
     narrow layout, and inactive focus styling.
9. `fallback-inline`
   - current inline editor preserved as basic fallback with explicit status and
     no exact-Vim wording.
10. `external-editor`
    - explicit external editor flow still works and does not fight embedded
      Neovim lifecycle.
11. `e2e-pty`
    - full PTY coverage for edit/save/quit/search/register/macro/visual/resize
      and no orphaned Neovim processes.
12. `docs-config`
    - config knobs, environment behavior, troubleshooting, and user-visible
      fallback messages.

No row may be `partial`, `deferred`, `unknown`, `skipped`, or implemented without
edge-case assertions and an approved row review.

## Required Tests And Gates

Unit tests:

- provider selection and capability flags
- Neovim discovery/version/fallback logic
- RPC parser/framer, request resolution, notifications, error propagation
- grid reducer for every Neovim UI event used
- input translation for printable keys, modified keys, escape, paste, mouse,
  focus, and resize
- lifecycle cleanup on normal quit, force quit, crash, timeout, and parent exit

Render tests:

- BufferSurface renders embedded Neovim grid inside pane bounds
- explorer/agents/composer do not overlap or scroll with the editor pane
- command line/status/mode/cursor render correctly
- fallback inline state is labeled clearly

PTY end-to-end tests:

- launch workbench, open BUFFER, edit with Neovim insert mode, `:w`, verify file
- `:q` refuses dirty close, `:q!` discards
- `/search`, `n`, `N` visibly move cursor/highlight
- visual select/yank/paste works through Neovim
- named register basics work through Neovim
- macro record/replay works through Neovim
- resize while editing preserves grid and cursor
- mouse click/scroll route to editor pane without moving workspace rail
- kill TUI mid-edit and assert no `nvim` child remains
- missing `nvim` falls back to inline mode with a clear message

Completion gates:

- `npm run typecheck`
- `npm run check:unused:production --workspace=@tetsuo-ai/runtime`
- focused unit/render tests for every contract row
- new embedded-Neovim PTY e2e script
- `npm run check:tui-workbench-visual-smoke --workspace=@tetsuo-ai/runtime`
- `npm run build`
- `node ~/.claude/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core`
- implementation-contract checker with inventories, edge cases, approved row
  reviews, approved contract review, and row commands enabled

## Done Definition

This work is done only when:

- BUFFER uses embedded Neovim by default when available.
- Real Vim behavior is delegated to Neovim, not reimplemented in AgenC.
- The current inline editor remains only as a clearly labeled fallback.
- All lifecycle paths clean up child processes.
- All file safety and dirty-state flows are deterministic.
- Workbench panes remain visually isolated under keyboard and mouse input.
- The contract matrix and all row/contract reviews are approved.
- Every listed gate passes from a clean `main` worktree.
