import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgenCConfig } from "./schema.js";
import { defaultConfig } from "./schema.js";

export const PROJECT_CONFIG_DIR = ".agenc";
export const PROJECT_CONFIG_FILENAME = "config.json";
export const PROJECT_INSTRUCTIONS_FILENAME = "AGENC.md";

const PROJECT_INSTRUCTIONS_TEMPLATE = `# Repository Guidelines

Fill this file with the project-specific guidance AgenC should follow in this repository. Keep only facts that are hard to infer from the source tree.

## Build, Test, and Development Commands
- Add the commands for building, testing, linting, and running the project locally.

## Project Structure
- Add the important source, test, fixture, and generated-code locations.

## Coding Conventions
- Add conventions that differ from language defaults or formatter output.

## Testing Notes
- Add test names, flags, fixtures, or setup steps that are easy to miss.

## Operational Notes
- Add required environment variables, local services, release steps, or project-specific safety constraints.
`;

export interface ProjectInitFileResult {
  readonly path: string;
  readonly relativePath: string;
  readonly status: "created" | "skipped" | "overwritten";
}

export interface ProjectInitResult {
  readonly cwd: string;
  readonly files: readonly ProjectInitFileResult[];
}

export interface InitializeAgenCProjectOptions {
  readonly cwd: string;
  readonly force?: boolean;
  readonly instructionsTemplate?: string;
  readonly config?: Partial<AgenCConfig>;
}

function createDefaultProjectConfig(): Partial<AgenCConfig> {
  const defaults = defaultConfig();
  return {
    configVersion: defaults.configVersion,
    model_provider: defaults.model_provider,
    model: defaults.model,
    approval_policy: defaults.approval_policy,
    sandbox: defaults.sandbox,
    project_root_markers: defaults.project_root_markers,
  };
}

function serializeProjectConfig(
  config: Partial<AgenCConfig> = createDefaultProjectConfig(),
): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function initializeAgenCProject(
  options: InitializeAgenCProjectOptions,
): Promise<ProjectInitResult> {
  const force = options.force === true;
  const configDir = join(options.cwd, PROJECT_CONFIG_DIR);
  await mkdir(configDir, { recursive: true });

  const configPath = join(configDir, PROJECT_CONFIG_FILENAME);
  const instructionsPath = join(options.cwd, PROJECT_INSTRUCTIONS_FILENAME);

  const files = [
    await writeProjectFile({
      cwd: options.cwd,
      path: configPath,
      contents: serializeProjectConfig(options.config),
      force,
    }),
    await writeProjectFile({
      cwd: options.cwd,
      path: instructionsPath,
      contents: options.instructionsTemplate ?? PROJECT_INSTRUCTIONS_TEMPLATE,
      force,
    }),
  ];

  return { cwd: options.cwd, files };
}

export function formatProjectInitResult(result: ProjectInitResult): string {
  const allSkipped = result.files.every((file) => file.status === "skipped");
  const header = allSkipped
    ? `AgenC project already initialized in ${result.cwd}`
    : `Initialized AgenC project in ${result.cwd}`;
  const lines = result.files.map((file) => {
    const verb = file.status === "created"
      ? "created"
      : file.status === "overwritten"
        ? "overwrote"
        : "kept";
    return `  ${verb} ${file.relativePath}`;
  });
  return [header, ...lines].join("\n");
}

async function writeProjectFile(params: {
  readonly cwd: string;
  readonly path: string;
  readonly contents: string;
  readonly force: boolean;
}): Promise<ProjectInitFileResult> {
  const relativePath = relative(params.cwd, params.path);
  if (params.force) {
    const existed = await exists(params.path);
    await writeFile(params.path, params.contents, "utf8");
    return {
      path: params.path,
      relativePath,
      status: existed ? "overwritten" : "created",
    };
  }

  try {
    await writeFile(params.path, params.contents, {
      encoding: "utf8",
      flag: "wx",
    });
    return { path: params.path, relativePath, status: "created" };
  } catch (error) {
    if (getErrnoCode(error) === "EEXIST") {
      return { path: params.path, relativePath, status: "skipped" };
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

function getErrnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
