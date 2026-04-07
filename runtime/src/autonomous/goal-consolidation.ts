import type { GoalStoreInput, StrategicGoalPriority, StrategicGoalRecord } from "./goal-store.js";
import { ACTIVE_GOAL_TTL_MS, isActiveGoalStatus, isTerminalGoalStatus } from "./goal-hygiene.js";

export const GOAL_DUPLICATE_SUPPRESSION_MS = 24 * 60 * 60 * 1000;
export const GOAL_REOPEN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const PRIORITY_WEIGHT: Record<StrategicGoalPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface GoalConsolidationMatch {
  readonly kind:
    | "exact_active"
    | "fuzzy_active"
    | "recent_terminal"
    | "reopen_expired"
    | "supersede_stale_active";
  readonly goal: StrategicGoalRecord;
}

export interface GoalConsolidationResult {
  readonly created: boolean;
  readonly accepted: boolean;
  readonly refreshedExisting?: StrategicGoalRecord;
  readonly supersededGoalIds: readonly string[];
  readonly rejectedReason?:
    | "duplicate_active"
    | "duplicate_recent_terminal";
}

export function normalizeGoalIdentity(title: string, description: string): string {
  return `${title}\n${description}`
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeGoalWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 0),
  );
}

export function goalSimilarity(
  leftTitle: string,
  leftDescription: string,
  rightTitle: string,
  rightDescription: string,
): number {
  const left = normalizeGoalWords(`${leftTitle} ${leftDescription}`);
  const right = normalizeGoalWords(`${rightTitle} ${rightDescription}`);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  const overlap = [...left].filter((word) => right.has(word)).length;
  return overlap / new Set([...left, ...right]).size;
}

function titleSimilarity(leftTitle: string, rightTitle: string): number {
  return goalSimilarity(leftTitle, "", rightTitle, "");
}

export function choosePriority(
  left: StrategicGoalPriority,
  right: StrategicGoalPriority,
): StrategicGoalPriority {
  return PRIORITY_WEIGHT[left] >= PRIORITY_WEIGHT[right] ? left : right;
}

export function findGoalConsolidationMatch(params: {
  readonly existingGoals: readonly StrategicGoalRecord[];
  readonly input: GoalStoreInput;
  readonly now: number;
}): GoalConsolidationMatch | undefined {
  const inputIdentity = normalizeGoalIdentity(
    params.input.title,
    params.input.description,
  );

  const exact = params.existingGoals.find((goal) => {
    if (goal.supersededByGoalId) return false;
    return goal.canonicalId === inputIdentity && isActiveGoalStatus(goal.status);
  });
  if (exact) {
    return { kind: "exact_active", goal: exact };
  }

  const fuzzyActive = params.existingGoals.find((goal) => {
    if (goal.supersededByGoalId || !isActiveGoalStatus(goal.status)) return false;
    return titleSimilarity(goal.title, params.input.title) >= 0.6 &&
      goalSimilarity(
        goal.title,
        goal.description,
        params.input.title,
        params.input.description,
      ) >= 0.82;
  });
  if (fuzzyActive) {
    return { kind: "fuzzy_active", goal: fuzzyActive };
  }

  // Audit S1.7: the recent_terminal filter must include any terminal
  // goal updated within the REOPEN window (3 days), not just within
  // the SUPPRESSION window (1 day). The previous code skipped any
  // goal older than SUPPRESSION which made the canReopen branch in
  // consolidateGoalUpdate dead code (canReopen requires updatedAt
  // older than SUPPRESSION but the filter required it newer). The
  // intended semantic is:
  //   - Within 1 day of termination: hot duplicate, suppress entirely
  //   - 1–3 days after termination: reopen the existing terminal goal
  //   - After 3 days: create a fresh goal
  const recentTerminal = params.existingGoals.find((goal) => {
    if (goal.supersededByGoalId || !isTerminalGoalStatus(goal.status)) return false;
    if (goal.updatedAt < params.now - GOAL_REOPEN_WINDOW_MS) return false;
    return goal.canonicalId === inputIdentity ||
      (titleSimilarity(goal.title, params.input.title) >= 0.7 &&
        goalSimilarity(
          goal.title,
          goal.description,
          params.input.title,
          params.input.description,
        ) >= 0.9);
  });
  if (recentTerminal) {
    return { kind: "recent_terminal", goal: recentTerminal };
  }

  const expired = params.existingGoals.find((goal) => {
    if (goal.status !== "expired") return false;
    return goal.canonicalId === inputIdentity ||
      (titleSimilarity(goal.title, params.input.title) >= 0.6 &&
        goalSimilarity(
          goal.title,
          goal.description,
          params.input.title,
          params.input.description,
        ) >= 0.82);
  });
  if (expired) {
    return { kind: "reopen_expired", goal: expired };
  }

  const staleActive = params.existingGoals.find((goal) => {
    if (goal.supersededByGoalId || !isActiveGoalStatus(goal.status)) return false;
    if (goal.freshness.expiresAt > params.now + ACTIVE_GOAL_TTL_MS / 4) return false;
    return titleSimilarity(goal.title, params.input.title) >= 0.6 &&
      goalSimilarity(
        goal.title,
        goal.description,
        params.input.title,
        params.input.description,
      ) >= 0.82;
  });
  if (staleActive) {
    return { kind: "supersede_stale_active", goal: staleActive };
  }

  return undefined;
}

export function consolidateGoalUpdate(params: {
  readonly match?: GoalConsolidationMatch;
  readonly input: GoalStoreInput;
  readonly now: number;
}): GoalConsolidationResult {
  if (!params.match) {
    return { created: true, accepted: true, supersededGoalIds: [] };
  }

  if (params.match.kind === "recent_terminal") {
    // Audit S1.7: canReopen must use SUPPRESSION (1 day) as the floor,
    // not REOPEN_WINDOW (3 days). The recent_terminal filter already
    // restricts the candidate to within REOPEN_WINDOW, so the question
    // here is whether enough time has elapsed to allow a reopen
    // instead of treating it as a hot duplicate. Within SUPPRESSION:
    // suppress entirely. Past SUPPRESSION but within REOPEN_WINDOW:
    // reopen the existing terminal goal (fall through to the default
    // branch which marks it refreshed and creates a new active goal).
    const canReopen =
      params.match.goal.updatedAt < params.now - GOAL_DUPLICATE_SUPPRESSION_MS;
    if (!canReopen) {
      return {
        created: false,
        accepted: false,
        refreshedExisting: params.match.goal,
        supersededGoalIds: [],
        rejectedReason: "duplicate_recent_terminal",
      };
    }
  }

  if (
    params.match.kind === "exact_active" ||
    params.match.kind === "fuzzy_active"
  ) {
    return {
      created: false,
      accepted: false,
      refreshedExisting: {
        ...params.match.goal,
        priority: choosePriority(params.match.goal.priority, params.input.priority),
      },
      supersededGoalIds: [],
      rejectedReason: "duplicate_active",
    };
  }

  if (params.match.kind === "supersede_stale_active") {
    return {
      created: true,
      accepted: true,
      refreshedExisting: params.match.goal,
      supersededGoalIds: [params.match.goal.id],
    };
  }

  return {
    created: true,
    accepted: true,
    refreshedExisting: params.match.goal,
    supersededGoalIds: [],
  };
}
