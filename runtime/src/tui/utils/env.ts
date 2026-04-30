// Cherry-picked from openclaude src/utils/env.ts.
// Minimal env helper consumed by the wholesale-ported composer utils
// (env.platform). AgenC has its own env conventions but the platform
// detection is process-level so a thin re-export of process.platform
// is sufficient.

export const env = {
  platform: process.platform,
} as const;
