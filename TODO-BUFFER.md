# AgenC Workbench Editable BUFFER TODO

This plan implements the deferred editable `BUFFER` workbench surface against
the current `agenc-core` tree. The existing `TODO.md` workbench phases are
treated as already shipped; this file is the source of truth for editable files
in the terminal workbench.

## Current Codebase Map

### Existing Pieces To Reuse

- `runtime/src/tui/workbench/types.ts`
  - Owns `ActiveSurfaceMode`, `WorkbenchState`, and command shapes.
  - Needs a new `buffer` surface mode and commands for opening an editable file.

- `runtime/src/tui/workbench/reducer.ts`
  - Owns focus and surface transitions.
  - Needs `openBuffer` behavior parallel to `openPreview`, without storing
    document contents in app state.

- `runtime/src/tui/workbench/surfaces/ActiveWorkSurface.tsx`
  - Owns the surface registry.
  - Needs a `BUFFER` descriptor and renderer.

- `runtime/src/tui/workbench/surfaces/PreviewSurface.tsx`
  - Current read-only code viewer.
  - Should stay read-only and expose an edit/open-buffer action for the active
    file.

- `runtime/src/tui/workbench/project-tree/ProjectExplorer.tsx`
  - Current real explorer.
  - Should keep `enter` as read-only preview and add an explicit edit action so
    browsing a file does not accidentally enter edit mode.

- `runtime/src/tui/keybindings/defaultBindings.ts`
  - Current default workbench bindings.
  - Needs BUFFER-safe edit/save/revert/undo/redo/hover/definition actions.

- `runtime/src/tui/keybindings/types.ts`
  - Needs the new action names so user keybinding validation understands them.

- `runtime/src/services/lsp/*`
  - Reuse `LSPServerManager` for `didOpen`, `didChange`, `didSave`, hover, and
    definition.
  - Reuse `LSPDiagnosticRegistry` for diagnostic display.

- `runtime/src/tui/workbench/agents/activity.ts`
  - Reuse task path matching to detect agent in-flight edits.

- `runtime/src/tui/ink/stringWidth.ts` and `runtime/src/utils/intl.ts`
  - Reuse for wide-character cursor movement and selection behavior.

### New Files To Add

- `runtime/src/tui/workbench/buffer/BufferStore.ts`
- `runtime/src/tui/workbench/buffer/editing.ts`
- `runtime/src/tui/workbench/buffer/fileSnapshot.ts`
- `runtime/src/tui/workbench/buffer/lsp.ts`
- `runtime/src/tui/workbench/buffer/render.tsx`
- `runtime/src/tui/workbench/buffer/useBufferStore.ts`
- `runtime/src/tui/workbench/surfaces/BufferSurface.tsx`

### Existing Tests To Extend

- `runtime/tests/tui/workbench/reducer.test.ts`
- `runtime/tests/tui/workbench/commands.test.ts`
- `runtime/tests/tui/workbench/keybindings.test.ts`
- `runtime/tests/tui/workbench/render.test.tsx`
- `runtime/tests/tui/workbench/preview-surface.test.tsx`

### New Tests To Add

- `runtime/tests/tui/workbench/buffer-store.test.ts`
- `runtime/tests/tui/workbench/buffer-editing.test.ts`
- `runtime/tests/tui/workbench/buffer-surface.test.tsx`
- `runtime/tests/tui/workbench/buffer-lsp.test.ts`

## Library Decision

Use `@codemirror/state` for the underlying document/change model only.

Rationale:

- CodeMirror's state package gives persistent editor state, document text,
  selections, transactions, and change sets without requiring the browser DOM.
- CodeMirror's view package is explicitly the DOM UI layer and should not be
  mounted inside the Ink terminal renderer.
- `@codemirror/commands` pulls in `@codemirror/view`; avoid it for now and keep
  undo/redo history as a small AgenC-owned stack over `ChangeSet`.
- Do not replace the TUI framework. AgenC already has a local Ink-style
  renderer, focus system, keybinding registry, cursor declaration, PTY startup
  checks, and visual smoke gates. Replacing that substrate would be a separate
  migration, not a shortcut for BUFFER.

For the explorer/menu on the left, do not use a browser tree component. The
right follow-up is an AgenC-owned `TreeView` primitive over the existing
`ProjectTreeStore`: virtualized rows, width-aware truncation, status badges,
filtering, and reusable keybinding actions. Pulling in a terminal UI framework
or browser tree package for this one panel would be a larger renderer migration,
not a trivial improvement.

## Product Target

The target is an editable terminal code buffer embedded as an Active Work
Surface:

- `PREVIEW` remains read-only.
- `BUFFER` is the only editable code surface.
- Explorer `enter` opens preview; explorer edit binding opens buffer.
- Preview edit binding opens buffer for the active file.
- Buffer contents never live in `AppState`; document state lives in an external
  buffer store.
- User edits are explicit and never silently overwrite disk changes or agent
  in-flight edits.
- Save/revert/LSP/diagnostics are visible in the BUFFER chrome.

## Non-Negotiables

- Do not turn `PreviewSurface` into an editor.
- Do not store full file contents in `AppStateStore`.
- Do not synchronously shell out from React render.
- Do not save over an on-disk file whose mtime/content changed since the buffer
  was opened or last saved.
- Do not save while an agent task appears to be editing the same file.
- Do not pull a browser editor/view into the terminal renderer.
- Do not hide dirty, conflict, save error, or in-flight-agent state.
- Do not claim LSP integration if the buffer does not send open/change/save
  notifications and surface diagnostics.

## Phase 0: Dependency And Source Contract

- [x] Add `@codemirror/state` to `@tetsuo-ai/runtime` dependencies.
- [x] Add this TODO as the BUFFER source of truth.
- [x] Keep historical workbench `TODO.md` unchanged.

Acceptance:

- [x] `package-lock.json` reflects only the minimal CodeMirror state package
  and its direct dependency.

## Phase 1: Buffer Model And Store

- [x] Add a buffer external store with `useSyncExternalStore`.
- [x] Store per-buffer state outside app state:
  - file path
  - absolute path
  - CodeMirror `EditorState`
  - cursor/selection
  - scroll line
  - dirty flag
  - base content
  - base mtime
  - encoding
  - line endings
  - load/save status
  - error/conflict status
- [x] Implement editing commands:
  - insert text
  - replace selection
  - newline
  - backspace
  - delete
  - left/right by grapheme
  - up/down preserving display column where possible
  - start/end of line
  - top/bottom
  - page up/down
  - select with shift movement
  - clear selection on non-selection movement
- [x] Implement undo/redo with CodeMirror `ChangeSet` inverse entries.
- [x] Ensure wide characters and emoji are not split mid-grapheme.

Acceptance:

- [x] Pure model tests cover multi-line insert/delete, undo/redo, selection
  replacement, CJK width, emoji graphemes, top/bottom movement, and page
  movement.

## Phase 2: File Load, Save, Revert, And Conflict Safety

- [x] Load full editable files with size and binary guards.
- [x] Preserve UTF-8/UTF-16LE encoding where supported.
- [x] Preserve LF/CRLF line endings on save.
- [x] Save dirty buffers.
- [x] Revert from disk, discarding unsaved edits only when explicitly invoked.
- [x] Reject save when disk content changed since the buffer baseline.
- [x] Reject save when an in-flight agent task appears to reference the same
  file.
- [x] Update the buffer baseline after successful save/revert.

Acceptance:

- [x] Tests cover clean save, dirty save, no-op save, revert, deleted file,
  external mtime/content conflict, large-file rejection, binary-file rejection,
  CRLF preservation, and agent in-flight save refusal.

## Phase 3: Workbench Integration

- [x] Add `buffer` to `ActiveSurfaceMode`.
- [x] Add `openBuffer` command and command helper.
- [x] Add reducer tests for opening a buffer and preserving focus behavior.
- [x] Add `BufferSurface` to the Active Work Surface registry.
- [x] Add explorer edit binding without changing `enter` preview behavior.
- [x] Add preview edit binding without making preview editable.
- [x] Add footer/status-bar copy for BUFFER state.

Acceptance:

- [x] Existing preview behavior still opens read-only preview.
- [x] Explicit edit path opens BUFFER and focuses the active surface by default.
- [x] Keep-focus edit path does not steal explorer focus.

## Phase 4: BUFFER Surface Rendering And Input

- [x] Render line numbers, dirty/read-only/conflict status, file path, and
  current cursor location.
- [x] Render diagnostics count and current-line diagnostic text.
- [x] Render selection distinctly.
- [x] Clamp rendered text to terminal width.
- [x] Keep cursor visible while scrolling.
- [x] Handle terminal resize without cursor/selection corruption.
- [x] Implement keyboard input only when surface is focused.
- [x] Treat printable keys, including `q`, as text input in BUFFER.
- [x] Close BUFFER through an explicit chord; dirty buffers require
  save/revert/close-discard behavior.

Acceptance:

- [x] Render tests cover focused/unfocused input, dirty status, line numbers,
  selection, diagnostics, in-flight warning, narrow width, and terminal resize.

## Phase 5: LSP Integration

- [x] Send best-effort `didOpen` when a buffer opens.
- [x] Send best-effort `didChange` after edits.
- [x] Send best-effort `didSave` after saves.
- [x] Send best-effort `didClose` when the active buffer is closed or replaced.
- [x] Surface pending diagnostics through `peekLSPDiagnosticsForFile`.
- [x] Add hover request support for the current cursor position.
- [x] Add definition request support; jump to the returned file/line in BUFFER
  when the result is inside the workspace.

Acceptance:

- [x] Tests cover LSP open/change/save/close calls, diagnostic display, hover
  display, and definition jump result parsing.

## Phase 6: Validation Gates

- [x] `git diff --check`
- [x] `npm run typecheck --workspace=@tetsuo-ai/runtime`
- [x] Targeted Vitest:
  - `npm --workspace=@tetsuo-ai/runtime exec vitest run tests/tui/workbench/buffer-*.test.ts* tests/tui/workbench/reducer.test.ts tests/tui/workbench/commands.test.ts tests/tui/workbench/keybindings.test.ts tests/tui/workbench/preview-surface.test.tsx`
- [x] `npm run build --workspace=@tetsuo-ai/runtime`
- [x] `npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup`

## Rollback

- Remove `buffer` from `ActiveSurfaceMode`, `openBuffer` commands, and
  keybindings.
- Keep `PREVIEW`, `DIFF`, and Composer unchanged.
- Remove `@codemirror/state` if no other code depends on it.
