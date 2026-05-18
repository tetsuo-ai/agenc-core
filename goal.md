# Goal: Replace AgenC TUI Visual Layer From Design Bundle

## Objective

Fetch this design file, read its README, and implement the relevant aspects of the design:

`https://api.anthropic.com/v1/design/h/ffNqVHYexickEtXSQWjZRA?open_file=AgenC+TUI.html`

Replace the entire visual layer of the AgenC TUI with the design in this bundle. The mockups already use React components; they port almost 1:1 to the Ink renderer.

## Stack Already In Place

Do not rewrite these systems:

- Entry: `runtime/src/tui/main.tsx`
- Shell: `runtime/src/tui/components/App.tsx`
- Renderer: `runtime/src/tui/ink/`
- Theme: `runtime/src/utils/theme.ts`
- Event log, session store, command registry, MCP manager, keybinding system, permission engine, AppStateStore

The previous `runtime/src/tui/components/` tree, minus `App.tsx`, is being deleted.

## Required Reading Order

Read the bundle in this order, top to bottom, before writing any code:

1. `TUI-RUNTIME-SYNC.md`
   - This is the implementation contract and the most important file.
   - It maps every mockup primitive to the existing `Box`/`Text` API.
   - It names every theme token to add.
   - It lists which slash commands to register.
   - It tells which data store each menu binds to.
   - Answer the five "open questions" at the end of this doc in the final implementation summary or PR description.

2. `TUI-IMPLEMENTATION.md`
   - Explains how each visual decomposes to ANSI primitives, including box-drawing chars, cell colors, and cursor shapes.
   - Use this whenever tempted to add a CSS-ism.
   - If it has no terminal equivalent, do not implement it.
   - This is non-negotiable.

3. `TUI-UX-RESEARCH.md`
   - UX brief with citations to current coding-agent terminal tools.
   - Use it as the tiebreaker for behavior decisions.
   - The patterns the state of the art has converged on are the floor, not the ceiling.

4. `AgenC TUI.html` and the JSX sources:
   - `tui-frame.jsx`
   - `tui-v2-prim.jsx`
   - `tui-v2-states.jsx`
   - `tui-v2-states-extra.jsx`
   - `tui-v2-states-runtime.jsx`
   - `tui-v2-menus.jsx`

The visual source of truth is every numbered window, `01a` through `19c`. The component structure ports directly:

- Swap `<div style={...}>` for `<Box>`.
- Swap `<span style={{ color }}>` for `<Text color={token}>`.
- Lift inline colors to named theme tokens.
- Keep prop shapes identical.

## Required Pre-Code Confirmation

Before writing any code, confirm that `TUI-RUNTIME-SYNC.md` has been read and list the five open questions from it so the reviewer knows they were seen.

## Non-Negotiables

The mockups have already been stripped of anything not terminal-renderable:

- No drop shadows.
- No glows.
- No gradients.
- No backdrop blur.
- No rounded corners on internal panels.
- No pill buttons.
- If a `Box` in the build has any of these, the mockup is right and the implementation is wrong.
- Use one monospace font: Geist Mono.
- Use one cell per glyph.
- The "brand bleed" in the corner of every window is a literal grid of `░`, `▒`, and `▓` characters with per-cell foreground colors. Render it as a small component that emits cells, not as a gradient.
- Three animations only:
  - caret blink at the prompt
  - streaming tokens arriving in chat
  - `◐` running indicator on in-flight tool calls
- Nothing else moves.
- Hex colors never appear inline.
- Everything resolves through `runtime/src/utils/theme.ts`.
- Add the new tokens listed in `TUI-RUNTIME-SYNC.md` section 2 to every theme variant, including daltonized and ANSI variants.

## Build Sequence

Use the build sequence from `TUI-RUNTIME-SYNC.md` section 10, ranked by dependency:

1. Add theme tokens to all variants.
2. Add the mode pill in the header, wired to `permissionMode`; `Shift+Tab` cycles it.
3. Build the terminal frame: header, status bar, and prompt matching state `01` exactly. This is the single source every other state composes into.
4. Consolidate the slash registry:
   - Register `/model`
   - Register `/provider`
   - Register `/hooks`
   - Register `/compact`
   - Register `/plugins`
   - Register `/memory`
   - Register `/resume`
   - Add AgenC protocol extensions as a new `agenc-core` plugin:
     - `/claim`
     - `/delegate`
     - `/proof`
     - `/settle`
     - `/stake`
5. Implement `<MenuModal>` as one component with eight data bindings:
   - `/model`
   - `/skills`
   - `/mcp`
   - `/hooks`
   - `/plugins`
   - `/agents`
   - `/permissions`
   - `/memory`
6. Implement the conversation renderer against the existing event log:
   - `<Msg>`
   - `<Tool>`
   - `<DiffInline>`
   - `<PlanList>`
   - `<ApprovalCard>`
   - Delete old components in `messages/` and `permissions/`; do not refactor them.
7. Implement file picker `@`, shell mode `!`, and streaming Markdown renderer.
8. Implement `/ctx` modal bound to `token_count` events plus local estimate.
9. Replace `BackgroundTasksDialog.tsx` with the background tasks panel.
10. Add plan-mode banner and accept flow. It renders only when `permissionMode === "plan"`.
11. Add new on-chain event types to the event log union:
    - `protocol_claim`
    - `protocol_settle`
    - `protocol_slash`
    - `protocol_stake`
12. Render those protocol events inline as `<Msg role="system">` with badge variants.
13. Smoke test at:
    - `148x40`
    - `120x30`
    - `80x24` with truncation

## Acceptance Criteria

Every numbered window in `AgenC TUI.html`, `01a` through `19c`, must reproduce in the running TUI at `148x40` with no visual drift from the mockup.

Full acceptance criteria are in `TUI-RUNTIME-SYNC.md` section 11.

When in doubt, the mockup wins. If a behavior is ambiguous, `TUI-UX-RESEARCH.md` is the tiebreaker. If a runtime concept does not match the mockup, raise it in the final implementation summary or PR description. Do not silently diverge.

## Repository Rules To Preserve

- Follow `AGENTS.md`, `GOAL_DISCIPLINE.md`, `PORT_CHECKLIST.md`, `.agenc/AGENC.md`, and `/home/tetsuo/git/AgenC/CLAUDE.md` as compatibility workspace context.
- Current local project instruction says: commit locally on `main` only.
- Do not create branches, worktrees, merges, rebases, pushes, pulls, fetches, or syncs.
- Never bypass hooks.
- Never hand-edit `PORT_CHECKLIST.md` rows.
- Keep AgenC branding in AgenC-owned code.
- Do not introduce donor-project brand identifiers into AgenC-owned identifiers, strings, comments, errors, logs, filenames, env vars, protocol names, commit text, or docs, except where explicitly allowlisted by existing project tooling.

## Final Output Requirements

The final summary must include:

- Confirmation that the design bundle was fetched and read in the required order.
- The five open questions from `TUI-RUNTIME-SYNC.md` and the implementation answers.
- Files changed.
- Validation commands run, including the three viewport smoke tests.
- Any intentional divergences from the mockup or runtime mismatch notes.
