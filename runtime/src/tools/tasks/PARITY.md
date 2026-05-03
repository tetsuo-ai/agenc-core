# Task Tools Parity

Donor reference: UI/runtime snapshot at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/tools/TaskCreateTool/TaskCreateTool.ts`
- `src/tools/TaskGetTool/TaskGetTool.ts`
- `src/tools/TaskListTool/TaskListTool.ts`
- `src/tools/TaskUpdateTool/TaskUpdateTool.ts`
- `src/tools/TaskOutputTool/TaskOutputTool.tsx`
- `src/tools/TaskStopTool/TaskStopTool.ts`

This directory owns the AgenC model-facing Task* family:
- `helpers.ts` defines strict argument handling, text results, metadata, and shared concurrency.
- `task-board.ts` implements durable project task-board tools: `TaskCreate`, `TaskGet`, `TaskUpdate`, and `TaskList`.
- `background.ts` implements lifecycle-backed background task tools: `TaskOutput` and `TaskStop`.
- `index.ts` exports the complete factory used by the model-facing registry.
