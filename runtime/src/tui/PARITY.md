# tui parity notes

## session-transcript.ts `COLLAB_V2_TOOL_NAMES` suppression

The `tool_call_started` / `mcp_tool_call_begin` / `exec_command_begin`
handler skips `pushToolUse` for tool names in `COLLAB_V2_TOOL_NAMES`
(`spawn_agent`, `wait_agent`, `close_agent`, `send_message`,
`followup_task`). Those tools emit their own structured collab event
pairs (`collab_agent_spawn_begin/end`, `collab_waiting_begin/end`,
`collab_close_begin/end`, `collab_agent_interaction_begin/end`) which
the transcript routes to structured `collab_agent` system rows via
`makeCollabAgentMessage(...)`.

Without the suppression, the transcript pushes BOTH a raw
`spawn_agent({"message":"...","task_name":"..."})` row AND a structured
agent lifecycle row for every spawn, producing duplicate-looking entries
that hide the agent name behind the longer `message` field in the JSON
truncation.

- Upstream donor: `codex-rs/tui/src/chatwidget.rs` line 6510-6549
  (`handle_item_started_notification` match arms): codex's TUI receives
  `ThreadItem::CollabAgentToolCall` for these tools and routes them to
  `multi_agents::tool_call_history_cell`. The generic
  `ThreadItem::FunctionCall` variant is never produced for collab tools
  by the app-server protocol mapping
  (`codex-rs/app-server-protocol/src/protocol/event_mapping.rs:75-340`,
  the `EventMsg::CollabAgent*` branches construct
  `ThreadItem::CollabAgentToolCall` items only).

`pushToolResult` already no-ops when the callId is not open, so the
matching `tool_call_completed` events for suppressed tools drop
naturally.
