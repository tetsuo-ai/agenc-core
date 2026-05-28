# agents/v2 parity notes

## spawn.ts `task_name` schema description

The `spawnAgentSchema.properties.task_name` JSON-schema entry carries the
upstream description string verbatim:

> "Task name for the new agent. Use lowercase letters, digits, and underscores."

- Upstream donor: `codex-rs/tools/src/agent_tool.rs`,
  `spawn_agent_common_properties_v2`, the `task_name` property.

Without this, the model only learns the constraint via a post-hoc
`InvalidAgentPathError` from `assertValidAgentName` (registry.ts:442),
which several local models fail to map back onto their own input — they
retry the rejected name verbatim. Surfacing the constraint at
schema-discovery time lets the model pick a valid name on the first
attempt.

## spawn.ts `collab_agent_spawn_begin/end` emission ordering

`execute()` emits `collab_agent_spawn_begin` immediately after the basic
argument-shape validation (`strictArgs`, type checks, `fork_context`,
`fork_turns`, `message`-empty, `fork_mode`/role combination). Every
subsequent failure path (role validation, model-override validation,
`task_name` validation, depth check, delegate rejection) emits
`collab_agent_spawn_end` with `status: "errored"` before returning.

- Upstream donor: `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`,
  lines 52-65 (`send_event(CollabAgentSpawnBeginEvent)` immediately after
  basic arg parsing) and lines 172-189 (`send_event(CollabAgentSpawnEndEvent)`
  unconditionally with the result status, including the errored status
  on `spawn_agent_with_metadata` failure).

The previous AgenC behavior validated `task_name` BEFORE emitting Begin,
so failed-validation spawns produced no collab event pair and the
transcript fell back to rendering a generic `spawn_agent({...})` row.

## spawn.ts `buildSpawnAgentDescription` — delegation discipline block

`SPAWN_AGENT_DELEGATION_DISCIPLINE` reproduces the long-form delegation
guidance from upstream's v1 spawn_agent tool description:

- Upstream donor: `codex-rs/tools/src/agent_tool.rs`,
  `spawn_agent_tool_description` (the v1 path with `include_usage_hint`
  enabled), section bodies "When to delegate vs. do the subtask yourself",
  "Designing delegated subtasks", "After you delegate", and
  "Parallel delegation patterns".
- AgenC's v2 description had previously inherited only the v2 mechanical
  blurb (naming, model inheritance, concurrency limit), dropping the
  anti-duplication / disjoint-write-set / wait-sparingly guidance. The
  bullets are restored verbatim with one AgenC-specific addition:
  > "The spawned agent inherits its working directory from the parent
  > session and receives the same Environment section. Do NOT embed
  > absolute filesystem paths from memory in the `message` body and do NOT
  > invent project root paths."
  This bullet addresses a failure mode where local models hallucinated
  macOS-style absolute paths inside the natural-language `message` body,
  bypassing the schema-level cwd defense (`additionalProperties: false`
  on the spawn_agent JSON schema already prevents a `cwd` field; the
  bullet closes the prompt-side equivalent).

## spawn.ts `fork_turns` default

When `fork_turns` is omitted or blank, `parseForkTurns()` returns
`{ kind: "full_history" }`, matching upstream's `SpawnAgentArgs::fork_mode`
default of `"all"`:

- Upstream donor: `core/src/tools/handlers/multi_agents_v2/spawn.rs`,
  `SpawnAgentArgs::fork_mode`.
- Upstream schema donor: `core/src/tools/handlers/multi_agents_spec.rs`,
  `spawn_agent_common_properties_v2`, where `fork_turns` is documented as
  defaulting to `all`.

Use `fork_turns: "none"` for the explicit clean-fork path. Full-history forks
continue to reject `agent_type`, `model`, and `reasoning_effort` overrides so a
child that inherits parent history also inherits the parent role/model/effort.
