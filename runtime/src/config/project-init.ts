import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgenCConfig } from "./schema.js";
import { defaultConfig } from "./schema.js";

export const PROJECT_CONFIG_DIR = ".agenc";
export const PROJECT_CONFIG_FILENAME = "config.json";
export const PROJECT_INSTRUCTIONS_FILENAME = "AGENC.md";

const README_CANDIDATES = [
  "README.md",
  "README.mdx",
  "README.txt",
  "README",
] as const;

const COMMON_MANIFESTS = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "deno.jsonc",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.config.mts",
  "playwright.config.ts",
  "eslint.config.js",
  "eslint.config.mjs",
  "prettier.config.js",
  "prettier.config.mjs",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "Makefile",
  "justfile",
  "Justfile",
  "Dockerfile",
  "docker-compose.yml",
  "compose.yml",
  ".env.example",
] as const;

const INTERESTING_DIRS: Readonly<Record<string, string>> = Object.freeze({
  app: "application entrypoints",
  apps: "application packages",
  bin: "CLI entrypoints",
  cli: "CLI code",
  config: "configuration code",
  docs: "documentation",
  examples: "examples",
  fixtures: "test fixtures",
  lib: "library code",
  packages: "workspace packages",
  scripts: "automation scripts",
  src: "source code",
  test: "tests",
  tests: "tests",
  runtime: "runtime implementation",
});

const SCRIPT_PRIORITY = [
  "build",
  "typecheck",
  "test",
  "test:unit",
  "test:e2e",
  "lint",
  "format",
  "dev",
  "start",
  "validate",
  "validate:runtime",
] as const;

const MAX_README_BYTES = 24_000;
const MAX_MANIFEST_BYTES = 48_000;
const MAX_COMMANDS = 14;
const MAX_ENV_NAMES = 16;

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

interface PackageJsonShape {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly packageManager?: unknown;
  readonly engines?: unknown;
  readonly scripts?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly workspaces?: unknown;
}

interface DetectedFile {
  readonly path: string;
  readonly content?: string;
}

interface ProjectAnalysis {
  readonly projectName?: string;
  readonly packageManager: string;
  readonly readmeSummary?: string;
  readonly detectedFiles: readonly string[];
  readonly topLevelDirs: readonly string[];
  readonly commands: readonly string[];
  readonly structureNotes: readonly string[];
  readonly conventionNotes: readonly string[];
  readonly testingNotes: readonly string[];
  readonly operationalNotes: readonly string[];
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
      contents:
        options.instructionsTemplate ??
        await buildProjectInstructionsFromAnalysis(options.cwd),
      force,
    }),
  ];

  return { cwd: options.cwd, files };
}

export async function buildProjectInstructionsFromAnalysis(
  cwd: string,
): Promise<string> {
  const analysis = await analyzeProject(cwd);
  return formatProjectInstructions(analysis);
}

async function analyzeProject(cwd: string): Promise<ProjectAnalysis> {
  const [files, topLevelDirs, readme] = await Promise.all([
    readDetectedFiles(cwd),
    readTopLevelDirs(cwd),
    readFirstExisting(cwd, README_CANDIDATES, MAX_README_BYTES),
  ]);
  const fileMap = new Map(files.map((file) => [file.path, file.content ?? ""]));
  const packageJson = parsePackageJson(fileMap.get("package.json"));
  const packageManager = detectPackageManager(fileMap, packageJson);
  const commands = collectCommands(fileMap, packageJson, packageManager);
  const envNames = collectEnvironmentNames(readme?.content ?? "");

  return {
    ...(typeof packageJson?.name === "string" && packageJson.name.length > 0
      ? { projectName: packageJson.name }
      : {}),
    packageManager,
    ...(readme !== undefined
      ? { readmeSummary: summarizeReadme(readme.content ?? "") }
      : {}),
    detectedFiles: files.map((file) => file.path),
    topLevelDirs,
    commands,
    structureNotes: collectStructureNotes(topLevelDirs, packageJson),
    conventionNotes: collectConventionNotes(fileMap, packageJson, packageManager),
    testingNotes: collectTestingNotes(fileMap, packageJson, commands),
    operationalNotes: collectOperationalNotes(fileMap, packageJson, envNames),
  };
}

function formatProjectInstructions(analysis: ProjectAnalysis): string {
  const lines: string[] = [
    "# Repository Guidelines",
    "",
    "This file captures project guidance inferred from local repository files. Review it after initialization and keep only durable, project-specific facts.",
    "",
  ];
  if (analysis.projectName !== undefined || analysis.readmeSummary !== undefined) {
    lines.push("## Project Overview");
    if (analysis.projectName !== undefined) {
      lines.push(`- Project/package name: ${analysis.projectName}.`);
    }
    if (analysis.readmeSummary !== undefined) {
      lines.push(`- README summary: ${analysis.readmeSummary}`);
    }
    lines.push("");
  }

  lines.push("## Build, Test, and Development Commands");
  if (analysis.commands.length === 0) {
    lines.push("- No common build/test/lint commands were detected. Add the canonical local commands here.");
  } else {
    for (const command of analysis.commands) {
      lines.push(`- \`${command}\``);
    }
  }
  lines.push("");

  lines.push("## Project Structure");
  if (analysis.structureNotes.length === 0) {
    lines.push("- No common source/test directories were detected at the repository root.");
  } else {
    lines.push(...analysis.structureNotes.map((note) => `- ${note}`));
  }
  if (analysis.detectedFiles.length > 0) {
    lines.push(`- Detected project files: ${analysis.detectedFiles.join(", ")}.`);
  }
  lines.push("");

  lines.push("## Coding Conventions");
  if (analysis.conventionNotes.length === 0) {
    lines.push("- Follow the conventions already present in nearby files.");
  } else {
    lines.push(...analysis.conventionNotes.map((note) => `- ${note}`));
  }
  lines.push("");

  lines.push("## Testing Notes");
  if (analysis.testingNotes.length === 0) {
    lines.push("- Add focused tests for behavior changes and run the relevant local test command before handing work off.");
  } else {
    lines.push(...analysis.testingNotes.map((note) => `- ${note}`));
  }
  lines.push("");

  lines.push("## Operational Notes");
  if (analysis.operationalNotes.length === 0) {
    lines.push("- Document required environment variables, local services, release steps, and safety constraints as they are discovered.");
  } else {
    lines.push(...analysis.operationalNotes.map((note) => `- ${note}`));
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function readDetectedFiles(cwd: string): Promise<DetectedFile[]> {
  const files: DetectedFile[] = [];
  for (const candidate of COMMON_MANIFESTS) {
    const content = await readOptionalFile(join(cwd, candidate), MAX_MANIFEST_BYTES);
    if (content !== undefined) {
      files.push({ path: candidate, content });
    }
  }
  return files;
}

async function readFirstExisting(
  cwd: string,
  candidates: readonly string[],
  maxBytes: number,
): Promise<DetectedFile | undefined> {
  for (const candidate of candidates) {
    const content = await readOptionalFile(join(cwd, candidate), maxBytes);
    if (content !== undefined) return { path: candidate, content };
  }
  return undefined;
}

async function readOptionalFile(
  path: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const buf = await readFile(path);
    return buf.subarray(0, maxBytes).toString("utf8");
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT" || getErrnoCode(error) === "EISDIR") {
      return undefined;
    }
    throw error;
  }
}

async function readTopLevelDirs(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && name !== "node_modules")
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

function parsePackageJson(content: string | undefined): PackageJsonShape | null {
  if (content === undefined) return null;
  try {
    const parsed = JSON.parse(content) as PackageJsonShape;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function detectPackageManager(
  files: ReadonlyMap<string, string>,
  pkg: PackageJsonShape | null,
): string {
  if (typeof pkg?.packageManager === "string") {
    const [name] = pkg.packageManager.split("@");
    if (name) return name;
  }
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("package-lock.json") || files.has("package.json")) return "npm";
  return "npm";
}

function collectCommands(
  files: ReadonlyMap<string, string>,
  pkg: PackageJsonShape | null,
  packageManager: string,
): string[] {
  const commands: string[] = [];
  const scripts = isRecord(pkg?.scripts) ? pkg.scripts : {};
  const scriptNames = Object.keys(scripts).filter(
    (name) => typeof scripts[name] === "string",
  );
  const sortedScripts = [
    ...SCRIPT_PRIORITY.filter((name) => scriptNames.includes(name)),
    ...scriptNames
      .filter((name) => !SCRIPT_PRIORITY.includes(name as never))
      .sort((a, b) => a.localeCompare(b)),
  ];
  for (const script of sortedScripts.slice(0, MAX_COMMANDS)) {
    commands.push(`${packageManager} run ${script}`);
  }
  if (files.has("Makefile")) {
    commands.push(...parseMakeTargets(files.get("Makefile")!).map((target) => `make ${target}`));
  }
  if (files.has("justfile") || files.has("Justfile")) {
    const just = files.get("justfile") ?? files.get("Justfile") ?? "";
    commands.push(...parseJustTargets(just).map((target) => `just ${target}`));
  }
  if (files.has("Cargo.toml")) {
    commands.push("cargo build", "cargo test");
  }
  if (files.has("go.mod")) {
    commands.push("go test ./...");
  }
  if (files.has("pyproject.toml") || files.has("requirements.txt")) {
    commands.push("python -m pytest");
  }
  return [...new Set(commands)].slice(0, MAX_COMMANDS);
}

function collectStructureNotes(
  dirs: readonly string[],
  pkg: PackageJsonShape | null,
): string[] {
  const notes = dirs
    .filter((dir) => INTERESTING_DIRS[dir] !== undefined)
    .map((dir) => `\`${dir}/\` contains ${INTERESTING_DIRS[dir]}.`);
  if (pkg?.workspaces !== undefined) {
    notes.push("This appears to be a JavaScript/TypeScript workspace; inspect each workspace package before cross-package changes.");
  }
  return notes;
}

function collectConventionNotes(
  files: ReadonlyMap<string, string>,
  pkg: PackageJsonShape | null,
  packageManager: string,
): string[] {
  const notes: string[] = [];
  if (typeof pkg?.type === "string") {
    notes.push(`package.json declares \`type: ${pkg.type}\`; preserve that module style.`);
  }
  const engines = isRecord(pkg?.engines) ? pkg.engines : null;
  const nodeEngine = engines && typeof engines.node === "string"
    ? engines.node
    : undefined;
  if (nodeEngine !== undefined) {
    notes.push(`Node.js engine requirement: \`${nodeEngine}\`.`);
  }
  if (files.has("tsconfig.json")) {
    notes.push("TypeScript is configured; keep typechecking clean for touched code.");
  }
  if (files.has("eslint.config.js") || files.has("eslint.config.mjs")) {
    notes.push("ESLint config is present; follow existing lint rules.");
  }
  if (files.has("prettier.config.js") || files.has("prettier.config.mjs")) {
    notes.push("Prettier config is present; keep formatting consistent.");
  }
  if (files.has("package.json")) {
    notes.push(`Use \`${packageManager}\` for package scripts unless local docs say otherwise.`);
  }
  return notes;
}

function collectTestingNotes(
  files: ReadonlyMap<string, string>,
  pkg: PackageJsonShape | null,
  commands: readonly string[],
): string[] {
  const notes: string[] = [];
  const scriptText = JSON.stringify(isRecord(pkg?.scripts) ? pkg.scripts : {});
  if (commands.some((command) => /\btest\b/.test(command))) {
    notes.push("Run the relevant test script for changed behavior before handing off.");
  }
  if (files.has("vitest.config.ts") || files.has("vitest.config.mts") || /vitest/.test(scriptText)) {
    notes.push("Vitest appears to be the test runner.");
  }
  if (files.has("playwright.config.ts") || /playwright/.test(scriptText)) {
    notes.push("Playwright configuration is present for browser/e2e coverage.");
  }
  if (files.has("Cargo.toml")) {
    notes.push("Rust changes should pass `cargo test`.");
  }
  if (files.has("go.mod")) {
    notes.push("Go changes should pass `go test ./...`.");
  }
  return notes;
}

function collectOperationalNotes(
  files: ReadonlyMap<string, string>,
  pkg: PackageJsonShape | null,
  envNames: readonly string[],
): string[] {
  const notes: string[] = [];
  if (envNames.length > 0) {
    notes.push(`README mentions environment variables: ${envNames.map((name) => `\`${name}\``).join(", ")}.`);
  }
  if (files.has(".env.example")) {
    notes.push("A `.env.example` file is present; use it as the local environment template.");
  }
  if (files.has("Dockerfile") || files.has("docker-compose.yml") || files.has("compose.yml")) {
    notes.push("Container configuration is present; check it before changing service startup assumptions.");
  }
  const deps = [
    ...Object.keys(isRecord(pkg?.dependencies) ? pkg.dependencies : {}),
    ...Object.keys(isRecord(pkg?.devDependencies) ? pkg.devDependencies : {}),
  ];
  if (deps.some((name) => name.includes("dotenv"))) {
    notes.push("Environment-file loading dependencies are present; avoid committing real secrets.");
  }
  return notes;
}

function summarizeReadme(content: string): string | undefined {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => /^#\s+\S/.test(line));
  const firstParagraph = lines.find(
    (line) =>
      line.length > 0 &&
      !line.startsWith("#") &&
      !line.startsWith("[!") &&
      !line.startsWith("<!--"),
  );
  const summary = [heading?.replace(/^#\s+/, ""), firstParagraph]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" - ");
  if (summary.length === 0) return undefined;
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

function collectEnvironmentNames(content: string): string[] {
  const matches = content.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_API_KEY|_TOKEN|_SECRET|_URL|_HOME|_MODEL|_KEY|_HOST|_PORT)\b/g) ?? [];
  return [...new Set(matches)].sort().slice(0, MAX_ENV_NAMES);
}

function parseMakeTargets(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z0-9_.-]+):(?:\s|$)/)?.[1])
    .filter((target): target is string =>
      target !== undefined &&
      !target.startsWith(".") &&
      ["build", "test", "lint", "check", "format", "dev"].includes(target)
    )
    .slice(0, 6);
}

function parseJustTargets(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z0-9_-]+)(?:\s.*)?:$/)?.[1])
    .filter((target): target is string =>
      target !== undefined &&
      ["build", "test", "lint", "check", "format", "dev"].includes(target)
    )
    .slice(0, 6);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
