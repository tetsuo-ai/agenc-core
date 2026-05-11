# agents/v2 parity notes

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
