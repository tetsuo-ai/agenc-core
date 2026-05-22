# Workbench Implementation Goal

Implement the entire tracked `TODO.md` in `/home/tetsuo/git/AgenC/agenc-core` end to end.

Read `AGENTS.md` and `TODO.md` first. Treat `TODO.md` as the implementation contract. Do not scope this to a single phase. Complete every non-deferred phase in `TODO.md`, Phases 0 through 12, so the workbench becomes the default TUI experience after validation passes.

## Objective

Turn AgenC's current fullscreen transcript TUI into the full keyboard-first workbench described in `TODO.md`:

- gated workbench state foundation
- real project explorer
- responsive workbench layout
- Active Work Surface
- `TRANSCRIPT` surface
- `PREVIEW` code window
- `DIFF` surface and approval bridge
- `TEST` and `SHELL` surfaces
- `SEARCH` surface
- Agents rail and `AGENT` surface
- composer attachment integration
- old modal convergence
- visual and terminal QA
- enable by default only after gates pass

## Scope

- Implement Phases 0-12 from `TODO.md`.
- Do not implement the Deferred Editable `BUFFER` unless needed only as a minimal placeholder type or route.
- `PREVIEW` must be a real usable read-only code window.
- Do not stop after scaffolding.
- Do not leave stub surfaces that render "coming soon".
- Do not mark `TODO.md` items complete unless the implementation and tests actually support them.

## Architecture Constraints

- `App.tsx` owns `AlternateScreen`.
- `FullscreenLayout` remains the classic chrome/scroll/modal host for fallback mode.
- `WorkbenchLayout` owns workbench panes.
- Workbench panes must not be shoved inside the transcript `ScrollBox`.
- Cross-pane behavior must go through workbench state/reducer/commands, not direct pane-to-pane calls.
- Do not shell out synchronously from React render paths.
- Do not remove existing command modals until the matching workbench path is wired and tested.
- Keep old behavior available behind fallback until the workbench passes validation.
- Preserve existing user changes.
- Do not bypass hooks.
- Do not introduce forbidden donor/product branding terms.

## Implementation Requirements

- Add the workbench subtree proposed in `TODO.md`.
- Add minimal `AppStateStore` workbench state and external stores for large tree/search data.
- Replace the static file-tree gutter with a real interactive project tree.
- Wire keybinding contexts/actions for Workbench, Explorer, Surface, Agents, and Composer focus.
- Implement `PREVIEW` as a read-only code window with file open, scroll, jump, diagnostics, dirty/git markers, and attach support.
- Implement `DIFF` using the existing diff data sources, with honest non-mutating hunk decisions unless a real patch path exists.
- Move approval risk handling toward explicit low/medium/destructive classification and typed confirmation for destructive operations.
- Implement `SHELL` and `TEST` surfaces using existing task output helpers.
- Implement `SEARCH` using existing search behavior.
- Implement Agents rail/detail using existing task state, stop helpers, teammate helpers, and remote count fallback.
- Implement composer attachment chips/context using the existing file mention and attachment pipeline where possible.
- Convert quick open, global search, and `/diff` to open workbench surfaces when workbench mode is active, while preserving old paths when disabled.
- Add or update tests at the risk level required by `TODO.md`.

## Required Validation

Before declaring done, run:

```bash
git diff --check
npm run typecheck --workspace=@tetsuo-ai/runtime
npm run build --workspace=@tetsuo-ai/runtime
npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup
npm --workspace=@tetsuo-ai/runtime run check:tui-command-visual-smoke
node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full
```

Also run a branding scan or equivalent text check for forbidden donor/product terms in changed files, plus targeted Vitest suites for every new reducer, store, surface, keybinding, attachment, and approval behavior.

## Final Output

- Summarize every implemented phase.
- List changed files.
- List all validation commands and results.
- List any `TODO.md` items intentionally left unchecked with a concrete reason.
- Do not claim completion if any Phase 0-12 acceptance item is not actually satisfied.
