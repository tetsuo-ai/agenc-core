#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  aggregateMetrics,
  createStepMetrics,
  finalizeMetrics,
  findSessionRollout,
  findSessionRolloutForWorkspace,
  observePromptEvent,
  observeRolloutRecord,
  readRolloutDelta,
} from "./eval/session-metrics.mjs";
import { trustWorkspace } from "./eval/workspace-trust.mjs";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const runtimeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const schemaPath = path.join(
  runtimeRoot,
  "src",
  "eval",
  "agent-eval-report.schema.json",
);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// The agent command in --output-format json prints one result object that
// carries every event of the run; 64 KiB truncated it and lost the token usage.
const OUTPUT_CAPTURE_LIMIT = 8 * 1024 * 1024;

function usage() {
  return [
    "Usage: node scripts/run-agent-eval.mjs --tasks <manifest.json> [options]",
    "       node scripts/run-agent-eval.mjs --suite <dir> [options]",
    "",
    "Runs a local agent-evaluation manifest and writes an AgenC eval report.",
    "",
    "Options:",
    "  --suite <dir>           Suite directory containing manifest.json + task dirs",
    "  --output <path>          Write report JSON to path (default: stdout)",
    "  --output-dir <path>     Write one report per matrix entry into a directory",
    "  --config <path>         Model/config matrix JSON ({\"matrix\": [...]})",
    "  --executor <mode>       'real' (default) or 'mock' (scripted solution.sh)",
    "  --agent-command <cmd>   Default shell command for each task",
    "  --setup-command <cmd>   Shell command run in each task workspace before the agent (repeatable; real executor only; same placeholders as --agent-command)",
    "  --benchmark <name>      Override manifest benchmark name",
    "  --run-id <id>           Override generated run id",
    "  --agent-name <name>     Agent name for report metadata (default: agenc)",
    "  --agent-version <ver>   Agent version for report metadata",
    "  --provider <name>       Provider label for report metadata",
    "  --model <name>          Model label for report metadata",
    "  --repo <path>           Repository/workspace path (default: cwd)",
    "  --timeout-ms <ms>       Per-command timeout (default: 600000)",
    "  --keep-workspaces       Do not delete per-task fixture workspaces",
    "",
    "Session tasks (manifest task.kind = 'session') drive one daemon session",
    "through task.steps[].prompt over the AgenC SDK. They require AGENC_HOME to",
    "point at an isolated home whose config selects the model under test; the",
    "runner refuses to start a daemon in the default home.",
    "",
    "Task commands may use placeholders: {prompt}, {promptJson}, {taskId}, {cwd},",
    "and {taskDir} (for suite tasks with a dir).",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    help: false,
    tasksPath: undefined,
    suitePath: undefined,
    outputPath: undefined,
    outputDir: undefined,
    configPath: undefined,
    executor: "real",
    keepWorkspaces: false,
    agentCommand: undefined,
    setupCommands: [],
    benchmark: undefined,
    runId: undefined,
    agentName: "agenc",
    agentVersion: undefined,
    provider: undefined,
    model: undefined,
    repo: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    const readValue = () => {
      const value = args.shift();
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--tasks":
        parsed.tasksPath = path.resolve(readValue());
        break;
      case "--suite":
        parsed.suitePath = path.resolve(readValue());
        break;
      case "--output":
        parsed.outputPath = path.resolve(readValue());
        break;
      case "--output-dir":
        parsed.outputDir = path.resolve(readValue());
        break;
      case "--config":
        parsed.configPath = path.resolve(readValue());
        break;
      case "--executor": {
        const value = readValue();
        if (value !== "real" && value !== "mock") {
          throw new Error("--executor must be 'real' or 'mock'");
        }
        parsed.executor = value;
        break;
      }
      case "--keep-workspaces":
        parsed.keepWorkspaces = true;
        break;
      case "--agent-command":
        parsed.agentCommand = readValue();
        break;
      case "--setup-command":
        parsed.setupCommands.push(readValue());
        break;
      case "--benchmark":
        parsed.benchmark = readValue();
        break;
      case "--run-id":
        parsed.runId = readValue();
        break;
      case "--agent-name":
        parsed.agentName = readValue();
        break;
      case "--agent-version":
        parsed.agentVersion = readValue();
        break;
      case "--provider":
        parsed.provider = readValue();
        break;
      case "--model":
        parsed.model = readValue();
        break;
      case "--repo":
        parsed.repo = path.resolve(readValue());
        break;
      case "--timeout-ms": {
        const value = Number(readValue());
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("--timeout-ms must be a positive number");
        }
        parsed.timeoutMs = Math.floor(value);
        break;
      }
      default:
        if (arg?.startsWith("-")) {
          throw new Error(`unknown option: ${arg}`);
        }
        throw new Error(`unexpected positional argument: ${arg}`);
    }
  }

  if (!parsed.help) {
    if (parsed.tasksPath && parsed.suitePath) {
      throw new Error("--tasks and --suite are mutually exclusive");
    }
    if (parsed.suitePath) {
      parsed.tasksPath = path.join(parsed.suitePath, "manifest.json");
    }
    if (!parsed.tasksPath) {
      throw new Error("missing required --tasks manifest path (or --suite dir)");
    }
  }
  return parsed;
}

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`failed to read ${label} at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse ${label} at ${filePath}: ${error.message}`);
  }
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function asString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function normalizeManifest(raw, baseDir) {
  const manifest = Array.isArray(raw) ? { tasks: raw } : asObject(raw, "manifest");
  const tasks = manifest.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("manifest.tasks must be a non-empty array");
  }
  return {
    baseDir,
    benchmark: asString(manifest.benchmark) ?? "local-agent-eval",
    agentCommand: asString(manifest.agentCommand),
    timeoutMs:
      typeof manifest.timeoutMs === "number" && Number.isFinite(manifest.timeoutMs)
        ? Math.max(1, Math.floor(manifest.timeoutMs))
        : undefined,
    tasks: tasks.map((task, index) => normalizeTask(task, index)),
  };
}

function normalizeConfig(raw) {
  const config = asObject(raw, "config");
  const matrix = config.matrix;
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new Error("config.matrix must be a non-empty array");
  }
  return matrix.map((entry, index) => {
    const item = asObject(entry, `config.matrix[${index}]`);
    const executor = asString(item.executor);
    if (executor !== undefined && executor !== "real" && executor !== "mock") {
      throw new Error(
        `config.matrix[${index}].executor must be 'real' or 'mock'`,
      );
    }
    return {
      id: asString(item.id) ?? asString(item.model) ?? `entry-${index + 1}`,
      executor,
      agentCommand: asString(item.agentCommand),
      agentName: asString(item.agentName),
      agentVersion: asString(item.agentVersion),
      provider: asString(item.provider),
      model: asString(item.model),
    };
  });
}

function normalizeTask(raw, index) {
  const task = asObject(raw, `manifest.tasks[${index}]`);
  const id = asString(task.id) ?? `task-${index + 1}`;
  const verifiers = task.verifiers;
  if (verifiers !== undefined && !Array.isArray(verifiers)) {
    throw new Error(`task ${id} verifiers must be an array`);
  }
  const kind = asString(task.kind) ?? "command";
  if (kind !== "command" && kind !== "session") {
    throw new Error(`task ${id} kind must be 'command' or 'session'`);
  }
  const steps = kind === "session"
    ? normalizeSteps(task.steps, id)
    : [];
  return {
    id,
    kind,
    steps,
    source: asString(task.source),
    title: asString(task.title),
    prompt: typeof task.prompt === "string" ? task.prompt : "",
    cwd: asString(task.cwd),
    dir: asString(task.dir),
    fixture: asString(task.fixture),
    skip: task.skip === true,
    agentCommand: asString(task.agentCommand ?? task.command),
    mockCommand: asString(task.mockCommand),
    setupCommands: asStringArray(
      task.setupCommands ?? task.setup,
      `task ${id} setupCommands`,
    ),
    verifiers: (verifiers ?? []).map((verifier, verifierIndex) =>
      normalizeVerifier(verifier, id, verifierIndex)),
    riskFlags: asStringArray(task.riskFlags, `task ${id} riskFlags`),
    timeoutMs:
      typeof task.timeoutMs === "number" && Number.isFinite(task.timeoutMs)
        ? Math.max(1, Math.floor(task.timeoutMs))
        : undefined,
  };
}

function normalizeSteps(raw, taskId) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`session task ${taskId} needs a non-empty steps array`);
  }
  const seen = new Set();
  return raw.map((entry, index) => {
    const step = asObject(entry, `task ${taskId} steps[${index}]`);
    const id = asString(step.id) ?? `step-${index + 1}`;
    if (seen.has(id)) throw new Error(`task ${taskId} repeats step id ${id}`);
    seen.add(id);
    const prompt = asString(step.prompt);
    if (!prompt) throw new Error(`task ${taskId} step ${id} is missing prompt`);
    const verifiers = step.verifiers;
    if (verifiers !== undefined && !Array.isArray(verifiers)) {
      throw new Error(`task ${taskId} step ${id} verifiers must be an array`);
    }
    return {
      id,
      prompt,
      verifiers: (verifiers ?? []).map((verifier, verifierIndex) =>
        normalizeVerifier(verifier, `${taskId}/${id}`, verifierIndex)),
      timeoutMs:
        typeof step.timeoutMs === "number" && Number.isFinite(step.timeoutMs)
          ? Math.max(1, Math.floor(step.timeoutMs))
          : undefined,
    };
  });
}

function normalizeVerifier(raw, taskId, index) {
  const verifier = asObject(raw, `task ${taskId} verifiers[${index}]`);
  const name = asString(verifier.name) ?? `verifier-${index + 1}`;
  const command = asString(verifier.command);
  if (!command) {
    throw new Error(`task ${taskId} verifier ${name} is missing command`);
  }
  return { name, command };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

function renderCommand(template, task, cwd, taskDir) {
  if (template.includes("{taskDir}") && !taskDir) {
    throw new Error(
      `task ${task.id} uses {taskDir} but has no dir (suite manifests must set task.dir)`,
    );
  }
  let rendered = template
    .replaceAll("{prompt}", shellQuote(task.prompt))
    .replaceAll("{promptJson}", shellQuote(JSON.stringify(task.prompt)))
    .replaceAll("{taskId}", shellQuote(task.id))
    .replaceAll("{cwd}", shellQuote(cwd));
  if (taskDir) {
    rendered = rendered.replaceAll("{taskDir}", shellQuote(taskDir));
  }
  return rendered;
}

function appendCaptured(output, chunk) {
  if (output.length >= OUTPUT_CAPTURE_LIMIT) return output;
  const next = output + chunk;
  return next.length > OUTPUT_CAPTURE_LIMIT
    ? next.slice(0, OUTPUT_CAPTURE_LIMIT)
    : next;
}

function runCommand(command, options) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    if (typeof timeout.unref === "function") timeout.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendCaptured(stdout, String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendCaptured(stderr, String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: 1,
        durationMs: performance.now() - started,
        stdout,
        stderr: appendCaptured(stderr, error.message),
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: timedOut ? 124 : code ?? (signal ? 1 : 0),
        durationMs: performance.now() - started,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function commandReport(result) {
  return {
    command: result.command,
    exitCode: result.exitCode,
    durationMs: Math.round(result.durationMs),
  };
}

function verifierReport(verifier, result) {
  return {
    name: verifier.name,
    status: result.timedOut ? "error" : result.exitCode === 0 ? "passed" : "failed",
    command: verifier.command,
    ...(result.stderr.trim()
      ? { details: result.stderr.trim().slice(0, 2000) }
      : {}),
  };
}

function extractNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function extractTokens(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  const candidates = [trimmed, ...trimmed.split(/\r?\n/u).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") continue;
      const tokenUsage = parsed.tokenUsage && typeof parsed.tokenUsage === "object"
        ? parsed.tokenUsage
        : undefined;
      const usage = parsed.usage && typeof parsed.usage === "object"
        ? parsed.usage
        : undefined;
      const input = extractNumber(
        tokenUsage?.input,
        tokenUsage?.inputTokens,
        tokenUsage?.promptTokens,
        usage?.promptTokens,
        usage?.prompt_tokens,
      );
      const output = extractNumber(
        tokenUsage?.output,
        tokenUsage?.outputTokens,
        tokenUsage?.completionTokens,
        usage?.completionTokens,
        usage?.completion_tokens,
      );
      const total = extractNumber(
        tokenUsage?.total,
        tokenUsage?.totalTokens,
        usage?.totalTokens,
        usage?.total_tokens,
      );
      if (input !== undefined || output !== undefined || total !== undefined) {
        return {
          ...(input !== undefined ? { input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(total !== undefined ? { total } : {}),
        };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function taskNotes(results) {
  const lines = [];
  for (const result of results) {
    if (result.timedOut) {
      lines.push(`Timed out: ${result.command}`);
    }
    if (result.stderr.trim()) {
      lines.push(`${result.command} stderr: ${result.stderr.trim().slice(0, 500)}`);
    }
  }
  return lines.length > 0 ? lines.join("\n").slice(0, 4000) : undefined;
}

async function runTask(task, manifest, args) {
  if (task.skip) {
    const riskFlags = new Set(task.riskFlags);
    return {
      id: task.id,
      ...(task.source ? { source: task.source } : {}),
      ...(task.title ? { title: task.title } : {}),
      status: "skipped",
      durationMs: 0,
      verifiers: [],
      ...(riskFlags.size > 0 ? { riskFlags: [...riskFlags] } : {}),
    };
  }

  let workspace;
  try {
    if (task.fixture) {
      const taskDir = task.dir ? path.resolve(manifest.baseDir, task.dir) : undefined;
      const fixtureDir = path.resolve(taskDir ?? manifest.baseDir, task.fixture);
      const fixtureStat = await stat(fixtureDir).catch(() => undefined);
      if (!fixtureStat?.isDirectory()) {
        return buildTaskReport({
          task,
          status: "error",
          durationMs: 0,
          commands: [],
          verifiers: [],
          riskFlags: new Set([...task.riskFlags, "fixture_missing"]),
          rawResults: [],
          notes: `Fixture directory not found: ${fixtureDir}`,
        });
      }
      workspace = await mkdtemp(path.join(os.tmpdir(), `agenc-eval-${task.id}-`));
      await cp(fixtureDir, workspace, { recursive: true });
    }
    return await runTaskInWorkspace(task, manifest, args, workspace);
  } finally {
    if (workspace && !args.keepWorkspaces) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function runTaskInWorkspace(task, manifest, args, workspace) {
  const taskStarted = performance.now();
  const taskDir = task.dir ? path.resolve(manifest.baseDir, task.dir) : undefined;
  const cwd = workspace ?? path.resolve(task.cwd ?? args.repo);
  const timeoutMs = task.timeoutMs ?? manifest.timeoutMs ?? args.timeoutMs;
  const commands = [];
  const riskFlags = new Set(task.riskFlags);
  const rawResults = [];

  if (args.executor !== "mock") {
    // Print mode has no TTY, so the trust prompt cannot run; trust the
    // workspace inside the isolated home before anything executes there.
    trustWorkspace({ agencHome: requireIsolatedHome(process.env), workspace: cwd });
  }
  const setupCommands = args.executor === "mock"
    ? task.setupCommands
    : [...(args.setupCommands ?? []), ...task.setupCommands];
  for (const setupCommand of setupCommands) {
    const rendered = renderCommand(setupCommand, task, cwd, taskDir);
    const result = await runCommand(rendered, { cwd, timeoutMs });
    commands.push(commandReport(result));
    rawResults.push(result);
    if (result.timedOut) riskFlags.add("setup_timeout");
    if (result.exitCode !== 0) riskFlags.add("setup_failed");
    if (result.exitCode !== 0) {
      return buildTaskReport({
        task,
        status: "error",
        durationMs: performance.now() - taskStarted,
        commands,
        verifiers: [],
        riskFlags,
        rawResults,
      });
    }
  }

  if (task.kind === "session") {
    return args.executor === "mock"
      ? runMockSessionTask({ task, taskDir, cwd, timeoutMs, commands, riskFlags, rawResults, taskStarted })
      : runSessionTask({ task, taskDir, cwd, timeoutMs, commands, riskFlags, rawResults, taskStarted });
  }

  const agentCommand = args.executor === "mock"
    ? task.mockCommand ?? (taskDir ? "bash {taskDir}/solution.sh" : undefined)
    : task.agentCommand ?? manifest.agentCommand ?? args.agentCommand;
  let agentResult;
  if (!agentCommand) {
    riskFlags.add(
      args.executor === "mock" ? "mock_command_missing" : "agent_command_missing",
    );
    return buildTaskReport({
      task,
      status: "error",
      durationMs: performance.now() - taskStarted,
      commands,
      verifiers: [],
      riskFlags,
      rawResults,
      notes: args.executor === "mock"
        ? "No mock command or task dir with solution.sh configured for task."
        : "No agent command configured for task or manifest.",
    });
  }
  agentResult = await runCommand(renderCommand(agentCommand, task, cwd, taskDir), {
    cwd,
    timeoutMs,
    // The AgenC CLI lets AGENC_WORKSPACE take precedence over the invocation
    // directory. The first real run inherited an operator's workspace from the
    // shell and judged every task against that directory instead of its
    // fixture. Pin the workspace to the task's own directory.
    env: { ...process.env, AGENC_WORKSPACE: cwd },
  });
  commands.push(commandReport(agentResult));
  rawResults.push(agentResult);
  if (agentResult.timedOut) riskFlags.add("agent_timeout");
  if (agentResult.exitCode !== 0) riskFlags.add("agent_command_failed");

  const verifiers = [];
  if (agentResult.exitCode === 0) {
    for (const verifier of task.verifiers) {
      const result = await runCommand(
        renderCommand(verifier.command, task, cwd, taskDir),
        {
          cwd,
          timeoutMs,
        },
      );
      rawResults.push(result);
      verifiers.push(verifierReport(verifier, result));
      if (result.timedOut) riskFlags.add("verifier_timeout");
      if (result.exitCode !== 0) riskFlags.add("verifier_failed");
    }
  }

  const status = agentResult.exitCode !== 0
    ? "error"
    : verifiers.some((verifier) => verifier.status === "error")
      ? "error"
      : verifiers.some((verifier) => verifier.status === "failed")
        ? "failed"
        : "passed";

  return buildTaskReport({
    task,
    status,
    durationMs: performance.now() - taskStarted,
    commands,
    verifiers,
    riskFlags,
    rawResults,
    tokens: extractTokens(agentResult.stdout),
  });
}

async function runStepVerifiers(step, task, cwd, taskDir, timeoutMs, rawResults, riskFlags) {
  const verifiers = [];
  for (const verifier of step.verifiers) {
    const result = await runCommand(renderCommand(verifier.command, task, cwd, taskDir), {
      cwd,
      timeoutMs,
    });
    rawResults.push(result);
    verifiers.push(verifierReport(verifier, result));
    if (result.timedOut) riskFlags.add("verifier_timeout");
    if (result.exitCode !== 0) riskFlags.add("verifier_failed");
  }
  return verifiers;
}

function verifierStatus(verifiers) {
  if (verifiers.some((verifier) => verifier.status === "error")) return "error";
  if (verifiers.some((verifier) => verifier.status === "failed")) return "failed";
  return "passed";
}

function sessionStatus(steps, verifiers) {
  const all = new Set([...steps.map((step) => step.status), verifierStatus(verifiers)]);
  if (all.has("error")) return "error";
  if (all.has("failed")) return "failed";
  return "passed";
}

/**
 * Mock executor for a session task: the scripted solution writes the finished
 * project once, then every step's verifiers and the task verifiers run in
 * order. This proves the checkers accept a known-good tree and gives the
 * regression tests a deterministic session report.
 */
async function runMockSessionTask({ task, taskDir, cwd, timeoutMs, commands, riskFlags, rawResults, taskStarted }) {
  const solution = task.mockCommand ?? (taskDir ? "bash {taskDir}/solution.sh" : undefined);
  if (!solution) {
    riskFlags.add("mock_command_missing");
    return buildTaskReport({
      task, status: "error", durationMs: performance.now() - taskStarted, commands, verifiers: [], riskFlags, rawResults,
      notes: "No mock command or task dir with solution.sh configured for session task.",
    });
  }
  const solutionResult = await runCommand(renderCommand(solution, task, cwd, taskDir), { cwd, timeoutMs });
  commands.push(commandReport(solutionResult));
  rawResults.push(solutionResult);
  if (solutionResult.exitCode !== 0) {
    riskFlags.add("agent_command_failed");
    return buildTaskReport({
      task, status: "error", durationMs: performance.now() - taskStarted, commands, verifiers: [], riskFlags, rawResults,
    });
  }
  const steps = [];
  for (const step of task.steps) {
    const stepStarted = performance.now();
    const verifiers = await runStepVerifiers(step, task, cwd, taskDir, step.timeoutMs ?? timeoutMs, rawResults, riskFlags);
    steps.push({
      id: step.id,
      status: verifierStatus(verifiers),
      durationMs: Math.round(performance.now() - stepStarted),
      tokens: { input: 1, output: 1 },
      exitCode: 0,
      metrics: finalizeMetrics(createStepMetrics()),
      verifiers,
    });
  }
  const verifiers = await runStepVerifiers({ verifiers: task.verifiers }, task, cwd, taskDir, timeoutMs, rawResults, riskFlags);
  return buildTaskReport({
    task,
    status: sessionStatus(steps, verifiers),
    durationMs: performance.now() - taskStarted,
    commands,
    verifiers,
    riskFlags,
    rawResults,
    tokens: { input: steps.length, output: steps.length },
    steps,
    metrics: aggregateMetrics(steps.map((step) => step.metrics)),
  });
}

async function loadSdk() {
  const candidates = [
    new URL("../../packages/agenc-sdk/dist/index.js", import.meta.url).href,
    "@tetsuo-ai/agenc-sdk",
  ];
  let lastError;
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `session tasks need the built AgenC SDK (npm run build --workspace=@tetsuo-ai/agenc-sdk): ${lastError?.message ?? "not found"}`,
  );
}

/**
 * The daemon names rollout directories by conversation id, which the SDK does
 * not expose. `agent.logs` reports each session's rolloutPath directly; when
 * that call is unavailable the runner falls back to matching the workspace.
 */
async function rolloutPathFromAgentLogs(client, session) {
  if (!session.agentId || typeof client.agentLogs !== "function") return undefined;
  try {
    const logs = await client.agentLogs(session.agentId);
    const entry = (logs?.sessions ?? []).find(
      (candidate) => candidate.sessionId === session.sessionId && typeof candidate.rolloutPath === "string",
    ) ?? (logs?.sessions ?? []).find((candidate) => typeof candidate.rolloutPath === "string");
    return entry?.rolloutPath;
  } catch {
    return undefined;
  }
}

function requireIsolatedHome(env) {
  const home = env.AGENC_HOME;
  if (typeof home !== "string" || !path.isAbsolute(home)) {
    throw new Error(
      "session tasks require AGENC_HOME set to an absolute, isolated home; the eval runner will not start a daemon in the default home",
    );
  }
  return home;
}

/**
 * Real executor for a session task: one daemon session in the isolated
 * AGENC_HOME, each step a prompt over the SDK. Live prompt events feed the
 * tool-call, re-read, compaction and permission counters; the session rollout
 * feeds token counts, tool errors and compaction attempts after each step.
 */
const DENY_APPROVALS = () => ({ behavior: "deny", reason: "eval runner denies interactive approvals" });

function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const out = {};
  if (Number.isFinite(usage.inputTokens)) out.input = usage.inputTokens;
  if (Number.isFinite(usage.outputTokens)) out.output = usage.outputTokens;
  if (Number.isFinite(usage.totalTokens)) out.total = usage.totalTokens;
  return out;
}

function addTokens(tokens, stepTokens) {
  if (!stepTokens) return;
  tokens.input += stepTokens.input ?? 0;
  tokens.output += stepTokens.output ?? 0;
  tokens.total += stepTokens.total ?? (stepTokens.input ?? 0) + (stepTokens.output ?? 0);
}

function stopReasonOf(stepResult) {
  return stepResult?.stopReason ? String(stepResult.stopReason) : undefined;
}

function stepOutcome({ step, stepResult, stepError, metrics, riskFlags }) {
  if (stepError) {
    riskFlags.add("agent_command_failed");
    return {
      exitCode: 1,
      stopReason: stopReasonOf(stepResult),
      notes: `step ${step.id}: ${stepError.message}`.slice(0, 1000),
    };
  }
  // A turn the provider dropped after dispatch "completes" with an empty
  // message and exit 0. That is not a pass: the prompt did no work.
  const providerDropped = metrics.providerFailures > 0
    && metrics.toolCalls === 0
    && (stepResult?.finalMessage ?? "").trim().length === 0;
  if (providerDropped) {
    riskFlags.add("provider_call_failed");
    riskFlags.add("agent_command_failed");
    return {
      exitCode: 1,
      stopReason: "provider_failed",
      notes: `step ${step.id}: the provider call failed after dispatch and the turn completed empty`,
    };
  }
  const exitCode = stepResult?.exitCode ?? 1;
  if (exitCode !== 0) riskFlags.add("agent_command_failed");
  return { exitCode, stopReason: stopReasonOf(stepResult), notes: undefined };
}

async function promptStep({ session, task, step, metrics, timeoutMs, riskFlags }) {
  const controller = new AbortController();
  const stepTimeout = step.timeoutMs ?? timeoutMs;
  const timer = setTimeout(
    () => controller.abort(new Error(`step ${step.id} exceeded ${stepTimeout} ms`)),
    stepTimeout,
  );
  try {
    const run = session.prompt(step.prompt, {
      includeUsage: true,
      clientMessageId: `eval-${task.id}-${step.id}`,
      signal: controller.signal,
      onPermissionRequest: DENY_APPROVALS,
    });
    for await (const event of run) observePromptEvent(metrics, event);
    return { stepResult: await run.result() };
  } catch (error) {
    if (controller.signal.aborted) riskFlags.add("agent_timeout");
    return { stepError: error };
  } finally {
    clearTimeout(timer);
  }
}

function createRolloutTracker({ client, session, agencHome, cwd, sinceMs, riskFlags }) {
  let rolloutPath;
  let offset = 0;
  return {
    get path() {
      return rolloutPath;
    },
    async observe(metrics) {
      rolloutPath ??= (await rolloutPathFromAgentLogs(client, session))
        ?? findSessionRolloutForWorkspace(agencHome, cwd, sinceMs)
        ?? findSessionRollout(agencHome, session.sessionId);
      if (!rolloutPath) {
        riskFlags.add("rollout_not_found");
        return;
      }
      const delta = readRolloutDelta(rolloutPath, offset);
      offset = delta.offset;
      for (const record of delta.records) observeRolloutRecord(metrics, record);
    },
  };
}

async function runSessionStep({ session, rollout, task, step, cwd, taskDir, timeoutMs, rawResults, riskFlags, tokens }) {
  const stepStarted = performance.now();
  const metrics = createStepMetrics();
  const { stepResult, stepError } = await promptStep({ session, task, step, metrics, timeoutMs, riskFlags });
  await rollout.observe(metrics);
  const stepTokens = usageTokens(stepResult?.usage);
  addTokens(tokens, stepTokens);
  const { exitCode, stopReason, notes } = stepOutcome({ step, stepResult, stepError, metrics, riskFlags });
  const verifiers = exitCode === 0
    ? await runStepVerifiers(step, task, cwd, taskDir, timeoutMs, rawResults, riskFlags)
    : [];
  return {
    id: step.id,
    status: exitCode !== 0 ? "error" : verifierStatus(verifiers),
    durationMs: Math.round(performance.now() - stepStarted),
    ...(stepTokens ? { tokens: stepTokens } : {}),
    ...(stopReason ? { stopReason } : {}),
    exitCode,
    metrics: finalizeMetrics(metrics),
    verifiers,
    ...(notes ? { notes } : {}),
  };
}

function describeSession(session, rolloutPath) {
  if (!session) return "session was not created";
  const rolloutNote = rolloutPath ? ` rollout ${path.basename(rolloutPath)}` : " (rollout not found)";
  return `session ${session.sessionId}${rolloutNote}`;
}

async function runSessionTask({ task, taskDir, cwd, timeoutMs, commands, riskFlags, rawResults, taskStarted }) {
  const agencHome = requireIsolatedHome(process.env);
  const sdk = await loadSdk();
  const client = await sdk.connect({
    env: process.env,
    clientName: "agenc-eval",
    onPermissionRequest: DENY_APPROVALS,
  });
  const steps = [];
  const tokens = { input: 0, output: 0, total: 0 };
  let session;
  let rollout;
  // Rollouts written before this instant belong to earlier sessions in the home.
  const sessionStartedMs = Date.now() - 5000;
  try {
    session = await client.createSession({
      cwd,
      pluginStorageRoot: path.join(agencHome, "plugins"),
      dangerouslyBypassApprovalsAndSandbox: true,
      metadata: { evalTaskId: task.id, evalRunner: "run-agent-eval" },
    });
    rollout = createRolloutTracker({ client, session, agencHome, cwd, sinceMs: sessionStartedMs, riskFlags });
    for (const step of task.steps) {
      const record = await runSessionStep({
        session, rollout, task, step, cwd, taskDir, timeoutMs, rawResults, riskFlags, tokens,
      });
      steps.push(record);
      if (record.exitCode !== 0) break;
    }
  } finally {
    if (session) {
      await session.terminate("eval session complete").catch(() => {});
    }
    await client.close().catch(() => {});
  }
  const completed = steps.length === task.steps.length && steps.every((step) => step.status !== "error");
  const verifiers = completed
    ? await runStepVerifiers({ verifiers: task.verifiers }, task, cwd, taskDir, timeoutMs, rawResults, riskFlags)
    : [];
  return buildTaskReport({
    task,
    status: completed ? sessionStatus(steps, verifiers) : "error",
    durationMs: performance.now() - taskStarted,
    commands,
    verifiers,
    riskFlags,
    rawResults,
    tokens: tokens.total > 0 || tokens.input > 0 ? tokens : undefined,
    steps,
    metrics: aggregateMetrics(steps.map((step) => step.metrics)),
    notes: [describeSession(session, rollout?.path), taskNotes(rawResults)].filter(Boolean).join("\n").slice(0, 4000),
  });
}

function buildTaskReport(args) {
  const notes = args.notes ?? taskNotes(args.rawResults);
  return {
    id: args.task.id,
    ...(args.task.source ? { source: args.task.source } : {}),
    ...(args.task.title ? { title: args.task.title } : {}),
    ...(args.task.kind === "session" ? { kind: "session" } : {}),
    status: args.status,
    durationMs: Math.round(args.durationMs),
    ...(args.tokens ? { tokens: args.tokens } : {}),
    ...(args.commands.length > 0 ? { commands: args.commands } : {}),
    verifiers: args.verifiers,
    ...(args.steps ? { steps: args.steps } : {}),
    ...(args.metrics ? { metrics: args.metrics } : {}),
    ...(args.riskFlags.size > 0 ? { riskFlags: [...args.riskFlags].sort() } : {}),
    ...(notes ? { notes } : {}),
  };
}

async function gitValue(repo, command) {
  const result = await runCommand(command, { cwd: repo, timeoutMs: 5000 });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function buildEnvironment(repo, executor, fingerprint) {
  const [commit, branch] = await Promise.all([
    gitValue(repo, "git rev-parse --short HEAD"),
    gitValue(repo, "git branch --show-current"),
  ]);
  return {
    repo,
    ...(commit ? { commit } : {}),
    ...(branch ? { branch } : {}),
    runner: "local",
    sandbox: "local",
    localOnly: true,
    ...(executor ? { executor } : {}),
    ...(fingerprint ? { configFingerprint: fingerprint } : {}),
  };
}

function computeConfigFingerprint(manifest, effective) {
  const material = JSON.stringify({
    benchmark: effective.benchmark ?? manifest.benchmark,
    executor: effective.executor,
    agentCommand: effective.agentCommand ?? manifest.agentCommand ?? null,
    agent: {
      name: effective.agentName ?? null,
      provider: effective.provider ?? null,
      model: effective.model ?? null,
    },
    tasks: manifest.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      steps: task.steps.map((step) => ({
        id: step.id,
        prompt: step.prompt,
        verifiers: step.verifiers,
      })),
      prompt: task.prompt,
      setupCommands: task.setupCommands,
      agentCommand: task.agentCommand ?? null,
      mockCommand: task.mockCommand ?? null,
      verifiers: task.verifiers,
    })),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function compileValidator(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const [schema, rawManifest] = await Promise.all([
    readJson(schemaPath, "agent eval report schema"),
    readJson(args.tasksPath, "agent eval manifest"),
  ]);
  const manifest = normalizeManifest(rawManifest, path.dirname(args.tasksPath));
  const entries = args.configPath
    ? normalizeConfig(await readJson(args.configPath, "eval config"))
    : [undefined];
  if (entries.length > 1 && !args.outputDir) {
    throw new Error(
      "--output-dir is required when config.matrix has more than one entry",
    );
  }
  if (args.outputDir) {
    await mkdir(args.outputDir, { recursive: true });
  }
  const validate = compileValidator(schema);

  for (const entry of entries) {
    const effective = {
      ...args,
      benchmark: args.benchmark ?? manifest.benchmark,
      executor: entry?.executor ?? args.executor,
      agentCommand: entry?.agentCommand ?? args.agentCommand,
      agentName: entry?.agentName ?? args.agentName,
      agentVersion: entry?.agentVersion ?? args.agentVersion,
      provider: entry?.provider ?? args.provider,
      model: entry?.model ?? args.model,
    };
    const fingerprint = computeConfigFingerprint(manifest, effective);
    const startedAt = new Date().toISOString();
    const tasks = [];
    for (const task of manifest.tasks) {
      tasks.push(await runTask(task, manifest, effective));
    }
    const finishedAt = new Date().toISOString();
    const runId = args.runId ?? `local-${randomUUID()}`;
    const report = {
      schemaVersion: 1,
      run: {
        id: entry ? `${runId}-${entry.id}` : runId,
        benchmark: effective.benchmark,
        startedAt,
        finishedAt,
        agent: {
          name: effective.agentName,
          ...(effective.agentVersion ? { version: effective.agentVersion } : {}),
          ...(effective.provider ? { provider: effective.provider } : {}),
          ...(effective.model ? { model: effective.model } : {}),
        },
        environment: await buildEnvironment(
          args.repo,
          effective.executor,
          fingerprint,
        ),
      },
      tasks,
    };

    if (!validate(report)) {
      throw new Error(
        `generated eval report failed schema validation:\n${formatAjvErrors(validate.errors)}`,
      );
    }

    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (args.outputDir) {
      const reportPath = path.join(
        args.outputDir,
        `report-${entry?.id ?? "default"}.json`,
      );
      await writeFile(reportPath, output, "utf8");
      process.stdout.write(`Wrote eval report: ${reportPath}\n`);
      continue;
    }
    if (args.outputPath) {
      await writeFile(args.outputPath, output, "utf8");
      process.stdout.write(`Wrote eval report: ${args.outputPath}\n`);
      continue;
    }
    process.stdout.write(output);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
