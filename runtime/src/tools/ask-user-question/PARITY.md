# Ask User Question Parity

Donor reference: UI/runtime snapshot at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`
- `src/tools/AskUserQuestionTool/prompt.ts`
- `src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx`
- `src/components/permissions/PermissionRequest.tsx`

This directory owns the AgenC model-facing `AskUserQuestion` tool:
- `tool.ts` implements question parsing, strict schema, permission prompt behavior, answer consumption, and result formatting.
- `tui-tool.tsx` owns the permission/TUI rendering surface.
- Callers import the needed tool functions and types directly from `tool.ts`; no barrel module is kept for this surface.
