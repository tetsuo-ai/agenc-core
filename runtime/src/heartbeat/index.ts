/**
 * Heartbeat (TODO task 14, Phase 2). Periodic autonomous agent turns, bounded
 * by the task-15 budget layer. Disabled by default.
 */

export * from "./types.js";
export {
  resolveHeartbeatPolicy,
  parseActiveHours,
  parseTarget,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_HEARTBEAT_AGENT,
} from "./config.js";
export {
  HeartbeatRunner,
  heartbeatPrompt,
  type HeartbeatRunnerOptions,
} from "./runner.js";
export {
  HeartbeatScheduler,
  type HeartbeatSchedulerOptions,
} from "./scheduler.js";
export {
  WorkspaceHeartbeatFileReader,
  HEARTBEAT_FILENAME,
} from "./heartbeat-file.js";
