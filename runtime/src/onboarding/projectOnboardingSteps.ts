import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export type Step = {
  readonly key: string;
  readonly text: string;
  readonly isComplete: boolean;
  readonly isCompletable: boolean;
  readonly isEnabled: boolean;
};

export interface ProjectOnboardingStepOptions {
  readonly cwd?: string;
  readonly instructionFileName?: string;
  readonly exists?: (path: string) => boolean;
  readonly readdir?: (path: string) => readonly string[];
  readonly stat?: (path: string) => { isDirectory(): boolean };
}

const DEFAULT_INSTRUCTION_FILE = "AGENC.md";

function projectCwd(cwd: string | undefined): string {
  return resolve(cwd ?? process.cwd());
}

function existsAt(path: string, exists: ((path: string) => boolean) | undefined): boolean {
  try {
    return exists ? exists(path) : existsSync(path);
  } catch {
    return false;
  }
}

function isDirectory(
  path: string,
  stat: ((path: string) => { isDirectory(): boolean }) | undefined,
): boolean {
  try {
    return stat ? stat(path).isDirectory() : statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function findProjectInstructionFilePathInAncestors(
  options: ProjectOnboardingStepOptions = {},
): string | null {
  const instructionFileName = options.instructionFileName ?? DEFAULT_INSTRUCTION_FILE;
  let current = projectCwd(options.cwd);
  const root = parse(current).root;

  while (true) {
    const candidate = join(current, instructionFileName);
    if (existsAt(candidate, options.exists)) return candidate;
    if (current === root) return null;
    current = dirname(current);
  }
}

export function isDirEmpty(
  path: string,
  options: Pick<ProjectOnboardingStepOptions, "readdir" | "stat"> = {},
): boolean {
  if (!isDirectory(path, options.stat)) return false;
  try {
    const entries = options.readdir ? options.readdir(path) : readdirSync(path);
    return entries.length === 0;
  } catch {
    return false;
  }
}

export function getSteps(
  options: ProjectOnboardingStepOptions = {},
): readonly Step[] {
  const cwd = projectCwd(options.cwd);
  const hasProjectInstructions =
    findProjectInstructionFilePathInAncestors(options) !== null;
  const workspaceIsEmpty = isDirEmpty(cwd, options);

  return Object.freeze([
    {
      key: "workspace",
      text: "Ask AgenC to create a new app or clone a repository",
      isComplete: false,
      isCompletable: true,
      isEnabled: workspaceIsEmpty,
    },
    {
      key: "agencmd",
      text: "Run agenc init to add AGENC.md project instructions",
      isComplete: hasProjectInstructions,
      isCompletable: true,
      isEnabled: !workspaceIsEmpty,
    },
  ] as const);
}

export function isProjectOnboardingComplete(
  options: ProjectOnboardingStepOptions = {},
): boolean {
  return getSteps(options)
    .filter(({ isCompletable, isEnabled }) => isCompletable && isEnabled)
    .every(({ isComplete }) => isComplete);
}
