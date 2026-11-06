/**
 * Helper-request producer for Light sessions outside /swarm.
 *
 * Light's head says nothing about helpers, and `spawn_agent` loads only through `system.searchTools`, so a Light
 * model asked for helpers usually did the work itself. In the real daemon gate's helper scenario DeepSeek Flash
 * spawned helpers in 18 of 62 attempts after Light became the default (82 of 84 before), and in about a third of
 * the other answers it reported helper results that no helper produced. A turn whose root-human text explicitly
 * asks for helpers or sub-agents (agents/swarm-routing.ts requestsHelpers) carries the Light load instruction of
 * the /swarm reminder (prompts/attachments/swarm-mode.ts), while `spawn_agent` is in the session's catalog but not
 * in this request's tools. Other turns carry nothing, so their requests keep their bytes; /swarm keeps its own
 * reminder, plan mode its own rules, and children never delegate from it.
 *
 * @module
 */

import { requestsHelpers } from "../../agents/swarm-routing.js";
import { getExecutionAuthoritySettings } from "../../utils/settings/settings.js";
import type { AttachmentProducer } from "./orchestrator.js";
import { DELEGATION_PREREQUISITES } from "./swarm-mode.js";

/**
 * The reminder a helper-request turn carries. `select` is a string in every Light tool presentation. The load is
 * asked for as a response of its own: replaying the gate's first request, "load it first ... then spawn each helper"
 * still let DeepSeek Flash read the helpers' files in the same response in 4 of 20 calls (the head asks for all
 * needed reads in one response), and this wording loaded spawn_agent alone in 20 of 20 (round 4 job sub30).
 */
export const DELEGATION_REQUEST_REMINDER =
  "This request asks for helpers or sub-agents. `spawn_agent` starts deferred in this session. Make your next " +
  "response one call: `system.searchTools` with `select: \"spawn_agent\"`, which also loads `wait_agent`. Then " +
  "spawn the helpers, leave their work to them, and collect the results with `wait_agent`. If the search reports " +
  `it missing, do the work yourself and say that no helper ran. ${DELEGATION_PREREQUISITES}`;

export const delegationRequestProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  if (opts.lightMode !== true || opts.subagentDepth !== 0) return [];
  // Only the turn's first request reads its text; the retention ledger keeps the reminder in place after that.
  const turn = opts.turnProvenance;
  if (
    turn === undefined ||
    turn.turnId.length === 0 ||
    trackingState.lastDelegationRequestTurnId === turn.turnId
  ) {
    return [];
  }
  trackingState.lastDelegationRequestTurnId = turn.turnId;
  // A synthetic or mailbox follow-up has no root-human text of its own.
  const root = turn.rootHumanTurn;
  if (root === null || root.turnId !== turn.turnId) return [];
  if (opts.permissionContext.mode === "plan") return [];
  const loaded = new Set(opts.loadedTools.map((tool) => tool.function.name));
  if (loaded.has("spawn_agent") || !loaded.has("system.searchTools")) return [];
  // The text first: an ordinary turn never queries the catalog or the settings.
  if (!requestsHelpers(root.text)) return [];
  if (opts.catalogIncludes?.("spawn_agent") !== true) return [];
  if (getExecutionAuthoritySettings().swarmMode === true) return [];
  return [{ kind: "critical_system_reminder", content: DELEGATION_REQUEST_REMINDER }];
};
