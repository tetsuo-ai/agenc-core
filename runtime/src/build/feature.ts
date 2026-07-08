const copiedTreeFeatureFlags: Readonly<Record<string, boolean>> = {
  PROACTIVE: false,
  KAIROS: false,
  BRIDGE_MODE: false,
  CONTEXT_COLLAPSE: false,
  COMMIT_ATTRIBUTION: false,
  UDS_INBOX: false,
  BG_SESSIONS: false,
  COWORKER_TYPE_TELEMETRY: false,
  MCP_SKILLS: true,
  REACTIVE_COMPACT: false,
  HISTORY_SNIP: false,

  COORDINATOR_MODE: true,
  BUILTIN_EXPLORE_PLAN_AGENTS: true,
  MONITOR_TOOL: true,
  TEAMMEM: true,
  MESSAGE_ACTIONS: true,
  CACHED_MICROCOMPACT: true,
  TRANSCRIPT_CLASSIFIER: true,
  ULTRATHINK: true,
  TOKEN_BUDGET: true,
  COMPACTION_REMINDERS: true,
  HISTORY_PICKER: true,
  QUICK_SEARCH: true,
  EXTRACT_MEMORIES: true,
  FORK_SUBAGENT: false,
  VERIFICATION_AGENT: true,
  PROMPT_CACHE_BREAK_DETECTION: true,
};

export function feature(flag: string): boolean {
  return copiedTreeFeatureFlags[flag] ?? false;
}

export function getCopiedTreeFeatureFlags(): Readonly<Record<string, boolean>> {
  return copiedTreeFeatureFlags;
}
