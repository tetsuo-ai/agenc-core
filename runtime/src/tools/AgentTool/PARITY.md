# T-09 AgentTool Adapter Scope

T-09 removes the live TUI surfaces from `runtime/src/agenc/upstream/tools/AgentTool/loadAgentsDir.ts` and `agentColorManager.ts` by providing AgenC-owned adapter files under `runtime/src/tools/AgentTool/`.

This is not the full delegation tool implementation. Full sub-agent spawning remains tracked by `TL-12 AgentTool (delegation)`. The local `loadAgentsDir.ts` adapter intentionally projects AgenC's role registry into the upstream-shaped `AgentDefinition` catalog that the TUI needs for the agent picker and status surfaces.

The upstream mirror files are still retained for source-only upstream components that have not yet been absorbed. They are no longer imported by the T-09 scoped TUI files; the final no-upstream sweep is tracked by `T-11`.
