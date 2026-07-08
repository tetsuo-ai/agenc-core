#!/usr/bin/env node

import { spawn } from "node:child_process";
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
const OUTPUT_CAPTURE_LIMIT = 64 * 1024;

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
  return {
    id,
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

  for (const setupCommand of task.setupCommands) {
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

function buildTaskReport(args) {
  const notes = args.notes ?? taskNotes(args.rawResults);
  return {
    id: args.task.id,
    ...(args.task.source ? { source: args.task.source } : {}),
    ...(args.task.title ? { title: args.task.title } : {}),
    status: args.status,
    durationMs: Math.round(args.durationMs),
    ...(args.tokens ? { tokens: args.tokens } : {}),
    ...(args.commands.length > 0 ? { commands: args.commands } : {}),
    verifiers: args.verifiers,
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
