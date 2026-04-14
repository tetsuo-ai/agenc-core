/**
 * Semantic key building, recovery hints, and stateful summary functions for ChatExecutor.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type {
  ToolCallRecord,
  RecoveryHint,
  ChatCallUsageRecord,
  ChatStatefulSummary,
} from "./chat-executor-types.js";
import type { LLMStatefulDiagnostics, LLMStatefulFallbackReason } from "./types.js";
import { createLLMStatefulFallbackReasonCounts } from "./types.js";
import { SHELL_BUILTIN_COMMANDS } from "./chat-executor-constants.js";
import {
  didToolCallFail,
  extractToolFailureText,
  parseToolResultObject,
} from "./chat-executor-tool-utils.js";

const NON_ACTIONABLE_STATEFUL_FALLBACK_REASONS = new Set<LLMStatefulFallbackReason>(["store_disabled"]);

const DESKTOP_BIASED_SYSTEM_COMMANDS = new Set([
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "playwright",
  "gdb",
]);

function isRequiresInputToolResult(
  parsedResult: Record<string, unknown> | null,
): boolean {
  return parsedResult?.status === "requires_input";
}

function extractRequiresInputCode(
  parsedResult: Record<string, unknown> | null,
): string {
  const code = parsedResult?.code;
  return typeof code === "string" && code.trim().length > 0
    ? code.trim()
    : "requires_input";
}

function extractDeniedCommand(failureText: string): string | undefined {
  const quotedDouble = failureText.match(/command\s+"([^"]+)"\s+is denied/i);
  if (quotedDouble && quotedDouble[1]?.trim().length) {
    return quotedDouble[1].trim();
  }
  const quotedSingle = failureText.match(/command\s+'([^']+)'\s+is denied/i);
  if (quotedSingle && quotedSingle[1]?.trim().length) {
    return quotedSingle[1].trim();
  }
  return undefined;
}

function extractSpawnEnoentCommand(failureText: string): string | undefined {
  const match = failureText.match(/spawn\s+([^\s]+)\s+enoent/i);
  const command = match?.[1]?.trim();
  return command && command.length > 0 ? command : undefined;
}

function commandBasename(command: string): string {
  const normalized = command.trim().replace(/\\/g, "/");
  const parts = normalized.split("/");
  return (parts[parts.length - 1] ?? normalized).toLowerCase();
}

function isNodeInterpreterCommand(command: string): boolean {
  const base = commandBasename(command);
  return base === "node" || base.startsWith("node");
}

function isPythonInterpreterCommand(command: string): boolean {
  const base = commandBasename(command);
  return base === "python" || /^python\d+(?:\.\d+)?$/.test(base);
}

function isDestructiveRemovalCommand(command: string): boolean {
  return commandBasename(command) === "rm";
}

function isAgencRuntimeNodeInvocation(args: Record<string, unknown>): boolean {
  const raw = args.args;
  if (!Array.isArray(raw)) return false;
  const first = raw.find((value) => typeof value === "string");
  if (typeof first !== "string") return false;
  const normalized = first.toLowerCase().replace(/\\/g, "/");
  return (
    normalized.endsWith("runtime/dist/bin/agenc-runtime.js") ||
    normalized.endsWith("bin/agenc-runtime.js") ||
    normalized === "agenc-runtime.js"
  );
}

function isDesktopSessionUnavailable(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("requires desktop session") ||
    failureTextLower.includes('tool not found: "desktop.bash"') ||
    failureTextLower.includes("tool not found: 'desktop.bash'")
  );
}

function isDesktopBiasedSystemCommandFailure(
  command: string,
  failureTextLower: string,
): boolean {
  if (!DESKTOP_BIASED_SYSTEM_COMMANDS.has(command)) return false;
  return (
    failureTextLower.includes("enoent") ||
    failureTextLower.includes("command not found") ||
    failureTextLower.includes("is denied") ||
    failureTextLower.includes("not found")
  );
}

function isShellExecutionAnomalyFailure(failureText: string): boolean {
  return /(?:^|\n)(?:[^:\n]+:\s+line\s+\d+:\s+)?(?:(?:ba|z|k)?sh|cd|pushd|popd|source|\.)[^:\n]*:\s+.*(?:no such file or directory|command not found|not found|permission denied|not a directory)/i.test(
    failureText,
  );
}

function stripPromptPrefixes(line: string): string {
  return line.replace(/^\s*(?:>{1,3}|\$|#|\.\.\.)\s*/, "").trim();
}

function isLikelyInteractiveBannerLine(line: string): boolean {
  return /^[A-Z][A-Za-z0-9 _:-]{2,80}$/.test(line.trim());
}

function extractSemanticShellOutputLines(stdout: string): readonly string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => stripPromptPrefixes(line))
    .filter((line) => line.length > 0)
    .filter((line) => !isLikelyInteractiveBannerLine(line));
}

function isInteractiveCliVerificationCommand(call: ToolCallRecord): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") {
    return false;
  }
  const command = extractShellCommand(call);
  if (command.length === 0) {
    return false;
  }
  return (
    command.includes("|") &&
    /\btimeout\b/i.test(command) &&
    /(?:^|[\s;&|])(?:\.\/|\.\.\/|\/)[^\s|;&]+/.test(command)
  );
}

function usesPromptSlicingHeuristic(command: string): boolean {
  return (
    /\|\s*tail\b/i.test(command) ||
    /\|\s*head\b/i.test(command) ||
    /\|\s*sed\s+-n\b/i.test(command) ||
    /\|\s*awk\b/i.test(command)
  );
}

function hasInteractiveCliVerificationOutputGap(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
): boolean {
  if (!isInteractiveCliVerificationCommand(call) || !parsedResult) {
    return false;
  }
  const stdout =
    typeof parsedResult.stdout === "string" ? parsedResult.stdout : "";
  if (stdout.trim().length === 0) {
    return false;
  }
  const semanticLines = extractSemanticShellOutputLines(stdout);
  return semanticLines.length === 0;
}

function hasShellTimeoutAssignmentMisuse(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") {
    return false;
  }
  const command = extractShellCommand(call);
  if (command.length === 0) {
    return false;
  }
  const stderr =
    typeof parsedResult?.stderr === "string" ? parsedResult.stderr : "";
  return (
    /(?:^|[;&|]\s*|\s)timeout\b[^\n;&|]*\s+[A-Za-z_][A-Za-z0-9_]*=\$\(/.test(
      command,
    ) || /timeout: failed to run command/i.test(stderr)
  );
}

function hasBrokenHeredocConjunctionShape(
  args: Record<string, unknown> | undefined,
  failureTextLower: string,
): boolean {
  if (!failureTextLower.includes("syntax error near unexpected token")) {
    return false;
  }
  const command =
    typeof args?.command === "string" ? args.command : "";
  if (!command.includes("<<")) return false;
  return /\n\s*(?:&&|\|\||;)\s+\S/.test(command);
}

function isWatchModeTestRunnerFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  if (!parsedResult || parsedResult.timedOut !== true) return false;

  const command = String(call.args?.command ?? "").trim().toLowerCase();
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const stdout = typeof parsedResult.stdout === "string"
    ? parsedResult.stdout.toLowerCase()
    : "";
  const stderr = typeof parsedResult.stderr === "string"
    ? parsedResult.stderr.toLowerCase()
    : "";
  const watchSignal =
    stdout.includes("watching for file changes") ||
    stdout.includes("press h to show help") ||
    stdout.includes("press q to quit") ||
    stderr.includes("watching for file changes");
  if (!watchSignal) return false;

  return (
    command === "vitest" ||
    command === "jest" ||
    command === "npm" ||
    command === "pnpm" ||
    command === "yarn" ||
    command === "bun" ||
    args.includes("test") ||
    args.includes("vitest") ||
    failureTextLower.includes("vitest") ||
    failureTextLower.includes("jest")
  );
}

function isTestRunnerCommand(
  call: ToolCallRecord,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const joined = [command, ...args].join(" ");
  const invokesDirectTestArtifact =
    isNodeInterpreterCommand(command) &&
    args.some((value) =>
      /(^|\/)(?:dist\/)?(?:test|tests|__tests__)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
        value,
      ) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value)
    );
  if (/\b(?:vitest|jest|pytest|mocha|ava)\b/.test(joined)) {
    return true;
  }
  if (invokesDirectTestArtifact) {
    return true;
  }
  if (
    ["npm", "pnpm", "yarn", "bun"].includes(command) &&
    args.some((value) =>
      value === "test" ||
      value === "vitest" ||
      value === "coverage" ||
      value === "jest"
    )
  ) {
    return true;
  }
  return failureTextLower.includes("vitest") || failureTextLower.includes("jest");
}

function isTimedOutNonWatchTestRunnerFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
  failureTextLower: string,
): boolean {
  if (!parsedResult || parsedResult.timedOut !== true) {
    return false;
  }
  if (isWatchModeTestRunnerFailure(call, parsedResult, failureTextLower)) {
    return false;
  }
  return isTestRunnerCommand(call, failureTextLower);
}

function isVitestUnsupportedThreadsFlagFailure(
  call: ToolCallRecord,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const joined = [command, ...args].join(" ");
  if (
    !joined.includes("vitest") &&
    !failureTextLower.includes("vitest")
  ) {
    return false;
  }
  if (
    !failureTextLower.includes("unknown option") ||
    !failureTextLower.includes("--threads")
  ) {
    return false;
  }
  return joined.includes("--threads") || joined.includes("--no-threads");
}

function isUnsupportedWorkspaceProtocolFailure(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("unsupported url type \"workspace:\"") ||
    failureTextLower.includes("unsupported url type 'workspace:'") ||
    failureTextLower.includes("eunsupportedprotocol")
  );
}

function isRecursiveNpmInstallLifecycleFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  if (command !== "npm") return false;
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  if (!args.includes("install")) return false;

  const stdout = typeof parsedResult?.stdout === "string"
    ? parsedResult.stdout.toLowerCase()
    : "";
  const stderr = typeof parsedResult?.stderr === "string"
    ? parsedResult.stderr.toLowerCase()
    : "";
  const combined = `${stdout}\n${stderr}`;
  return (
    />\s+.+?\s+install\s*\n>\s+npm install/.test(combined) ||
    (
      combined.includes("lifecycle script `install` failed") &&
      combined.includes("> npm install")
    )
  );
}

function extractMissingNpmScriptName(failureText: string): string | undefined {
  const match = failureText.match(/missing script:\s*["'`]?([^"'`\n]+)["'`]?/i);
  const scriptName = match?.[1]?.trim();
  return scriptName && scriptName.length > 0 ? scriptName : undefined;
}

function extractRequestedNpmWorkspaceSelectors(
  call: ToolCallRecord,
): readonly string[] {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return [];
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  if (command !== "npm") return [];
  const args = Array.isArray(call.args?.args)
    ? call.args.args.filter((value): value is string => typeof value === "string")
    : [];
  const selectors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]?.trim();
    if (!value) continue;
    if (value.startsWith("--workspace=")) {
      const selector = value.slice("--workspace=".length).trim();
      if (selector.length > 0) selectors.push(selector);
      continue;
    }
    if (value === "--workspace") {
      const selector = args[index + 1]?.trim();
      if (selector && selector.length > 0) {
        selectors.push(selector);
        index += 1;
      }
    }
  }
  return selectors;
}

function isMissingNpmScriptFailure(
  call: ToolCallRecord,
  failureText: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  return command.includes("npm") && extractMissingNpmScriptName(failureText) !== undefined;
}

function isMissingNpmWorkspaceFailure(
  call: ToolCallRecord,
  failureText: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  if (command !== "npm") return false;
  return /npm error no workspaces found:/i.test(failureText);
}

function isMissingLocalPackageDistFailure(failureText: string): boolean {
  return /cannot find (?:package|module)\s+['"][^'"]*\/node_modules\/[^'"]*\/dist\/[^'"]+['"]/i
    .test(failureText);
}

function isTypescriptRootDirScopeFailure(failureText: string): boolean {
  return /ts6059/i.test(failureText) && /is not under ['"`]rootdir['"`]/i.test(failureText);
}

function extractDuplicateExportName(failureText: string): string | undefined {
  const patterns = [
    /multiple exports with the same name ["'`](.+?)["'`]/i,
    /duplicate export(?:s)?(?: with the same name)? ["'`](.+?)["'`]/i,
    /already exported a member named ['"`]([^'"`]+)['"`]/i,
  ];
  for (const pattern of patterns) {
    const match = failureText.match(pattern);
    const name = match?.[1]?.trim();
    if (name && name.length > 0) {
      return name;
    }
  }
  return undefined;
}

function isDuplicateExportFailure(failureText: string): boolean {
  return extractDuplicateExportName(failureText) !== undefined || /ts2308/i.test(failureText);
}

function isJsonEscapedSourceLiteralFailure(failureText: string): boolean {
  const lower = failureText.toLowerCase();
  const hasCompilerStylePath =
    /(?:^|\s|["'`])[^"'`\s]+\.(?:rs|c|cc|cpp|h|hpp|ts|tsx|js|jsx|py):\d+/i.test(
      failureText,
    );
  const hasEscapeTokenSignal =
    lower.includes("unknown start of token: \\") ||
    lower.includes("unknown character escape") ||
    lower.includes("unterminated double quote string");
  const hasEscapedLiteralSignal =
    failureText.includes('\\"') ||
    failureText.includes("\\n") ||
    failureText.includes("\\t");
  return hasCompilerStylePath && hasEscapeTokenSignal && hasEscapedLiteralSignal;
}

function isCmakeCacheSourceMismatchFailure(failureText: string): boolean {
  return (
    /cmakecache\.txt directory .* is different than the directory .* was created/i
      .test(failureText) ||
    /does not match the source .* used to generate cache/i.test(failureText) ||
    /re-run cmake with a different source directory/i.test(failureText)
  );
}

function extractShellCommand(call: ToolCallRecord): string {
  const command =
    typeof call.args?.command === "string" ? call.args.command.trim() : "";
  const rawArgs = Array.isArray(call.args?.args)
    ? call.args.args.filter((value): value is string => typeof value === "string")
    : [];
  if (rawArgs.length === 0) {
    return command;
  }
  return [command, ...rawArgs].filter((value) => value.length > 0).join(" ").trim();
}

function normalizeShellPathToken(raw: string): string {
  return raw.replace(/^['"`]+|['"`]+$/g, "").trim();
}

function extractNonDefaultBuildDirectory(command: string): string | undefined {
  const candidates: string[] = [];
  for (const pattern of [
    /\bcmake\b[\s\S]*?\s-B\s+([^\s;&|]+)/gi,
    /\bcmake\b[\s\S]*?\s--build\s+([^\s;&|]+)/gi,
    /\bcd\s+([^\s;&|]+)\s*&&\s*(?:cmake|make|ninja|ctest)\b/gi,
  ]) {
    for (const match of command.matchAll(pattern)) {
      const candidate = normalizeShellPathToken(match[1] ?? "");
      if (candidate.length > 0) {
        candidates.push(candidate);
      }
    }
  }
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, "/");
    const basename = normalized.split("/").pop()?.toLowerCase() ?? normalized.toLowerCase();
    if (basename.startsWith("build") && basename !== "build") {
      return candidate;
    }
  }
  return undefined;
}

function isSuccessfulFreshBuildCall(call: ToolCallRecord): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") {
    return false;
  }
  if (didToolCallFail(call.isError, call.result)) {
    return false;
  }
  const command = extractShellCommand(call);
  if (command.length === 0) {
    return false;
  }
  if (extractNonDefaultBuildDirectory(command) === undefined) {
    return false;
  }
  return /\b(?:cmake|make|ninja|ctest)\b/i.test(command);
}

function isRepositoryBuildHarnessCommand(call: ToolCallRecord): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") {
    return false;
  }
  const command = extractShellCommand(call).toLowerCase();
  return (
    /(?:^|\s)(?:ba|z|k)?sh\s+(?:\.\/)?(?:[^\s]+\/)?tests\/run_tests\.sh(?:\s|$)/.test(
      command,
    ) ||
    /(?:^|\s)(?:ba|z|k)?sh\s+(?:\.\/)?run_tests\.sh(?:\s|$)/.test(command) ||
    /(?:^|[\s;&|])(?:\.\/)?(?:[^\s]+\/)?tests\/run_tests\.sh(?:\s|$)/.test(
      command,
    ) ||
    /(?:^|[\s;&|])(?:\.\/)?run_tests\.sh(?:\s|$)/.test(command)
  );
}

interface RepositoryBuildHarnessInvocation {
  readonly cwd: string;
  readonly scriptPath: string;
}

interface StaleCopiedCmakeHarnessPreflightResult {
  readonly args: Record<string, unknown>;
  readonly repairedFields: readonly string[];
  readonly reasonKey?: string;
  readonly rejectionError?: string;
}

function isStaleCopiedCmakeWorkspace(workspaceRoot: string | undefined): boolean {
  if (!workspaceRoot) return false;
  const cmakeListsPath = resolvePath(workspaceRoot, "CMakeLists.txt");
  const cmakeCachePath = resolvePath(workspaceRoot, "build", "CMakeCache.txt");
  if (!existsSync(cmakeListsPath) || !existsSync(cmakeCachePath)) {
    return false;
  }
  try {
    const cache = readFileSync(cmakeCachePath, "utf8");
    const homeDirectoryMatch = cache.match(
      /^CMAKE_HOME_DIRECTORY(?::[A-Z]+)?=(.+)$/m,
    );
    const cacheHomeDirectory = homeDirectoryMatch?.[1]?.trim();
    if (!cacheHomeDirectory) return false;
    return resolvePath(cacheHomeDirectory) !== resolvePath(workspaceRoot);
  } catch {
    return false;
  }
}

function resolveRepositoryBuildHarnessInvocation(
  args: Record<string, unknown>,
  workspaceRoot?: string,
): RepositoryBuildHarnessInvocation | undefined {
  const cwdCandidate =
    typeof args.cwd === "string" && args.cwd.trim().length > 0
      ? resolvePath(args.cwd)
      : workspaceRoot
        ? resolvePath(workspaceRoot)
        : undefined;
  if (!cwdCandidate) return undefined;

  const command =
    typeof args.command === "string" ? args.command.trim() : "";
  const rawArgs = Array.isArray(args.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];

  const shellBase = commandBasename(command);
  if (rawArgs.length > 0 && /^(?:ba|z|k)?sh$/.test(shellBase)) {
    const scriptArg = rawArgs.find((value) => !value.startsWith("-"));
    if (!scriptArg) return undefined;
    return {
      cwd: cwdCandidate,
      scriptPath: resolvePath(cwdCandidate, scriptArg),
    };
  }

  const inlineShellMatch = command.match(
    /(?:^|\s)(?:ba|z|k)?sh\s+((?:\.\/)?[^\s]+\.(?:sh|bash|zsh))(?:\s|$)/i,
  );
  if (inlineShellMatch?.[1]) {
    return {
      cwd: cwdCandidate,
      scriptPath: resolvePath(cwdCandidate, inlineShellMatch[1]),
    };
  }

  if (/\.(?:sh|bash|zsh)$/i.test(command)) {
    return {
      cwd: cwdCandidate,
      scriptPath: resolvePath(cwdCandidate, command),
    };
  }
  return undefined;
}

function parseSimpleRepositoryBuildHarness(
  scriptContent: string,
): { readonly equivalentCommand: string } | undefined {
  const segments = scriptContent
    .split(/\r?\n/)
    .flatMap((line) => line.split("&&"))
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0 &&
      !line.startsWith("#") &&
      !/^set(?:\s+-[A-Za-z]+|\s+-o\s+\w+)/.test(line)
    );
  if (segments.length === 0) return undefined;

  const normalized = segments.map((segment) =>
    segment.replace(/\s+/g, " ").trim().toLowerCase()
  );
  const supported = new Set([
    "mkdir build",
    "mkdir -p build",
    "cd build",
    "cmake ..",
    "cmake --build .",
    "make",
    "ctest",
    "ctest --output-on-failure",
  ]);
  if (normalized.some((segment) => !supported.has(segment))) {
    return undefined;
  }
  if (!normalized.includes("cd build") || !normalized.includes("cmake ..")) {
    return undefined;
  }
  const needsBuild = normalized.includes("make") || normalized.includes("cmake --build .");
  if (!needsBuild) return undefined;

  const commands = [
    "cmake -S . -B __AGENC_FRESH_BUILD_DIR__",
    "cmake --build __AGENC_FRESH_BUILD_DIR__",
  ];
  if (normalized.includes("ctest") || normalized.includes("ctest --output-on-failure")) {
    commands.push("ctest --test-dir __AGENC_FRESH_BUILD_DIR__ --output-on-failure");
  }
  return {
    equivalentCommand: commands.join(" && "),
  };
}

function resolvePreferredFreshBuildDirectory(
  recentCalls: readonly ToolCallRecord[],
): string {
  const latestFreshBuild = [...recentCalls]
    .reverse()
    .find((call) => isSuccessfulFreshBuildCall(call));
  return (
    (latestFreshBuild
      ? extractNonDefaultBuildDirectory(extractShellCommand(latestFreshBuild))
      : undefined) ?? "build-agenc-fresh"
  );
}

function buildFreshBuildDirectoryPath(
  workspaceRoot: string,
  freshBuildDir: string,
): string {
  if (freshBuildDir.startsWith("/")) {
    return freshBuildDir;
  }
  return resolvePath(workspaceRoot, freshBuildDir);
}

function isWorkspaceBuildDirectoryPath(
  candidate: string,
  workspaceRoot: string,
): boolean {
  return resolvePath(candidate) === resolvePath(workspaceRoot, "build");
}

function isDirectConfigureIntoStaleDefaultBuild(
  args: Record<string, unknown>,
  workspaceRoot: string,
): boolean {
  const command =
    typeof args.command === "string" ? args.command.trim().toLowerCase() : "";
  const commandBase = commandBasename(command);
  const rawArgs = Array.isArray(args.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  const cwd =
    typeof args.cwd === "string" && args.cwd.trim().length > 0
      ? resolvePath(args.cwd)
      : resolvePath(workspaceRoot);
  if (
    commandBase === "cd" &&
    rawArgs.length >= 4 &&
    isWorkspaceBuildDirectoryPath(rawArgs[0], workspaceRoot) &&
    rawArgs[1] === "&&" &&
    rawArgs[2]?.toLowerCase() === "cmake" &&
    rawArgs[3] === ".."
  ) {
    return true;
  }
  if (commandBase !== "cmake") return false;
  if (cwd === resolvePath(workspaceRoot, "build") && rawArgs.length === 1 && rawArgs[0] === "..") {
    return true;
  }
  const buildIndex = rawArgs.findIndex((value) => value === "-B");
  if (buildIndex >= 0) {
    const buildTarget = rawArgs[buildIndex + 1];
    if (
      typeof buildTarget === "string" &&
      (buildTarget === "build" || isWorkspaceBuildDirectoryPath(buildTarget, workspaceRoot))
    ) {
      return true;
    }
  }
  return false;
}

function isDirectBuildAgainstStaleDefaultBuild(
  args: Record<string, unknown>,
  workspaceRoot: string,
): boolean {
  const command =
    typeof args.command === "string" ? args.command.trim().toLowerCase() : "";
  const commandBase = commandBasename(command);
  const cwd =
    typeof args.cwd === "string" && args.cwd.trim().length > 0
      ? resolvePath(args.cwd)
      : resolvePath(workspaceRoot);
  return (
    ["make", "ninja", "ctest"].includes(commandBase) &&
    cwd === resolvePath(workspaceRoot, "build")
  );
}

export function preflightStaleCopiedCmakeHarnessInvocation(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string | undefined,
  recentCalls: readonly ToolCallRecord[],
): StaleCopiedCmakeHarnessPreflightResult {
  if (toolName !== "system.bash" && toolName !== "desktop.bash") {
    return { args, repairedFields: [] };
  }
  if (!isStaleCopiedCmakeWorkspace(workspaceRoot)) {
    return { args, repairedFields: [] };
  }
  if (!workspaceRoot) {
    return { args, repairedFields: [] };
  }
  const normalizedWorkspaceRoot = resolvePath(workspaceRoot);
  const freshBuildDir = resolvePreferredFreshBuildDirectory(recentCalls);
  const freshBuildPath = buildFreshBuildDirectoryPath(
    normalizedWorkspaceRoot,
    freshBuildDir,
  );

  if (isDirectConfigureIntoStaleDefaultBuild(args, normalizedWorkspaceRoot)) {
    return {
      args: {
        command: "cmake",
        args: ["-S", normalizedWorkspaceRoot, "-B", freshBuildPath],
        cwd: normalizedWorkspaceRoot,
      },
      repairedFields: ["command", "args", "cwd"],
      reasonKey: "system-bash-cmake-stale-default-build-rewritten",
    };
  }
  if (isDirectBuildAgainstStaleDefaultBuild(args, normalizedWorkspaceRoot)) {
    return {
      args: {
        command: "cmake",
        args: ["--build", freshBuildPath],
        cwd: normalizedWorkspaceRoot,
      },
      repairedFields: ["command", "args", "cwd"],
      reasonKey: "system-bash-cmake-stale-default-build-rewritten",
    };
  }

  const invocation = resolveRepositoryBuildHarnessInvocation(args, normalizedWorkspaceRoot);
  if (!invocation || !existsSync(invocation.scriptPath)) {
    return { args, repairedFields: [] };
  }

  try {
    const scriptContent = readFileSync(invocation.scriptPath, "utf8");
    const normalizedScript = scriptContent.toLowerCase();
    if (
      !/\bcd\s+build\b/.test(normalizedScript) ||
      !/\bcmake\s+\.\./.test(normalizedScript)
    ) {
      return { args, repairedFields: [] };
    }

    const parsedHarness = parseSimpleRepositoryBuildHarness(scriptContent);
    if (!parsedHarness) {
      return {
        args,
        repairedFields: [],
        reasonKey: "system-bash-cmake-stale-harness-rejected",
        rejectionError:
          `Refusing to invoke \`${invocation.scriptPath}\` in this delegated workspace because the script hardcodes the stale copied \`build/\` directory and cannot be safely rewritten automatically. ` +
          `Run the equivalent verification directly from \`${resolvePath(normalizedWorkspaceRoot ?? invocation.cwd)}\` against a fresh build directory such as \`${freshBuildDir}\` instead.`,
      };
    }

    return {
      args: {
        command: parsedHarness.equivalentCommand.replaceAll(
          "__AGENC_FRESH_BUILD_DIR__",
          freshBuildDir,
        ),
        cwd: resolvePath(normalizedWorkspaceRoot ?? invocation.cwd),
      },
      repairedFields: ["command", "args", "cwd"],
      reasonKey: "system-bash-cmake-stale-harness-rewritten",
    };
  } catch {
    return { args, repairedFields: [] };
  }
}

function isUnconfiguredBuildDirectoryFailure(
  call: ToolCallRecord,
  failureText: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") {
    return false;
  }
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const joined = [command, ...args].join(" ");
  const buildCommand =
    /\b(?:make|cmake|ninja)\b/.test(joined);
  if (!buildCommand) {
    return false;
  }
  return (
    /no targets specified and no makefile found/i.test(failureText) ||
    /ninja:\s+error:\s+loading ['"`]?build\.ninja['"`]?: no such file or directory/i.test(
      failureText,
    ) ||
    /could not load cache/i.test(failureText)
  );
}

function extractCompilerDiagnosticLocation(
  failureText: string,
): string | undefined {
  const match = failureText.match(
    /(^|\n)([^:\n]+\.(?:c|cc|cpp|cxx|h|hpp|hh|m|mm|rs|go|ts|tsx|js|jsx|py)):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?error:/i,
  );
  const file = match?.[2]?.trim();
  const line = match?.[3]?.trim();
  const column = match?.[4]?.trim();
  if (!file || !line) {
    return undefined;
  }
  return `${file}:${line}${column ? `:${column}` : ""}`;
}

function extractUnknownTypeNameFromCompilerFailure(
  failureText: string,
): string | undefined {
  const match = failureText.match(
    /\bunknown type name ['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?/i,
  );
  return match?.[1]?.trim();
}

function extractCompilerSuggestedName(
  failureText: string,
): string | undefined {
  const match = failureText.match(/\bdid you mean ['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?/i);
  return match?.[1]?.trim();
}

function isHeaderTypeOrderingCompilerFailure(
  failureText: string,
): boolean {
  return (
    /\bunknown type name ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(
      failureText,
    ) ||
    /\bfield has incomplete type\b/i.test(failureText) ||
    /\bunknown type\b/i.test(failureText) &&
      /\b(?:struct|typedef|enum|union|header)\b/i.test(failureText)
  );
}

function isCompilerInterfaceDriftFailure(
  failureText: string,
): boolean {
  return (
    /\bhas no member named ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(
      failureText,
    ) ||
    /\bdid you mean ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(failureText) ||
    /\bincompatible types when assigning to type\b/i.test(failureText) ||
    /\bundeclared\b.*\bdid you mean\b/i.test(failureText)
  );
}

function isCompilerDiagnosticFailure(
  call: ToolCallRecord,
  failureText: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").toLowerCase();
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const joined = [command, ...args].join(" ");
  const looksLikeBuildCommand =
    /\b(?:cmake|ctest|make|ninja|meson|gcc|g\+\+|clang|clang\+\+|cc|c\+\+)\b/
      .test(joined);
  const looksLikeRepoScriptBuildWrapper =
    (
      /^(?:ba|z|k)?sh$/.test(command.split(/[\\/]/).pop() ?? "") &&
      args.some((value) => /(?:^|\/)[^/\s]+\.(?:sh|bash|zsh)$/i.test(value))
    ) ||
    /\b(?:ba|z|k)?sh\s+[^\s]+\.(?:sh|bash|zsh)\b/i.test(joined);
  return (looksLikeBuildCommand || looksLikeRepoScriptBuildWrapper) &&
    extractCompilerDiagnosticLocation(failureText) !== undefined;
}

function isPackagePathNotExportedFailure(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("err_package_path_not_exported") ||
    failureTextLower.includes("no \"exports\" main defined")
  );
}

function usesCommonJsRequireSnippet(call: ToolCallRecord): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "");
  if (!/\bnode\b/i.test(command)) return false;
  return /\brequire\s*\(/.test(command);
}

function hasExtendedGrepPatternWithoutFlag(
  args: Record<string, unknown> | undefined,
): boolean {
  const rawArgs = Array.isArray(args?.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  if (rawArgs.length === 0) return false;
  const hasExtendedFlag = rawArgs.some((value) => value === "-E" || value === "-P");
  if (hasExtendedFlag) return false;
  return rawArgs.some((value) => {
    if (value.startsWith("-")) return false;
    return value.includes("|");
  });
}

function collectDirectGrepOperands(
  args: Record<string, unknown> | undefined,
): string[] {
  const rawArgs = Array.isArray(args?.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  const operands: string[] = [];
  const flagsWithSeparateValue = new Set([
    "-A",
    "-B",
    "-C",
    "-D",
    "-d",
    "-e",
    "-f",
    "-m",
    "--after-context",
    "--before-context",
    "--binary-files",
    "--color",
    "--colour",
    "--context",
    "--devices",
    "--directories",
    "--exclude",
    "--exclude-dir",
    "--file",
    "--include",
    "--label",
    "--max-count",
    "--regexp",
  ]);
  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];
    if (!value || value === "--") continue;
    if (flagsWithSeparateValue.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--include=") || value.startsWith("--exclude=")) {
      continue;
    }
    if (value.startsWith("--exclude-dir=")) {
      continue;
    }
    if (value.startsWith("-")) {
      continue;
    }
    operands.push(value);
  }
  return operands;
}

function hasGrepPatternWithoutSearchScope(
  args: Record<string, unknown> | undefined,
): boolean {
  return collectDirectGrepOperands(args).length <= 1;
}

function isLikelyGrepOperandShapeFailure(
  call: ToolCallRecord,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "");
  if (commandBasename(command) !== "grep") return false;
  if (failureTextLower.includes("no such file or directory")) return true;
  if (hasExtendedGrepPatternWithoutFlag(call.args)) return true;
  return hasGrepPatternWithoutSearchScope(call.args);
}

function isLikelyLiteralGlobFailure(
  call: ToolCallRecord,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  if (
    !failureTextLower.includes("no such file or directory") &&
    !failureTextLower.includes("cannot access")
  ) {
    return false;
  }
  const rawArgs = Array.isArray(call.args?.args)
    ? call.args.args.filter((value): value is string => typeof value === "string")
    : [];
  if (rawArgs.length === 0) return false;
  return rawArgs.some((value) => {
    if (value.startsWith("-")) return false;
    if (!/[/?[*\]]/.test(value)) return false;
    return value.includes("/") || value.includes(".");
  });
}

export function buildSemanticToolCallKey(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}:${normalizeSemanticValue(args)}`;
}

function normalizeSemanticValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => normalizeSemanticValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map(
        (key) =>
          `${key}:${normalizeSemanticValue(obj[key])}`,
      )
      .join(",")}}`;
  }
  return String(value);
}

export function summarizeStateful(
  callUsage: readonly ChatCallUsageRecord[],
): ChatStatefulSummary | undefined {
  const entries = callUsage
    .map((entry) => entry.statefulDiagnostics)
    .filter(
      (entry): entry is LLMStatefulDiagnostics =>
        entry !== undefined && entry.enabled,
    );
  if (entries.length === 0) return undefined;

  const fallbackReasons: Record<LLMStatefulFallbackReason, number> =
    createLLMStatefulFallbackReasonCounts();
  let attemptedCalls = 0;
  let continuedCalls = 0;
  let fallbackCalls = 0;

  for (const entry of entries) {
    if (entry.attempted) attemptedCalls++;
    if (entry.continued) continuedCalls++;
    if (entry.fallbackReason) {
      fallbackCalls++;
      fallbackReasons[entry.fallbackReason] += 1;
    }
  }

  return {
    enabled: true,
    attemptedCalls,
    continuedCalls,
    fallbackCalls,
    fallbackReasons,
  };
}

export function hasActionableStatefulFallback(
  summary: ChatStatefulSummary | undefined,
): boolean {
  if (!summary || summary.fallbackCalls <= 0) {
    return false;
  }
  return Object.entries(summary.fallbackReasons).some(([reason, count]) =>
    count > 0 &&
    !NON_ACTIONABLE_STATEFUL_FALLBACK_REASONS.has(
      reason as LLMStatefulFallbackReason,
    )
  );
}

export function buildRecoveryHints(
  roundCalls: readonly ToolCallRecord[],
  emittedHints: Set<string>,
  recentCalls: readonly ToolCallRecord[] = roundCalls,
): RecoveryHint[] {
  const hints: RecoveryHint[] = [];
  const roundHint = inferRoundRecoveryHint(roundCalls, recentCalls);
  if (roundHint && !emittedHints.has(roundHint.key)) {
    emittedHints.add(roundHint.key);
    hints.push(roundHint);
  }
  for (const call of roundCalls) {
    const hint = inferRecoveryHint(call);
    if (!hint) continue;
    if (emittedHints.has(hint.key)) continue;
    emittedHints.add(hint.key);
    hints.push(hint);
  }
  return hints;
}

function inferRoundRecoveryHint(
  roundCalls: readonly ToolCallRecord[],
  recentCalls: readonly ToolCallRecord[] = roundCalls,
): RecoveryHint | undefined {
  const latestStaleCmakeMismatch = [...recentCalls]
    .reverse()
    .find((call) => {
      if (!didToolCallFail(call.isError, call.result)) return false;
      return isCmakeCacheSourceMismatchFailure(extractToolFailureText(call));
    });
  const latestFreshBuild = [...recentCalls]
    .reverse()
    .find((call) => isSuccessfulFreshBuildCall(call));
  const latestStaleHarnessMismatch = [...recentCalls]
    .reverse()
    .find((call) => {
      if (!didToolCallFail(call.isError, call.result)) return false;
      if (!isRepositoryBuildHarnessCommand(call)) return false;
      return isCmakeCacheSourceMismatchFailure(extractToolFailureText(call));
    });
  const roundHasStaleHarnessMismatch = roundCalls.some((call) => {
    if (!didToolCallFail(call.isError, call.result)) return false;
    if (!isRepositoryBuildHarnessCommand(call)) return false;
    return isCmakeCacheSourceMismatchFailure(extractToolFailureText(call));
  });
  const recentHarnessRetryAfterFreshBuild = (() => {
    if (!latestFreshBuild) return false;
    const freshBuildIndex = recentCalls.lastIndexOf(latestFreshBuild);
    return recentCalls.some(
      (call, index) =>
        index > freshBuildIndex && isRepositoryBuildHarnessCommand(call),
    );
  })();
  if (
    latestFreshBuild &&
    latestStaleHarnessMismatch &&
    (roundHasStaleHarnessMismatch || recentHarnessRetryAfterFreshBuild)
  ) {
    const freshBuildDir =
      extractNonDefaultBuildDirectory(extractShellCommand(latestFreshBuild)) ??
      "build-agenc-fresh";
    return {
      key: "system-bash-cmake-stale-harness-after-fresh-build",
      message:
        "The repository verification script is still bound to the stale copied `build/` directory, but a regenerated build directory already succeeded. " +
        "Do not bounce back into `bash tests/run_tests.sh` or edit that script unless it is an explicit writable target. " +
        `Continue verification directly against \`${freshBuildDir}\` with equivalent build/test commands from the workspace root.`,
    };
  }
  if (latestFreshBuild && latestStaleCmakeMismatch) {
    const freshBuildDir =
      extractNonDefaultBuildDirectory(extractShellCommand(latestFreshBuild)) ??
      "build-agenc-fresh";
    return {
      key: "system-bash-cmake-use-established-fresh-build-dir",
      message:
        `A regenerated build directory (\`${freshBuildDir}\`) already succeeded after the stale copied CMake cache failure. ` +
        `Treat \`${freshBuildDir}\` as the trusted build root for the rest of this workspace run. ` +
        "Keep rebuilds and verification in that directory after source edits, and do not switch back to `build/`, recreate `build/`, or delete build directories with `rm` unless the contract explicitly requires that cleanup.",
    };
  }

  const staleCmakeMismatchCall = roundCalls.find((call) => {
    if (!didToolCallFail(call.isError, call.result)) return false;
    return isCmakeCacheSourceMismatchFailure(extractToolFailureText(call));
  });
  if (staleCmakeMismatchCall) {
    const successfulFreshBuildCall = roundCalls.find((call) =>
      isSuccessfulFreshBuildCall(call)
    );
    if (
      successfulFreshBuildCall &&
      isRepositoryBuildHarnessCommand(staleCmakeMismatchCall)
    ) {
      const freshBuildDir = extractNonDefaultBuildDirectory(
        extractShellCommand(successfulFreshBuildCall),
      ) ?? "build-agenc-fresh";
      return {
        key: "system-bash-cmake-stale-harness-after-fresh-build",
        message:
          "The repository verification script is still bound to the stale copied `build/` directory, but a regenerated build directory already succeeded. " +
          `Do not bounce back into \`bash tests/run_tests.sh\` or edit that script unless it is an explicit writable target. ` +
          `Continue verification directly against \`${freshBuildDir}\` with equivalent build/test commands from the workspace root.`,
      };
    }
    const deniedRemovalCall = roundCalls.find((call) => {
      if (!didToolCallFail(call.isError, call.result)) return false;
      const failureText = extractToolFailureText(call);
      const deniedCommand = extractDeniedCommand(failureText);
      if (!deniedCommand || !isDestructiveRemovalCommand(deniedCommand)) {
        return false;
      }
      const rawCommand =
        typeof call.args?.command === "string" ? call.args.command : "";
      return /(?:^|\/)build(?:[\/\s]|$)|cmakecache\.txt/i.test(rawCommand);
    });
    if (deniedRemovalCall) {
      return {
        key: "system-bash-cmake-cache-rebuild-in-fresh-dir",
        message:
          "The current workspace contains a stale copied CMake cache, and destructive cleanup is blocked. " +
          "Do not retry `rm`. Configure a fresh build directory instead (for example `cmake -S . -B build-agenc-fresh`), " +
          "build from that directory, and if the repository test script hardcodes the stale `build/` path, run the equivalent compile/test verification command directly against the fresh build directory.",
      };
    }
  }
  return undefined;
}

export function inferRecoveryHint(
  call: ToolCallRecord,
): RecoveryHint | undefined {
  const parsedResult = parseToolResultObject(call.result);

  if (
    !didToolCallFail(call.isError, call.result) &&
    hasShellTimeoutAssignmentMisuse(call, parsedResult)
  ) {
    return {
      key: `${call.name}-timeout-assignment-misuse`,
      message:
        "This shell verification command exited 0, but the shell still failed to run the intended probe because `timeout` was wrapped around a variable assignment or another non-executable form. " +
        "Do not write commands like `timeout 10s output=$(...)`. `timeout` can only wrap an executable. " +
        "Capture the CLI output first, then compare it in a separate shell step, or wrap the whole probe in `sh -c`/shell mode. " +
        "For prompt-based CLIs, feed the probe and an explicit `exit`, strip prompt prefixes, and compare the cleaned semantic payload instead of using brittle `tail`/`head` slicing.",
    };
  }

  if (
    !didToolCallFail(call.isError, call.result) &&
    hasInteractiveCliVerificationOutputGap(call, parsedResult)
  ) {
    const command = extractShellCommand(call);
    const promptSlicingWarning = usesPromptSlicingHeuristic(command)
      ? " Do not use positional slicing like `tail`, `head`, `sed -n`, or `awk NR==...` to guess which prompt line contains the result."
      : "";
    return {
      key: `${call.name}-interactive-cli-verification-output-gap`,
      message:
        "This verification command reached an interactive CLI/REPL, but the captured stdout only contains banner or prompt text and no semantic command result. " +
        "Do not treat exit code 0, startup banners, or prompt markers as proof the feature works." +
        promptSlicingWarning +
        " Feed the command and an explicit `exit` into the CLI, strip fixed prompt prefixes from stdout, then compare the cleaned semantic payload for the command under test. If the cleaned output is empty, keep debugging the command behavior before claiming success.",
    };
  }

  if (!didToolCallFail(call.isError, call.result)) return undefined;

  if (isRequiresInputToolResult(parsedResult)) {
    const code = extractRequiresInputCode(parsedResult);
    return {
      key: `${call.name}-requires-input:${code.toLowerCase()}`,
      message:
        `The tool returned \`status: "requires_input"\` (${code}). ` +
        "Do not retry the same tool call with the same arguments. Ask the user for the missing input explicitly, using any choices listed in the tool result. " +
        "For multiple AgenC agent registrations, ask the user to choose one listed `agentPda`/`creatorAgentPda` instead of selecting one automatically.",
    };
  }

  const failureText = extractToolFailureText(call);
  const failureTextLower = failureText.toLowerCase();
  if (
    failureTextLower.includes("repo-local verification harness") &&
    failureTextLower.includes("writable target")
  ) {
    return {
      key: `${call.name}-repo-local-verification-harness`,
      message:
        "This attempt tried to bypass the repo-local verification harness contract by rewriting or shadowing a grader script. " +
        "Do not edit `tests/run_tests.sh`, do not create alternate wrappers like `run_tests_fresh.sh`, and do not clone the harness under a new filename unless the contract explicitly names that file as writable. " +
        "Keep the repo harness read-only and run the equivalent bounded verification commands directly from the workspace root instead.",
    };
  }
  if (isWatchModeTestRunnerFailure(call, parsedResult, failureTextLower)) {
    return {
      key: `${call.name}-test-runner-watch-mode`,
      message:
        "This test command entered interactive watch mode and timed out. " +
        "Retry with a non-interactive single-run invocation. Prefer the runner's native single-shot mode. " +
        "For Vitest, use `vitest run` or `vitest --run`; for Jest-based npm scripts, prefer `CI=1 npm test` or `jest --runInBand`. " +
        "Only append npm `--` flags when the underlying runner supports them.",
    };
  }
  if (isTimedOutNonWatchTestRunnerFailure(call, parsedResult, failureTextLower)) {
    return {
      key: `${call.name}-test-runner-timeout`,
      message:
        "This non-interactive test command timed out without entering watch mode. " +
        "A test or code path likely hung (for example an infinite loop, unresolved promise, or open handle). " +
        "Do not keep retrying the same command or append ad-hoc runner flags. Inspect the authored source and tests, fix the hang, then rerun the minimal single-run test command.",
    };
  }
  if (isVitestUnsupportedThreadsFlagFailure(call, failureTextLower)) {
    return {
      key: `${call.name}-vitest-unsupported-threads-flag`,
      message:
        "Vitest rejected an unsupported thread flag. Do not invent `--threads` or `--no-threads`. " +
        "Keep the command in single-run mode (`vitest run` or `vitest --run`). " +
        "If worker strategy matters for the installed Vitest version, use the supported `--pool=<threads|forks>` option or project config instead.",
    };
  }
  if (
    isDesktopSessionUnavailable(failureTextLower) &&
    (call.name === "desktop.bash" ||
      call.name.startsWith("playwright.") ||
      call.name.startsWith("mcp."))
  ) {
    return {
      key: "desktop-session-unavailable",
      message:
        "Desktop/container tools are unavailable in this chat session. Attach a desktop session first (`/desktop attach`), " +
        "then retry with `desktop.bash` or the required `playwright.*`/`mcp.*` tool.",
    };
  }

  if (call.name === "desktop.bash") {
    if (
      failureTextLower.includes("long-running server process") ||
      failureTextLower.includes("background process but does not redirect") ||
      failureTextLower.includes("should run in background to avoid hanging")
    ) {
      return {
        key: "desktop-bash-background-process-shape",
        message:
          "For long-running/background tasks that you need to inspect or stop later, use `desktop.process_start`, " +
          "then `desktop.process_status` and `desktop.process_stop`. Keep `desktop.bash` for one-shot shell commands or shell scripts.",
      };
    }
  }

  if (call.name === "system.bash") {
    const command = String(call.args?.command ?? "").trim().toLowerCase();
    const spawnEnoentCommand = extractSpawnEnoentCommand(failureText);
    if (hasBrokenHeredocConjunctionShape(call.args, failureTextLower)) {
      return {
        key: "system-bash-heredoc-conjunction-shape",
        message:
          "This shell script put `&&`, `||`, or `;` on a new line after a heredoc terminator, " +
          "which is invalid shell syntax. Split the follow-up command into a separate tool call, " +
          "keep the conjunction on the original command line, or use `system.writeFile`/`system.appendFile` " +
          "for file contents instead of shell heredocs.",
      };
    }
    if (
      failureTextLower.includes("long-running server process") ||
      failureTextLower.includes("background process but does not redirect") ||
      failureTextLower.includes("should run in background to avoid hanging")
    ) {
      return {
        key: "system-bash-typed-server-handle",
        message:
          "For local HTTP services you need to monitor, prefer `system.serverStart`, then `system.serverStatus`/`system.serverResume`, `system.serverLogs`, and `system.serverStop`. " +
          "Use `system.process*` for non-HTTP workers and `system.bash` for one-shot commands only.",
      };
    }
    if (isUnsupportedWorkspaceProtocolFailure(failureTextLower)) {
      return {
        key: "system-bash-workspace-protocol-unsupported",
        message:
          "This host package manager rejected `workspace:*`. Do not assume workspace protocol support in generated manifests. " +
          "Rewrite the local dependency to a host-compatible specifier, then rerun `npm install` on this host before continuing.",
      };
    }
    if (isRecursiveNpmInstallLifecycleFailure(call, parsedResult)) {
      return {
        key: "system-bash-recursive-npm-install-lifecycle",
        message:
          "This project defines an `install` lifecycle that recursively reruns `npm install`, which can loop until timeout. " +
          "Remove or rename the recursive `install` script in `package.json`, keep one-time setup out of `npm install`, then rerun `npm install` before continuing.",
      };
    }
    if (isMissingNpmScriptFailure(call, failureText)) {
      const scriptName = extractMissingNpmScriptName(failureText) ?? "requested";
      return {
        key: `system-bash-missing-npm-script:${scriptName.toLowerCase()}`,
        message:
          `The current package.json does not define the npm script \`${scriptName}\`. ` +
          `Inspect the package.json at the active cwd, add the missing root/workspace script if later verification depends on \`npm run ${scriptName}\`, ` +
          "or run the correct package-specific command instead of retrying the same missing script.",
      };
    }
    if (isMissingNpmWorkspaceFailure(call, failureText)) {
      const selectors = extractRequestedNpmWorkspaceSelectors(call);
      const selectorSuffix = selectors.length > 0
        ? ` The rejected selectors were: ${selectors.map((value) => `\`${value}\``).join(", ")}.`
        : "";
      return {
        key: selectors.length > 0
          ? `system-bash-missing-npm-workspace:${selectors.join(",").toLowerCase()}`
          : "system-bash-missing-npm-workspace",
        message:
          "npm could not match one or more `--workspace` selectors in this repo." +
          selectorSuffix +
          " Inspect the root `package.json` workspaces and each package `name`, then rerun with the exact workspace package names " +
          "(for example `--workspace=@scope/pkg`) or run the command from the matching workspace cwd.",
      };
    }
    if (isMissingLocalPackageDistFailure(failureText)) {
      return {
        key: "system-bash-local-package-dist-missing",
        message:
          "This local package link resolved to a `dist/*` entry that does not exist yet. " +
          "Build the dependency package first or point the consumer at source/exports that already exist on disk, then rerun the command before claiming success.",
      };
    }
    if (isTypescriptRootDirScopeFailure(failureText)) {
      return {
        key: "system-bash-typescript-rootdir-scope",
        message:
          "This TypeScript config includes files outside `rootDir` (for example `vite.config.ts`). " +
          "For Vite/browser packages, either remove the restrictive `rootDir`, exclude config files from that tsconfig, " +
          "or move Node-side config files into a separate tsconfig such as `tsconfig.node.json` before rerunning `tsc`.",
      };
    }
    if (isDuplicateExportFailure(failureText)) {
      const exportName = extractDuplicateExportName(failureText) ?? "the symbol";
      return {
        key: `system-bash-duplicate-export:${exportName.toLowerCase()}`,
        message:
          `This module exports \`${exportName}\` more than once. ` +
          `If the declaration already uses an export modifier (for example \`export class ${exportName}\` or \`export const ${exportName}\`), ` +
          `remove the extra \`export { ${exportName} }\` re-export or rename one export instead of retrying the same build/test. ` +
          "After editing the module, rerun the failing build/test command and only continue once it passes.",
      };
    }
    if (isJsonEscapedSourceLiteralFailure(failureText)) {
      return {
        key: "system-bash-json-escaped-source-literal",
        message:
          "The compiler output suggests JSON escape sequences like `\\\\\"` or `\\\\n` were written into source code. " +
          "Re-read the failing source file, replace the escaped string-literal text with raw source code, " +
          "and when using write/edit tools pass the file contents directly instead of a JSON-encoded representation. " +
          "Only rerun the compile/test command after the source file itself is fixed.",
      };
    }
    if (isCmakeCacheSourceMismatchFailure(failureText)) {
      return {
        key: "system-bash-cmake-cache-source-mismatch",
        message:
          "This build directory contains a stale CMake cache from a different workspace or source root. " +
          "Do not keep retrying the same build command or delete files with `rm`. Reconfigure the project into a fresh build directory " +
          "(for example `cmake -S . -B build-agenc-fresh`) and continue from that regenerated cache before rerunning follow-up builds.",
      };
    }
    if (isUnconfiguredBuildDirectoryFailure(call, failureText)) {
      return {
        key: "system-bash-build-directory-not-configured",
        message:
          "This build directory is present on disk but is not configured for the current workspace. " +
          "Do not keep retrying `make`/`ninja` inside that stale directory. Configure a fresh build directory first " +
          "(for example `cmake -S . -B build-agenc-fresh`), then build and test from that new directory instead of assuming `build/` is reusable.",
      };
    }
    if (isCompilerDiagnosticFailure(call, failureText)) {
      const location = extractCompilerDiagnosticLocation(failureText);
      const unknownTypeName = extractUnknownTypeNameFromCompilerFailure(
        failureText,
      );
      const suggestedName = extractCompilerSuggestedName(failureText);
      if (isCompilerInterfaceDriftFailure(failureText)) {
        return {
          key: location
            ? `system-bash-compiler-interface-drift:${location.toLowerCase()}`
            : "system-bash-compiler-interface-drift",
          message:
            "The compiler is reporting cross-file interface drift" +
            (location ? ` at \`${location}\`` : "") +
            (suggestedName ? ` and is already suggesting \`${suggestedName}\`` : "") +
            ". Treat the cited header or shared type surface as authoritative. Read the cited header plus every touched source file that consumes it, align the type/member/enum names in one coherent repair pass, and only rerun the minimal build/test command after the full interface is consistent again.",
        };
      }
      if (isHeaderTypeOrderingCompilerFailure(failureText)) {
        return {
          key: location
            ? `system-bash-compiler-header-ordering:${location.toLowerCase()}`
            : "system-bash-compiler-header-ordering",
          message:
            "The compiler is reporting a header/type-ordering error" +
            (location ? ` at \`${location}\`` : "") +
            (unknownTypeName ? ` involving \`${unknownTypeName}\`` : "") +
            ". Read the cited header and the first source file that includes it, move the type definition or forward declaration before the first use, and only rerun the minimal build/test command after the header itself is fixed.",
        };
      }
      return {
        key: location
          ? `system-bash-compiler-diagnostic:${location.toLowerCase()}`
          : "system-bash-compiler-diagnostic",
        message:
          "The compiler already identified a concrete source or header location" +
          (location ? ` (\`${location}\`)` : "") +
          ". Stop rerunning the same build command. Read and edit the cited file or header, fix the reported code error, and only rerun the minimal build command after the source change is in place.",
      };
    }
    if (isShellExecutionAnomalyFailure(failureText)) {
      return {
        key: "system-bash-shell-execution-anomaly",
        message:
          "This shell command printed a real shell/runtime error on stderr even though the outer process returned success. " +
          "Treat that verification step as failed. Fix the cwd/path/script invocation before rerunning it. " +
          "For repository scripts that use relative paths, invoke them from the workspace root (for example `bash tests/run_tests.sh`) instead of `cd`-ing into the script directory unless the script explicitly requires that cwd.",
      };
    }
    if (isPackagePathNotExportedFailure(failureTextLower)) {
      return {
        key: usesCommonJsRequireSnippet(call)
          ? "system-bash-esm-package-required-via-require"
          : "system-bash-package-exports-mismatch",
        message:
          usesCommonJsRequireSnippet(call)
            ? "This package exposes ESM/`exports` entry points. Do not verify it with CommonJS `require(...)` unless the package defines a `require` condition. " +
              "Retry with an ESM import (for example `node --input-type=module -e \"import('pkg').then(...)\"`) or inspect the package `exports` map directly."
            : "This package's `exports` map does not match the way the command is loading it. " +
              "Inspect `package.json` `exports`/`main`/`types`, then retry with a loader and entry point that match the package format.",
      };
    }
    if (isLikelyLiteralGlobFailure(call, failureTextLower)) {
      return {
        key: "system-bash-literal-glob-operand",
        message:
          "Direct mode passes `args` literally and does not expand shell globs like `*.d.ts`. " +
          "Enumerate matches first with `find` or `rg --files`, or retry in shell mode with the full shell command in `command` and omit `args` when shell expansion is required.",
      };
    }
    if (isLikelyGrepOperandShapeFailure(call, failureTextLower)) {
      return {
        key: "system-bash-grep-shape",
        message:
          "For code/text search, prefer `rg PATTERN PATH`. If you use `grep` in direct mode, pass exactly one pattern followed by file paths, " +
          "and add `-E` (or use shell mode) when the pattern uses alternation like `foo|bar`. Direct-mode `grep` with only a pattern reads stdin instead of searching files, " +
          "so pair `--include` with `-r` and a directory path (for example `grep -r -E --include='*.cpp' 'foo|bar' src include`) or just use `rg PATTERN src include`.",
      };
    }
    if (isDesktopBiasedSystemCommandFailure(command, failureTextLower)) {
      return {
        key: "system-bash-host-desktop-mismatch",
        message:
          "This command failed on `system.bash` (host shell) but appears to target desktop/container tooling. " +
          "Attach desktop (`/desktop attach`) and run it with `desktop.bash` (or `playwright.*` for browser actions).",
      };
    }
    if (/(^|\s)docker(\s|$)/.test(command)) {
      return {
        key: "system-bash-sandbox-handle",
        message:
          "For durable code-execution environments, prefer `system.sandboxStart`, then `system.sandboxJobStart`/`system.sandboxJobStatus`, `system.sandboxJobLogs`, and `system.sandboxStop` " +
          "instead of raw docker shell commands on `system.bash`.",
      };
    }
    const builtinCandidate =
      spawnEnoentCommand && spawnEnoentCommand.length > 0
        ? commandBasename(spawnEnoentCommand)
        : command;
    const isBuiltin =
      builtinCandidate.length > 0 &&
      SHELL_BUILTIN_COMMANDS.has(builtinCandidate);
    if (
      isBuiltin ||
      failureTextLower.includes("shell builtin")
    ) {
      return {
        key: "system-bash-shell-builtin",
        message:
          "Shell builtins (for example `set`, `cd`, `export`) are not standalone executables. " +
          "If you need shell semantics on the host, retry in `system.bash` shell mode by putting the full shell command in `command` and omitting `args`.",
      };
    }
    if (spawnEnoentCommand) {
      const missingCommand = commandBasename(spawnEnoentCommand);
      return {
        key: `system-bash-missing-command:${missingCommand}`,
        message:
          `The executable \`${missingCommand}\` was not found on the host PATH. ` +
          "If this is a project-local Node/TypeScript tool, rerun it via `npx`, `npm exec --`, or `npm run` from the correct `cwd` " +
          `(for example \`npx ${missingCommand}\`). Otherwise install the tool first or call the correct executable instead of retrying the same missing command.`,
      };
    }
    if (
      failureTextLower.includes("one executable token") ||
      failureTextLower.includes("shell operators/newlines")
    ) {
      return {
        key: "system-bash-command-shape",
        message:
          "In `system.bash` direct mode, `command` must be a single executable token and flags belong in `args`. " +
          "If you need pipes, redirection, heredocs, chaining, or other shell syntax on the host, retry with the full shell command in `command` and omit `args`.",
      };
    }
    const deniedCommand = extractDeniedCommand(failureText);
    if (deniedCommand) {
      if (isDestructiveRemovalCommand(deniedCommand)) {
        const rawCommand =
          typeof call.args?.command === "string" ? call.args.command : "";
        if (/(?:^|\/)build(?:[\/\s]|$)|cmakecache\.txt/i.test(rawCommand)) {
          return {
            key: "system-bash-command-denied-rm-build-artifacts",
            message:
              "Destructive deletion is blocked here. For stale generated build artifacts such as `build/` or `CMakeCache.txt`, " +
              "do not retry with `rm`. Reconfigure into a fresh build directory instead (for example `cmake -S . -B build-agenc-fresh`) " +
              "and run build/test verification from that new directory.",
          };
        }
        return {
          key: "system-bash-command-denied-rm",
          message:
            "Destructive file-deletion commands are blocked on system.bash unless the user explicitly asked for deletion. " +
            "Do not retry with `rm`. For rebuild verification, prefer non-destructive commands such as `make clean && make`, `cmake --build . --clean-first`, or another build-system-native clean rebuild path.",
        };
      }
      if (isNodeInterpreterCommand(deniedCommand)) {
        if (isAgencRuntimeNodeInvocation(call.args)) {
          return {
            key: "system-bash-command-denied-node-agenc-runtime",
            message:
              "Node interpreter commands are blocked on system.bash. For daemon checks, invoke the CLI directly: " +
              '`command:"agenc-runtime", args:["status","--output","json"]`.',
          };
        }
        return {
          key: "system-bash-command-denied-node",
          message:
            "Node interpreter commands are blocked on system.bash. Use an allowed host binary directly " +
            "(for example `agenc-runtime`) or run interpreter-based workflows in `desktop.bash`.",
        };
      }
      if (isPythonInterpreterCommand(deniedCommand)) {
        return {
          key: "system-bash-command-denied-python",
          message:
            "Python interpreter commands are blocked on system.bash. " +
            "Use an allowed host binary directly, or run Python workflows in `desktop.bash` after `/desktop attach`.",
        };
      }
    }
  }

  if (
    (call.name.startsWith("system.") &&
      (call.name.endsWith("readFile") ||
        call.name.endsWith("writeFile") ||
        call.name.endsWith("appendFile") ||
        call.name.endsWith("listDir") ||
        call.name.endsWith("stat") ||
        call.name.endsWith("mkdir") ||
        call.name.endsWith("move") ||
        call.name.endsWith("delete"))) &&
    (failureTextLower.includes("path is outside allowed directories") ||
      failureTextLower.includes("access denied: path"))
  ) {
    return {
      key: "filesystem-path-allowlist",
      message:
        "This filesystem tool call was blocked by path allowlisting. " +
        "Use files under allowed roots (`~/.agenc/workspace`, project root, `~/Desktop`, `/tmp`) " +
        "or switch to `system.bash` with an explicit `cwd` for repo-local reads.",
    };
  }

  if (
    failureTextLower.includes("outside the execution envelope roots for this turn") ||
    failureTextLower.includes("delegated workspace root violation")
  ) {
    return {
      key: "delegated-workspace-root-violation",
      message:
        "This child task is scoped to a delegated workspace root and execution envelope. " +
        "Keep file paths under the assigned root, prefer relative paths from that cwd, " +
        "and do not create fallback workspaces elsewhere (for example under `/tmp`).",
      };
  }

  if (
    call.name === "system.browse" ||
    call.name === "system.httpGet" ||
    call.name === "system.httpPost" ||
    call.name === "system.httpFetch"
  ) {
    if (
      failureTextLower.includes("private/loopback address blocked") ||
      failureTextLower.includes("ssrf target blocked")
    ) {
      return {
        key: "localhost-ssrf-blocked",
        message:
          "system.browse/system.http* block localhost/private/internal addresses by design. " +
          "For local service checks on the HOST, use system.bash with curl (e.g. command=\"curl -sSf http://127.0.0.1:PORT\"). " +
          "Desktop tools run inside Docker and CANNOT reach the host's localhost.",
      };
    }
  }

  if (
    (
      call.name === "system.browserAction" ||
      call.name.startsWith("system.browserSession")
    ) &&
    (
      failureTextLower.includes("browser_session.domain_blocked") ||
      failureTextLower.includes("ssrf target blocked") ||
      failureTextLower.includes("private/loopback address blocked")
    )
  ) {
    return {
      key: "localhost-browser-session-blocked",
      message:
        "system.browserSession*/system.browserAction cannot open localhost/private/internal targets. " +
        "For local service checks on the HOST, use system.bash (for example `curl -sSf http://127.0.0.1:PORT` or a host-side Playwright/Chromium command). " +
        "Desktop/container browser tools also cannot reach the host's localhost.",
    };
  }

  return undefined;
}
