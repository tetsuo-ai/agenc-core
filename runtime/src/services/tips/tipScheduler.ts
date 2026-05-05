/**
 * Source-aligned with `src/services/tips/tipScheduler.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Shape differences:
 *   - AgenC reads settings/history/analytics through `TipContext` so the
 *     scheduler can run in CLI, SDK, and tests without donor singletons.
 */

import { getSessionsSinceLastShown, recordTipShown } from "./tipHistory.js";
import { getRelevantTips } from "./tipRegistry.js";
import type { Tip, TipContext, TipHistoryOptions } from "./types.js";

export function selectTipWithLongestTimeSinceShown(
  availableTips: readonly Tip[],
  historyOptions?: TipHistoryOptions,
): Tip | undefined {
  if (availableTips.length === 0) {
    return undefined;
  }

  if (availableTips.length === 1) {
    return availableTips[0];
  }

  const tipsWithSessions = availableTips.map((tip) => ({
    tip,
    sessions: getSessionsSinceLastShown(tip.id, historyOptions),
  }));

  tipsWithSessions.sort((a, b) => b.sessions - a.sessions);
  return tipsWithSessions[0]?.tip;
}

export async function getTipToShowOnSpinner(
  context?: TipContext,
): Promise<Tip | undefined> {
  if (context?.settings?.spinnerTipsEnabled === false) {
    return undefined;
  }

  const tips = await getRelevantTips(context);
  if (tips.length === 0) {
    return undefined;
  }

  return selectTipWithLongestTimeSinceShown(tips, context?.history);
}

export function recordShownTip(tip: Tip, context?: TipContext): void {
  recordTipShown(tip.id, context?.history);

  context?.analytics?.logEvent?.("agenc_tip_shown", {
    tipId: tip.id,
    tipIdLength: tip.id.length,
    cooldownSessions: tip.cooldownSessions,
  });
}
