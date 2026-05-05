# Task Registry Parity

Donor reference: task registry and task-state sources at commit
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/tasks.ts`
- `src/Task.ts`
- `src/tasks/types.ts`
- `src/tasks/stopTask.ts`
- `src/tasks/pillLabel.ts`

This directory owns the live task registry and background-task discriminator:
- `types.ts` defines shipped task kinds, task state shapes, ID generation, and background-task filtering.
- `registry.ts` defines typed task registry lookup and lifecycle-backed kill dispatch.
- `stopTask.ts` validates and stops tasks through the registry.
- `pillLabel.ts` formats compact footer labels for background tasks.
- `lifecycle.ts` remains the in-process task owner and now reuses the shared discriminator primitives.

Executable parity lives in:
- `runtime/src/tasks/types.test.ts`
- `runtime/src/tasks/registry.test.ts`
- `runtime/src/tasks/stopTask.test.ts`
- `runtime/src/tasks/pillLabel.test.ts`
- `runtime/src/tasks/lifecycle.test.ts`
- `runtime/src/tools/tasks/task-tools.test.ts`

Deliberate omissions:
- Workflow tasks are not shipped by the live runtime.
- MCP monitor tasks are not shipped by the live runtime.
- Dream tasks are not shipped by the live runtime.
- SDK queue emission from donor task stop is not carried because the live runtime does not expose that queue outside the donor mirror.
