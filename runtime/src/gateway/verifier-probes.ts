import { spawn } from "node:child_process";
import { accessSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { delimiter, join, resolve as resolvePath } from "node:path";

import type { AcceptanceProbeCategory } from "./subagent-orchestrator-types.js";

export type VerifierProfileKind =
  | "generic"
  | "cli"
  | "api"
  | "browser"
  | "infra";

export type VerifierBootstrapSource = "disabled" | "derived" | "fallback";

export interface ProjectVerifierBootstrap {
  readonly workspaceRoot: string;
  readonly profiles: readonly VerifierProfileKind[];
  readonly source: VerifierBootstrapSource;
  readonly rationale: readonly string[];
}

export interface VerifierRequirement {
  readonly required: boolean;
  readonly profiles: readonly VerifierProfileKind[];
  readonly probeCategories: readonly AcceptanceProbeCategory[];
  readonly mutationPolicy: "read_only_workspace";
  readonly allowTempArtifacts: boolean;
  readonly bootstrapSource: VerifierBootstrapSource;
  readonly rationale: readonly string[];
}

export interface VerificationProbeDescriptor {
  readonly id: string;
  readonly label: string;
  readonly category: AcceptanceProbeCategory;
  readonly profile: VerifierProfileKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly writesTempOnly: boolean;
}

export interface VerificationProbeExecutionResult {
  readonly probeId: string;
  readonly label: string;
  readonly category: AcceptanceProbeCategory;
  readonly profile: VerifierProfileKind;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly writesTempOnly: boolean;
}

export interface VerificationProbeCoverage {
  readonly probeIds: readonly string[];
  readonly categories: readonly AcceptanceProbeCategory[];
  readonly profiles: readonly VerifierProfileKind[];
  readonly weakProbeIds: readonly string[];
  readonly failedProbeIds: readonly string[];
}

export type VerificationProbeVerdict =
  | "pass"
  | "weak_pass"
  | "fail"
  | "not_verification";

export interface VerificationProbeAssessment {
  readonly verdict: VerificationProbeVerdict;
  readonly probeId?: string;
  readonly category?: AcceptanceProbeCategory;
  readonly profile?: VerifierProfileKind;
  readonly command?: string;
  readonly reason?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 120_000;
const WORKSPACE_SCAN_LIMIT = 256;
const WORKSPACE_SCAN_SKIP_DIRS = new Set([
  ".git",
  ".github",
  ".idea",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type CommandSpec = {
  readonly command: string;
  readonly args: readonly string[];
};

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WEAK_VERIFICATION_PATTERNS: ReadonlyArray<{
  readonly reason: string;
  readonly pattern: RegExp;
}> = [
  {
    reason: "no_tests_found",
    pattern: /\bno tests were found!?/i,
  },
];

function parseVerificationMetadata(
  result: string,
): {
  readonly parsed: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
} | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }
    const metadata =
      isPlainObject(parsed.__agencVerification)
        ? parsed.__agencVerification
        : parsed;
    return { parsed, metadata };
  } catch {
    return null;
  }
}

export function classifyVerificationProbeResult(
  result: string,
): VerificationProbeAssessment {
  const parsedResult = parseVerificationMetadata(result);
  if (!parsedResult) {
    return { verdict: "not_verification" };
  }

  const { parsed, metadata } = parsedResult;
  const probeId =
    typeof metadata.probeId === "string" && metadata.probeId.trim().length > 0
      ? metadata.probeId.trim()
      : undefined;
  const category =
    typeof metadata.category === "string"
      ? metadata.category.trim() as AcceptanceProbeCategory
      : undefined;
  const profile =
    typeof metadata.profile === "string"
      ? metadata.profile.trim() as VerifierProfileKind
      : undefined;
  const command =
    typeof metadata.command === "string" && metadata.command.trim().length > 0
      ? metadata.command.trim()
      : undefined;

  if (
    (typeof parsed.error === "string" && parsed.error.trim().length > 0) ||
    parsed.timedOut === true ||
    (typeof parsed.exitCode === "number" && parsed.exitCode !== 0)
  ) {
    return {
      verdict: "fail",
      probeId,
      category,
      profile,
      command,
    };
  }

  const stdout =
    typeof parsed.stdout === "string" ? parsed.stdout.trim() : "";
  const stderr =
    typeof parsed.stderr === "string" ? parsed.stderr.trim() : "";
  const combinedText = `${stdout}\n${stderr}`.trim();
  for (const weakPattern of WEAK_VERIFICATION_PATTERNS) {
    if (weakPattern.pattern.test(combinedText)) {
      return {
        verdict: "weak_pass",
        probeId,
        category,
        profile,
        command,
        reason: weakPattern.reason,
      };
    }
  }

  return {
    verdict: "pass",
    probeId,
    category,
    profile,
    command,
  };
}

function readJsonObject(
  path: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readPackageScripts(
  workspaceRoot: string,
): Record<string, string> {
  const manifest = readJsonObject(resolvePath(workspaceRoot, "package.json"));
  const rawScripts =
    manifest?.scripts &&
    isPlainObject(manifest.scripts)
      ? manifest.scripts
      : undefined;
  if (!rawScripts) {
    return {};
  }

  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawScripts)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    scripts[key] = value.trim();
  }
  return scripts;
}

function resolvePackageManager(
  workspaceRoot: string,
): PackageManager {
  if (existsSync(resolvePath(workspaceRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(resolvePath(workspaceRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (
    existsSync(resolvePath(workspaceRoot, "bun.lockb")) ||
    existsSync(resolvePath(workspaceRoot, "bun.lock"))
  ) {
    return "bun";
  }
  return "npm";
}

function packageManagerRunCommand(
  manager: PackageManager,
  scriptName: string,
): CommandSpec {
  if (manager === "yarn") {
    return { command: "yarn", args: [scriptName] };
  }
  if (manager === "bun") {
    return { command: "bun", args: ["run", scriptName] };
  }
  return { command: manager, args: ["run", scriptName] };
}

function hasExecutableOnPath(command: string): boolean {
  if (!command || command.trim().length === 0) {
    return false;
  }
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const candidate = join(trimmed, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Continue scanning PATH entries.
    }
  }
  return false;
}

function collectWorkspacePaths(
  workspaceRoot: string,
): readonly string[] {
  const results: string[] = [];
  const queue = [workspaceRoot];

  while (queue.length > 0 && results.length < WORKSPACE_SCAN_LIMIT) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let entries: Array<{
      readonly name: string;
      isDirectory(): boolean;
    }>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= WORKSPACE_SCAN_LIMIT) {
        break;
      }
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!WORKSPACE_SCAN_SKIP_DIRS.has(entry.name)) {
          queue.push(absolutePath);
        }
        continue;
      }
      results.push(absolutePath);
    }
  }

  return results;
}

function detectProfiles(
  workspaceRoot: string,
): ProjectVerifierBootstrap {
  const scripts = readPackageScripts(workspaceRoot);
  const scannedPaths = collectWorkspacePaths(workspaceRoot);
  const lowerPaths = scannedPaths.map((path) => path.toLowerCase());
  const profiles = new Set<VerifierProfileKind>();
  const rationale: string[] = [];

  const addProfile = (
    profile: VerifierProfileKind,
    reason: string,
  ): void => {
    if (profiles.has(profile)) {
      return;
    }
    profiles.add(profile);
    rationale.push(reason);
  };

  const hasPackageManifest = existsSync(resolvePath(workspaceRoot, "package.json"));
  const hasCargoManifest = existsSync(resolvePath(workspaceRoot, "Cargo.toml"));
  const hasCMake = existsSync(resolvePath(workspaceRoot, "CMakeLists.txt"));
  const hasMakefile =
    existsSync(resolvePath(workspaceRoot, "Makefile")) ||
    existsSync(resolvePath(workspaceRoot, "makefile"));

  if (
    typeof scripts.smoke === "string" ||
    typeof scripts["test:smoke"] === "string" ||
    hasCargoManifest ||
    hasCMake ||
    hasMakefile ||
    lowerPaths.some((path) =>
      /(?:^|\/)(?:src\/)?(?:main|cli|command)\.(?:c|cc|cpp|rs|js|mjs|cjs|ts)$/i.test(path)
    )
  ) {
    addProfile("cli", "workspace exposes a command-line entrypoint or smoke path");
  }

  if (
    typeof scripts["test:api"] === "string" ||
    typeof scripts["api:smoke"] === "string" ||
    lowerPaths.some((path) =>
      /(?:^|\/)(?:api|routes|server|handlers?)\//i.test(path) ||
      /(?:^|\/)(?:server|app|http|api)\.(?:js|mjs|cjs|ts|tsx|go|py|rb)$/i.test(path)
    )
  ) {
    addProfile("api", "workspace contains API/server entrypoints or API smoke scripts");
  }

  if (
    typeof scripts.e2e === "string" ||
    typeof scripts["test:e2e"] === "string" ||
    typeof scripts.playwright === "string" ||
    existsSync(resolvePath(workspaceRoot, "playwright.config.ts")) ||
    existsSync(resolvePath(workspaceRoot, "playwright.config.js")) ||
    lowerPaths.some((path) =>
      /(?:^|\/)(?:pages|components|app|src\/app|src\/components)\//i.test(path) ||
      /\.(?:tsx|jsx|html|css|scss)$/.test(path)
    )
  ) {
    addProfile("browser", "workspace contains browser app structure or browser test tooling");
  }

  if (
    typeof scripts["infra:validate"] === "string" ||
    typeof scripts["validate:infra"] === "string" ||
    lowerPaths.some((path) =>
      /\.tf$/i.test(path) ||
      /(?:^|\/)(?:docker-compose|compose)\.ya?ml$/i.test(path) ||
      /(?:^|\/)(?:k8s|helm|terraform|infra)\//i.test(path)
    )
  ) {
    addProfile("infra", "workspace contains infrastructure validation inputs");
  }

  if (hasPackageManifest || hasCargoManifest || hasCMake || hasMakefile) {
    addProfile("generic", "workspace exposes a repo-local build or test surface");
  }

  if (profiles.size === 0) {
    return {
      workspaceRoot,
      profiles: ["generic"],
      source: "fallback",
      rationale: ["project bootstrap could not derive a specialized verifier profile"],
    };
  }

  return {
    workspaceRoot,
    profiles: [...profiles],
    source: "derived",
    rationale,
  };
}

function pushProbe(
  probes: VerificationProbeDescriptor[],
  seen: Set<string>,
  descriptor: VerificationProbeDescriptor,
): void {
  if (seen.has(descriptor.id)) {
    return;
  }
  seen.add(descriptor.id);
  probes.push(descriptor);
}

function addNodeScriptProbes(
  probes: VerificationProbeDescriptor[],
  seen: Set<string>,
  workspaceRoot: string,
): void {
  const scripts = readPackageScripts(workspaceRoot);
  const manager = resolvePackageManager(workspaceRoot);
  if (!hasExecutableOnPath(manager)) {
    return;
  }

  const addScriptProbe = (
    category: AcceptanceProbeCategory,
    profile: VerifierProfileKind,
    scriptName: string,
    label: string,
  ): void => {
    if (typeof scripts[scriptName] !== "string") {
      return;
    }
    const command = packageManagerRunCommand(manager, scriptName);
    pushProbe(probes, seen, {
      id: `${profile}:${category}:${scriptName}`,
      label,
      category,
      profile,
      command: command.command,
      args: command.args,
      cwd: workspaceRoot,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      writesTempOnly: false,
    });
  };

  addScriptProbe("build", "generic", "build", "package build");
  addScriptProbe("typecheck", "generic", "typecheck", "package typecheck");
  addScriptProbe("lint", "generic", "lint", "package lint");
  addScriptProbe("test", "generic", "test", "package test");
  addScriptProbe("smoke", "cli", "smoke", "CLI smoke");
  addScriptProbe("smoke", "cli", "test:smoke", "CLI smoke");
  addScriptProbe("api_smoke", "api", "test:api", "API smoke");
  addScriptProbe("api_smoke", "api", "api:smoke", "API smoke");
  addScriptProbe("browser_e2e", "browser", "e2e", "browser e2e");
  addScriptProbe("browser_e2e", "browser", "test:e2e", "browser e2e");
  addScriptProbe("browser_e2e", "browser", "playwright", "browser e2e");
  addScriptProbe("infra_validate", "infra", "infra:validate", "infrastructure validate");
  addScriptProbe("infra_validate", "infra", "validate:infra", "infrastructure validate");
}

function addCMakeProbes(
  probes: VerificationProbeDescriptor[],
  seen: Set<string>,
  workspaceRoot: string,
): void {
  if (!existsSync(resolvePath(workspaceRoot, "CMakeLists.txt"))) {
    return;
  }
  if (!hasExecutableOnPath("cmake")) {
    return;
  }
  pushProbe(probes, seen, {
    id: "generic:build:cmake-configure",
    label: "cmake configure",
    category: "build",
    profile: "generic",
    command: "cmake",
    args: ["-S", ".", "-B", "build"],
    cwd: workspaceRoot,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    writesTempOnly: false,
  });
  pushProbe(probes, seen, {
    id: "generic:build:cmake-build",
    label: "cmake build",
    category: "build",
    profile: "generic",
    command: "cmake",
    args: ["--build", "build"],
    cwd: workspaceRoot,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    writesTempOnly: false,
  });
  if (hasExecutableOnPath("ctest")) {
    pushProbe(probes, seen, {
      id: "generic:test:ctest",
      label: "ctest",
      category: "test",
      profile: "generic",
      command: "ctest",
      args: ["--test-dir", "build", "--output-on-failure"],
      cwd: workspaceRoot,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      writesTempOnly: false,
    });
  }
}

function addMakeProbes(
  probes: VerificationProbeDescriptor[],
  seen: Set<string>,
  workspaceRoot: string,
): void {
  if (
    !existsSync(resolvePath(workspaceRoot, "Makefile")) &&
    !existsSync(resolvePath(workspaceRoot, "makefile"))
  ) {
    return;
  }
  if (!hasExecutableOnPath("make")) {
    return;
  }
  pushProbe(probes, seen, {
    id: "generic:build:make",
    label: "make build",
    category: "build",
    profile: "generic",
    command: "make",
    args: [],
    cwd: workspaceRoot,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    writesTempOnly: false,
  });
}

function addCargoProbes(
  probes: VerificationProbeDescriptor[],
  seen: Set<string>,
  workspaceRoot: string,
): void {
  if (!existsSync(resolvePath(workspaceRoot, "Cargo.toml"))) {
    return;
  }
  if (!hasExecutableOnPath("cargo")) {
    return;
  }
  pushProbe(probes, seen, {
    id: "generic:build:cargo-build",
    label: "cargo build",
    category: "build",
    profile: "generic",
    command: "cargo",
    args: ["build"],
    cwd: workspaceRoot,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    writesTempOnly: false,
  });
  pushProbe(probes, seen, {
    id: "generic:typecheck:cargo-check",
    label: "cargo check",
    category: "typecheck",
    profile: "generic",
    command: "cargo",
    args: ["check"],
    cwd: workspaceRoot,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    writesTempOnly: false,
  });
  pushProbe(probes, seen, {
    id: "generic:test:cargo-test",
    label: "cargo test",
    category: "test",
    profile: "generic",
    command: "cargo",
    args: ["test"],
    cwd: workspaceRoot,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    writesTempOnly: false,
  });
}

function addInfraProbes(
  probes: VerificationProbeDescriptor[],
  seen: Set<string>,
  workspaceRoot: string,
): void {
  const hasTerraform = collectWorkspacePaths(workspaceRoot).some((path) =>
    /\.tf$/i.test(path)
  );
  if (hasTerraform && hasExecutableOnPath("terraform")) {
    pushProbe(probes, seen, {
      id: "infra:infra_validate:terraform-validate",
      label: "terraform validate",
      category: "infra_validate",
      profile: "infra",
      command: "terraform",
      args: ["validate"],
      cwd: workspaceRoot,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      writesTempOnly: false,
    });
  }

  const hasCompose = collectWorkspacePaths(workspaceRoot).some((path) =>
    /(?:^|\/)(?:docker-compose|compose)\.ya?ml$/i.test(path)
  );
  if (hasCompose && hasExecutableOnPath("docker")) {
    pushProbe(probes, seen, {
      id: "infra:infra_validate:docker-compose-config",
      label: "docker compose config",
      category: "infra_validate",
      profile: "infra",
      command: "docker",
      args: ["compose", "config"],
      cwd: workspaceRoot,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      writesTempOnly: false,
    });
  }
}

function categoryOrder(): readonly AcceptanceProbeCategory[] {
  return [
    "build",
    "typecheck",
    "lint",
    "test",
    "smoke",
    "api_smoke",
    "browser_e2e",
    "infra_validate",
  ];
}

function uniqueCategories(
  categories: readonly AcceptanceProbeCategory[],
): readonly AcceptanceProbeCategory[] {
  const seen = new Set<AcceptanceProbeCategory>();
  const ordered: AcceptanceProbeCategory[] = [];
  for (const category of categories) {
    if (seen.has(category)) {
      continue;
    }
    seen.add(category);
    ordered.push(category);
  }
  return ordered;
}

function selectPreferredProbeCategories(params: {
  readonly profiles: readonly VerifierProfileKind[];
  readonly descriptors: readonly VerificationProbeDescriptor[];
}): readonly AcceptanceProbeCategory[] {
  const available = new Set(params.descriptors.map((descriptor) => descriptor.category));
  const selected: AcceptanceProbeCategory[] = [];
  const push = (category: AcceptanceProbeCategory): void => {
    if (!available.has(category) || selected.includes(category)) {
      return;
    }
    selected.push(category);
  };

  if (params.profiles.includes("generic")) {
    push("build");
    push("typecheck");
    push("lint");
    push("test");
  }
  if (params.profiles.includes("cli")) {
    push("smoke");
    push("build");
    push("test");
  }
  if (params.profiles.includes("api")) {
    push("api_smoke");
    push("test");
  }
  if (params.profiles.includes("browser")) {
    push("browser_e2e");
    push("test");
  }
  if (params.profiles.includes("infra")) {
    push("infra_validate");
  }

  if (selected.length > 0) {
    return uniqueCategories(selected);
  }

  return categoryOrder().filter((category) => available.has(category));
}

export function buildVerificationProbeDescriptors(params: {
  readonly workspaceRoot: string;
  readonly profiles?: readonly VerifierProfileKind[];
  readonly categories?: readonly AcceptanceProbeCategory[];
}): readonly VerificationProbeDescriptor[] {
  const workspaceRoot = resolvePath(params.workspaceRoot);
  const probes: VerificationProbeDescriptor[] = [];
  const seen = new Set<string>();

  addNodeScriptProbes(probes, seen, workspaceRoot);
  addCMakeProbes(probes, seen, workspaceRoot);
  addMakeProbes(probes, seen, workspaceRoot);
  addCargoProbes(probes, seen, workspaceRoot);
  addInfraProbes(probes, seen, workspaceRoot);

  const profileFilter = params.profiles && params.profiles.length > 0
    ? new Set(params.profiles)
    : undefined;
  const categoryFilter = params.categories && params.categories.length > 0
    ? new Set(params.categories)
    : undefined;

  return probes.filter((probe) => {
    if (profileFilter && !profileFilter.has(probe.profile)) {
      return false;
    }
    if (categoryFilter && !categoryFilter.has(probe.category)) {
      return false;
    }
    return true;
  });
}

export async function runVerificationProbe(
  probe: VerificationProbeDescriptor,
  options?: {
    readonly timeoutMs?: number;
  },
): Promise<VerificationProbeExecutionResult> {
  const timeoutMs = Math.max(
    1,
    Math.floor(options?.timeoutMs ?? probe.timeoutMs),
  );
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    const child = spawn(probe.command, [...probe.args], {
      cwd: probe.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        probeId: probe.id,
        label: probe.label,
        category: probe.category,
        profile: probe.profile,
        command: [probe.command, ...probe.args].join(" ").trim(),
        cwd: probe.cwd,
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        writesTempOnly: probe.writesTempOnly,
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += error instanceof Error ? error.message : String(error);
      finish(-1);
    });
    child.on("close", (code) => {
      finish(code);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }, timeoutMs);
    timer.unref();
    child.on("close", () => clearTimeout(timer));
    child.on("error", () => clearTimeout(timer));
  });
}

export function extractVerificationProbeCoverage(
  toolCalls: readonly {
    readonly name?: string;
    readonly result?: string;
  }[],
): VerificationProbeCoverage {
  const probeIds = new Set<string>();
  const categories = new Set<AcceptanceProbeCategory>();
  const profiles = new Set<VerifierProfileKind>();
  const weakProbeIds = new Set<string>();
  const failedProbeIds = new Set<string>();

  for (const toolCall of toolCalls) {
    if (toolCall.name !== "verification.runProbe") {
      continue;
    }
    if (typeof toolCall.result !== "string") {
      continue;
    }
    const assessment = classifyVerificationProbeResult(toolCall.result);
    if (assessment.verdict === "not_verification") {
      continue;
    }
    if (assessment.probeId) {
      probeIds.add(assessment.probeId);
      if (assessment.verdict === "weak_pass") {
        weakProbeIds.add(assessment.probeId);
      }
      if (assessment.verdict === "fail") {
        failedProbeIds.add(assessment.probeId);
      }
    }
    if (assessment.category) {
      categories.add(assessment.category);
    }
    if (assessment.profile) {
      profiles.add(assessment.profile);
    }
  }

  return {
    probeIds: [...probeIds],
    categories: [...categories],
    profiles: [...profiles],
    weakProbeIds: [...weakProbeIds],
    failedProbeIds: [...failedProbeIds],
  };
}

export function createVerifierRequirement(params: {
  readonly enabled: boolean;
  readonly requested?: boolean;
  readonly runtimeRequired?: boolean;
  readonly projectBootstrap?: boolean;
  readonly workspaceRoot?: string;
  readonly bootstrapCache?: Map<string, ProjectVerifierBootstrap>;
}): VerifierRequirement {
  const required = Boolean(
    params.enabled &&
      (params.requested === true || params.runtimeRequired === true),
  );
  if (!required) {
    return {
      required: false,
      profiles: [],
      probeCategories: [],
      mutationPolicy: "read_only_workspace",
      allowTempArtifacts: false,
      bootstrapSource: "disabled",
      rationale: ["verification not required for this execution"],
    };
  }

  const workspaceRoot =
    typeof params.workspaceRoot === "string" && params.workspaceRoot.trim().length > 0
      ? resolvePath(params.workspaceRoot)
      : undefined;

  let bootstrap: ProjectVerifierBootstrap | undefined;
  if (workspaceRoot && params.projectBootstrap) {
    bootstrap = params.bootstrapCache?.get(workspaceRoot);
    if (!bootstrap) {
      bootstrap = detectProfiles(workspaceRoot);
      params.bootstrapCache?.set(workspaceRoot, bootstrap);
    }
  }

  const source: VerifierBootstrapSource =
    params.projectBootstrap === true
      ? (bootstrap?.source ?? "fallback")
      : "disabled";
  const profiles: readonly VerifierProfileKind[] =
    bootstrap?.profiles && bootstrap.profiles.length > 0
      ? bootstrap.profiles
      : (["generic"] as const);
  const descriptors = workspaceRoot
    ? buildVerificationProbeDescriptors({
        workspaceRoot,
        profiles,
      })
    : [];
  const probeCategories = selectPreferredProbeCategories({
    profiles,
    descriptors,
  });

  return {
    required: true,
    profiles,
    probeCategories,
    mutationPolicy: "read_only_workspace",
    allowTempArtifacts: false,
    bootstrapSource: source,
    rationale:
      bootstrap?.rationale && bootstrap.rationale.length > 0
        ? bootstrap.rationale
        : source === "disabled"
          ? ["project-specific bootstrap is disabled"]
          : ["generic verifier fallback selected"],
  };
}
