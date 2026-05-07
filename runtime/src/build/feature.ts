const copiedTreeFeatureFlags: Readonly<Record<string, boolean>> = {
  PROACTIVE: false,
  KAIROS: false,
  BRIDGE_MODE: false,
  DAEMON: false,
  AGENT_TRIGGERS: false,
  ABLATION_BASELINE: false,
  CONTEXT_COLLAPSE: true,
  COMMIT_ATTRIBUTION: false,
  UDS_INBOX: false,
  BG_SESSIONS: false,
  WEB_BROWSER_TOOL: false,
  CHICAGO_MCP: false,
  COWORKER_TYPE_TELEMETRY: false,
  MCP_SKILLS: true,
  REACTIVE_COMPACT: false,
  HISTORY_SNIP: false,

  COORDINATOR_MODE: true,
  BUILTIN_EXPLORE_PLAN_AGENTS: true,
  BUDDY: true,
  MONITOR_TOOL: true,
  TEAMMEM: true,
  MESSAGE_ACTIONS: true,
  DUMP_SYSTEM_PROMPT: true,
  CACHED_MICROCOMPACT: true,
  AWAY_SUMMARY: true,
  TRANSCRIPT_CLASSIFIER: true,
  ULTRATHINK: true,
  TOKEN_BUDGET: true,
  HISTORY_PICKER: true,
  QUICK_SEARCH: true,
  SHOT_STATS: true,
  EXTRACT_MEMORIES: true,
  FORK_SUBAGENT: false,
  VERIFICATION_AGENT: true,
  PROMPT_CACHE_BREAK_DETECTION: true,
  HOOK_PROMPTS: true,
};

export function feature(flag: string): boolean {
  return copiedTreeFeatureFlags[flag] ?? false;
}

export function getCopiedTreeFeatureFlags(): Readonly<Record<string, boolean>> {
  return copiedTreeFeatureFlags;
}
