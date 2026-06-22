import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export {
  type ProjectOnboardingStepOptions,
  type Step,
} from "./projectOnboardingSteps.js";
import {
  isProjectOnboardingComplete,
  type ProjectOnboardingStepOptions,
} from "./projectOnboardingSteps.js";
import { asRecord } from "../utils/record.js";

const ONBOARDING_STATE_VERSION = 1;
export const DEFAULT_FIRST_RUN_SEEN_LIMIT = 4;

export type OnboardingEnv = Readonly<Record<string, string | undefined>>;

export interface ProjectOnboardingRecord {
  readonly hasCompletedProjectOnboarding: boolean;
  readonly projectOnboardingSeenCount: number;
  readonly completedAt?: string;
}

export interface FirstRunOnboardingState {
  readonly version: number;
  readonly completed: boolean;
  readonly completedAt?: string;
  readonly seenCount: number;
  readonly selectedProvider?: string;
  readonly selectedModel?: string;
  readonly selectedTheme?: string;
  readonly completedStepIds: readonly string[];
  readonly projects: Readonly<Record<string, ProjectOnboardingRecord>>;
}

export interface ReadOnboardingStateOptions {
  readonly agencHome: string;
}

export interface FirstRunDisplayOptions {
  readonly agencHome?: string;
  readonly env?: OnboardingEnv;
  readonly isInteractive?: boolean;
  readonly hasInitialPrompt?: boolean;
  readonly maxSeenCount?: number;
}

export interface MarkFirstRunCompleteOptions {
  readonly agencHome: string;
  readonly selectedProvider?: string;
  readonly selectedModel?: string;
  readonly selectedTheme?: string;
  readonly completedStepIds?: readonly string[];
  readonly now?: Date;
}

export interface ProjectOnboardingOptions {
  readonly agencHome?: string;
  readonly cwd?: string;
  readonly env?: OnboardingEnv;
  readonly maxSeenCount?: number;
  readonly stepsOptions?: ProjectOnboardingStepOptions;
  readonly now?: Date;
}

const DEFAULT_STATE: FirstRunOnboardingState = Object.freeze({
  version: ONBOARDING_STATE_VERSION,
  completed: false,
  seenCount: 0,
  completedStepIds: Object.freeze([]),
  projects: Object.freeze({}),
});

function clonedDefaultState(): FirstRunOnboardingState {
  return {
    version: DEFAULT_STATE.version,
    completed: DEFAULT_STATE.completed,
    seenCount: DEFAULT_STATE.seenCount,
    completedStepIds: [],
    projects: {},
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function projectRecord(value: unknown): ProjectOnboardingRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    hasCompletedProjectOnboarding:
      record.hasCompletedProjectOnboarding === true,
    projectOnboardingSeenCount:
      typeof record.projectOnboardingSeenCount === "number" &&
        Number.isFinite(record.projectOnboardingSeenCount)
        ? Math.max(0, Math.floor(record.projectOnboardingSeenCount))
        : 0,
    ...(stringValue(record.completedAt) !== undefined
      ? { completedAt: stringValue(record.completedAt) }
      : {}),
  };
}

function projectsFromUnknown(
  value: unknown,
): Readonly<Record<string, ProjectOnboardingRecord>> {
  const raw = asRecord(value);
  if (raw === null) return {};
  const projects: Record<string, ProjectOnboardingRecord> = {};
  for (const [key, project] of Object.entries(raw)) {
    const normalized = projectRecord(project);
    if (normalized !== null) {
      projects[key] = normalized;
    }
  }
  return projects;
}

function stateFromUnknown(value: unknown): FirstRunOnboardingState {
  const record = asRecord(value);
  if (record === null) return clonedDefaultState();
  return {
    version: ONBOARDING_STATE_VERSION,
    completed: record.completed === true,
    ...(stringValue(record.completedAt) !== undefined
      ? { completedAt: stringValue(record.completedAt) }
      : {}),
    seenCount:
      typeof record.seenCount === "number" && Number.isFinite(record.seenCount)
        ? Math.max(0, Math.floor(record.seenCount))
        : 0,
    ...(stringValue(record.selectedProvider) !== undefined
      ? { selectedProvider: stringValue(record.selectedProvider) }
      : {}),
    ...(stringValue(record.selectedModel) !== undefined
      ? { selectedModel: stringValue(record.selectedModel) }
      : {}),
    ...(stringValue(record.selectedTheme) !== undefined
      ? { selectedTheme: stringValue(record.selectedTheme) }
      : {}),
    completedStepIds: stringArray(record.completedStepIds),
    projects: projectsFromUnknown(record.projects),
  };
}

function resolveOnboardingStatePath(agencHome: string): string {
  return join(resolve(agencHome), "onboarding.json");
}

export function readOnboardingState(
  options: ReadOnboardingStateOptions,
): FirstRunOnboardingState {
  const path = resolveOnboardingStatePath(options.agencHome);
  if (!existsSync(path)) return clonedDefaultState();
  try {
    return stateFromUnknown(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return clonedDefaultState();
  }
}

function writeOnboardingState(
  options: ReadOnboardingStateOptions,
  state: FirstRunOnboardingState,
): void {
  const path = resolveOnboardingStatePath(options.agencHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function shouldShowFirstRunOnboarding(
  options: FirstRunDisplayOptions,
): boolean {
  if (options.agencHome === undefined) return false;
  if (options.hasInitialPrompt === true) return false;
  if (options.isInteractive !== true) return false;
  const flag = options.env?.AGENC_ONBOARDING?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  const state = readOnboardingState({ agencHome: options.agencHome });
  if (state.completed) return false;
  return state.seenCount < (options.maxSeenCount ?? DEFAULT_FIRST_RUN_SEEN_LIMIT);
}

export function incrementFirstRunOnboardingSeenCount(
  options: ReadOnboardingStateOptions,
): FirstRunOnboardingState {
  const state = readOnboardingState(options);
  const next = {
    ...state,
    seenCount: state.seenCount + 1,
  };
  writeOnboardingState(options, next);
  return next;
}

export function markFirstRunOnboardingComplete(
  options: MarkFirstRunCompleteOptions,
): FirstRunOnboardingState {
  const state = readOnboardingState(options);
  const next = {
    ...state,
    completed: true,
    completedAt: (options.now ?? new Date()).toISOString(),
    ...(options.selectedProvider !== undefined
      ? { selectedProvider: options.selectedProvider }
      : {}),
    ...(options.selectedModel !== undefined
      ? { selectedModel: options.selectedModel }
      : {}),
    ...(options.selectedTheme !== undefined
      ? { selectedTheme: options.selectedTheme }
      : {}),
    completedStepIds: options.completedStepIds ?? state.completedStepIds,
  };
  writeOnboardingState(options, next);
  return next;
}

function projectKey(cwd: string | undefined): string {
  return resolve(cwd ?? process.cwd());
}

function demoMode(env: OnboardingEnv | undefined): boolean {
  const source = env ?? process.env;
  const flag = source.AGENC_DEMO?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

function readProjectRecord(
  options: ProjectOnboardingOptions,
): ProjectOnboardingRecord {
  if (options.agencHome === undefined) {
    return {
      hasCompletedProjectOnboarding: false,
      projectOnboardingSeenCount: 0,
    };
  }
  return readOnboardingState({ agencHome: options.agencHome }).projects[
    projectKey(options.cwd)
  ] ?? {
    hasCompletedProjectOnboarding: false,
    projectOnboardingSeenCount: 0,
  };
}

function writeProjectRecord(
  options: ProjectOnboardingOptions & { readonly agencHome: string },
  record: ProjectOnboardingRecord,
): void {
  const state = readOnboardingState({ agencHome: options.agencHome });
  writeOnboardingState(
    { agencHome: options.agencHome },
    {
      ...state,
      projects: {
        ...state.projects,
        [projectKey(options.cwd)]: record,
      },
    },
  );
}

function projectStepOptions(
  options: ProjectOnboardingOptions,
): ProjectOnboardingStepOptions {
  const cwd = options.stepsOptions?.cwd ?? options.cwd;
  return {
    ...options.stepsOptions,
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

export function maybeMarkProjectOnboardingComplete(
  options: ProjectOnboardingOptions = {},
): void {
  if (options.agencHome === undefined) return;
  const current = readProjectRecord(options);
  if (current.hasCompletedProjectOnboarding) return;
  if (!isProjectOnboardingComplete(projectStepOptions(options))) return;
  writeProjectRecord(
    { ...options, agencHome: options.agencHome },
    {
      ...current,
      hasCompletedProjectOnboarding: true,
      completedAt: (options.now ?? new Date()).toISOString(),
    },
  );
}

export function shouldShowProjectOnboarding(
  options: ProjectOnboardingOptions = {},
): boolean {
  if (options.agencHome === undefined || demoMode(options.env)) return false;
  const current = readProjectRecord(options);
  if (current.hasCompletedProjectOnboarding) return false;
  if (
    current.projectOnboardingSeenCount >=
      (options.maxSeenCount ?? DEFAULT_FIRST_RUN_SEEN_LIMIT)
  ) {
    return false;
  }
  return !isProjectOnboardingComplete(projectStepOptions(options));
}

export function incrementProjectOnboardingSeenCount(
  options: ProjectOnboardingOptions = {},
): void {
  if (options.agencHome === undefined) return;
  const current = readProjectRecord(options);
  writeProjectRecord(
    { ...options, agencHome: options.agencHome },
    {
      ...current,
      projectOnboardingSeenCount: current.projectOnboardingSeenCount + 1,
    },
  );
}
