/**
 * Per-act completion state (onboarding-plan-2026-07 §7).
 *
 * Lives in its own small file (`<agencHome>/onboarding-acts.json`, 0600)
 * rather than the versioned first-run wizard state: acts are re-enterable
 * shell flows with their own lifecycle, and the timestamps here ARE the
 * local, consent-free funnel — nothing ever leaves the machine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type OnboardingActId = "identity" | "channel" | "autonomy";

export interface OnboardingActRecord {
  readonly completedAt: string;
  /** Act-specific breadcrumbs (workspace path, channel id, …). */
  readonly detail?: Readonly<Record<string, string>>;
}

export interface OnboardingActsState {
  readonly version: 1;
  readonly acts: Readonly<Partial<Record<OnboardingActId, OnboardingActRecord>>>;
}

const DEFAULT_STATE: OnboardingActsState = { version: 1, acts: {} };

export function onboardingActsPath(agencHome: string): string {
  return join(agencHome, "onboarding-acts.json");
}

export function readOnboardingActs(agencHome: string): OnboardingActsState {
  const path = onboardingActsPath(agencHome);
  if (!existsSync(path)) return DEFAULT_STATE;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as OnboardingActsState;
    if (raw !== null && typeof raw === "object" && raw.version === 1) {
      return { version: 1, acts: raw.acts ?? {} };
    }
  } catch {
    // Corrupt state = start fresh; acts are all re-runnable.
  }
  return DEFAULT_STATE;
}

export function markOnboardingActComplete(
  agencHome: string,
  act: OnboardingActId,
  detail?: Readonly<Record<string, string>>,
  now: Date = new Date(),
): OnboardingActsState {
  const current = readOnboardingActs(agencHome);
  const next: OnboardingActsState = {
    version: 1,
    acts: {
      ...current.acts,
      [act]: {
        completedAt: now.toISOString(),
        ...(detail !== undefined ? { detail } : {}),
      },
    },
  };
  const path = onboardingActsPath(agencHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}
