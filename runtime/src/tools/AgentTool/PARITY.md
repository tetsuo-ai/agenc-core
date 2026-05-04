# T-09 AgentTool Tool Target Absorb

T-09 retires the live upstream tool targets pulled by the TUI bridge and AgentTool loader graph. The upstream mirror files for `loadAgentsDir`, `agentColorManager`, `constants`, `prompt`, `AskUserQuestionTool`, and `BriefTool/prompt` are now shims to AgenC-owned files under `runtime/src/tools/`.

The local loader keeps the upstream-shaped `AgentDefinition` contract for TUI and prompt surfaces while using AgenC's role registry for built-ins. It also preserves custom markdown agents, plugin agents, source precedence, MCP requirements, rich frontmatter and JSON metadata, memory snapshot initialization, and active-agent color initialization.

Full sub-agent execution remains tracked by `TL-12 AgentTool (delegation)`. T-09 owns the loader and prompt metadata graph, not the runtime process that executes a spawned agent.
