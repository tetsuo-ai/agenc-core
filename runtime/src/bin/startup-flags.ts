/** Canonical user-facing startup flags and permanently retired spellings. */

export const DANGEROUS_BYPASS_FLAG =
  "--dangerously-bypass-approvals-and-sandbox" as const;

export const AUTONOMOUS_FLAG = "--autonomous" as const;

const RETIRED_STARTUP_FLAG_REPLACEMENTS = Object.freeze({
  "--yolo": DANGEROUS_BYPASS_FLAG,
  "--allow-dangerously-skip-permissions": DANGEROUS_BYPASS_FLAG,
  "--proactive": AUTONOMOUS_FLAG,
} as const);

export type RetiredStartupFlag = keyof typeof RETIRED_STARTUP_FLAG_REPLACEMENTS;

export interface RetiredStartupFlagUse {
  readonly flag: RetiredStartupFlag;
  readonly replacement: string;
}

/**
 * Return the first retired startup flag in the real leading option region.
 * Positional prompt text is deliberately outside this boundary.
 */
export function findRetiredStartupFlag(
  optionArgs: readonly string[],
): RetiredStartupFlagUse | undefined {
  for (const arg of optionArgs) {
    for (const [flag, replacement] of Object.entries(
      RETIRED_STARTUP_FLAG_REPLACEMENTS,
    ) as Array<[RetiredStartupFlag, string]>) {
      if (arg === flag || arg.startsWith(`${flag}=`)) {
        return { flag, replacement };
      }
    }
  }
  return undefined;
}

export function retiredStartupFlagError(use: RetiredStartupFlagUse): string {
  return `unknown option '${use.flag}'. Use '${use.replacement}' instead.`;
}

export function assertNoRetiredStartupFlags(
  optionArgs: readonly string[],
): void {
  const use = findRetiredStartupFlag(optionArgs);
  if (use !== undefined) {
    throw new Error(retiredStartupFlagError(use));
  }
}
