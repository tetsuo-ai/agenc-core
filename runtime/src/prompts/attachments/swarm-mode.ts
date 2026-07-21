/**
 * Swarm-mode attachment producer.
 *
 * While swarm mode is on (`/swarm`, persisted in user settings), inject a
 * system reminder nudging the agent to fan out divisible work to parallel
 * sub-agents by default. This is a GUIDANCE nudge only: it changes what the
 * model is told, never the permission policy — spawn_agent/multi-agent
 * calls are side-effecting and still require approval per the active
 * permission mode (yolo/bypass auto-approves them like everything else).
 *
 * The producer reads the persisted flag from user settings (the same
 * settings.json channel /swarm writes and the daemon reloads via the
 * settings watcher), so the TUI toggle takes effect on the next turn
 * without any session restart.
 *
 * @module
 */

import {
  getExecutionAuthoritySettings,
} from "../../utils/settings/settings.js";
import type { AttachmentProducer } from "./orchestrator.js";

const SWARM_MODE_REMINDER =
  "Swarm mode is active. For divisible work (multiple independent items, " +
  "areas, or hypotheses), prefer spawning parallel sub-agents " +
  "(spawn_agent / multi-agent fan-out) over grinding sequentially, then " +
  "merge their results. Keep the main thread on coordination and " +
  "verification. Spawning still follows the user's approval policy.";

export const swarmModeProducer: AttachmentProducer = async (opts) => {
  if (getExecutionAuthoritySettings().swarmMode !== true) {
    return [];
  }
  // Only nudge the main thread; a swarm child would otherwise re-read the
  // same instruction and try to fan out recursively.
  if (opts.subagentDepth !== 0) {
    return [];
  }
  return [{ kind: "critical_system_reminder", content: SWARM_MODE_REMINDER }];
};
