#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

type LaneStatus = "pass" | "fail" | "pending";
type Mode =
  | "all"
  | "preflight"
  | "public"
  | "reviewed-public"
  | "contention"
  | "artifact"
  | "dispute"
  | "explorer"
  | "safety"
  | "soak"
  | "operator";

interface LaneResult {
  lane: string;
  status: LaneStatus;
  required: boolean;
  command: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  notes: string;
  exitCode: number | null;
  evidence?: Record<string, unknown>;
}

interface CliOptions {
  mode: Mode;
  iterations: number;
  artifactPath: string;
  allowPending: boolean;
  childMaxWaitSeconds: number | null;
  explorerUrl: string | null;
  explorerWaitSeconds: number;
  explorerPollMs: number;
}

const DEFAULT_ARTIFACT_PATH = path.join(
  os.tmpdir(),
  "agenc-marketplace-mainnet-v1-devnet",
  `mainnet-v1-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}.json`,
);

const VALID_MODES = new Set<Mode>([
  "all",
  "preflight",
  "public",
  "reviewed-public",
  "contention",
  "artifact",
  "dispute",
  "explorer",
  "safety",
  "soak",
  "operator",
]);

function usage(): void {
  process.stdout.write(`Usage:
  npm run smoke:marketplace:mainnet-v1:devnet -- --mode all
  npm run smoke:marketplace:mainnet-v1:devnet -- --mode preflight
  npm run smoke:marketplace:mainnet-v1:devnet -- --mode soak --iterations 3

Modes:
  preflight          RPC reachability and mutation signer-policy hardening.
  public             Public protocol lifecycle using the plain devnet smoke.
  reviewed-public    Creator-review lifecycle gate using the live artifact smoke.
  contention         Live devnet exclusive-claim contention gate.
  artifact           Buyer-facing artifact rail gate, local tests plus live devnet smoke.
  dispute            Dispute lifecycle using the plain devnet smoke.
  explorer           Explorer/indexing visibility using the live artifact smoke.
  safety             Wallet/signer safety gate using hardening matrix.
  soak               Repeated selected devnet smokes for stability evidence.
  operator           Operator-control evidence gate. Currently requires host evidence.
  all                Runs every mainnet-v1 lane.

Flags:
  --mode <mode>                  Defaults to all.
  --iterations <n>               Soak iterations. Defaults to 3.
  --artifact <path>              Evidence JSON output path.
  --allow-pending                Return success even when required lanes are pending.
  --child-max-wait-seconds <n>   Pass-through wait budget for child smokes that support it.
  --explorer-url <url>           Public explorer base URL for the explorer gate.
  --explorer-wait-seconds <n>    Explorer indexing wait budget. Defaults to 180.
  --explorer-poll-ms <n>         Explorer polling interval. Defaults to 5000.
  --help                         Show this help.

Required env for live protocol lanes:
  CREATOR_WALLET
  WORKER_WALLET
  WORKER_B_WALLET
  WORKER_WALLETS (optional comma-separated list for --mode contention)
  ARBITER_A_WALLET
  ARBITER_B_WALLET
  ARBITER_C_WALLET
  PROTOCOL_AUTHORITY_WALLET

Optional:
  AGENC_RPC_URL
  AGENC_PROGRAM_ID
  AGENC_EXPLORER_URL
`);
}

function getFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parsePositiveInteger(value: string | null, fallback: number, name: string): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(): CliOptions {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage();
    process.exit(0);
  }

  const rawMode = getFlagValue("--mode") ?? "all";
  if (!VALID_MODES.has(rawMode as Mode)) {
    throw new Error(`Unsupported --mode ${rawMode}`);
  }

  return {
    mode: rawMode as Mode,
    iterations: parsePositiveInteger(getFlagValue("--iterations"), 3, "--iterations"),
    artifactPath: getFlagValue("--artifact") ?? DEFAULT_ARTIFACT_PATH,
    allowPending: hasFlag("--allow-pending"),
    childMaxWaitSeconds: getFlagValue("--child-max-wait-seconds")
      ? parsePositiveInteger(getFlagValue("--child-max-wait-seconds"), 300, "--child-max-wait-seconds")
      : null,
    explorerUrl: getFlagValue("--explorer-url") ?? process.env.AGENC_EXPLORER_URL ?? null,
    explorerWaitSeconds: parsePositiveInteger(getFlagValue("--explorer-wait-seconds"), 180, "--explorer-wait-seconds"),
    explorerPollMs: parsePositiveInteger(getFlagValue("--explorer-poll-ms"), 5_000, "--explorer-poll-ms"),
  };
}

function childWaitArgs(options: CliOptions): string[] {
  if (options.childMaxWaitSeconds === null) return [];
  return ["--child-max-wait-seconds", String(options.childMaxWaitSeconds)];
}

async function runChild(lane: string, required: boolean, command: string, args: string[]): Promise<LaneResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const displayCommand = [command, ...args].join(" ");
  process.stdout.write(`\n[RUN] ${lane}\n$ ${displayCommand}\n`);

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code));
    child.on("error", (error) => {
      process.stderr.write(`[${lane}] failed to start: ${error.message}\n`);
      resolve(1);
    });
  });

  const finished = Date.now();
  return {
    lane,
    status: exitCode === 0 ? "pass" : "fail",
    required,
    command: displayCommand,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    notes: exitCode === 0 ? "lane command completed" : "lane command failed",
    exitCode,
  };
}

async function runPreflight(): Promise<LaneResult> {
  return runChild("preflight", true, "tsx", ["scripts/marketplace-hardening-devnet-matrix.ts"]);
}

async function runPublic(): Promise<LaneResult> {
  return runChild("public-task-lifecycle", true, "tsx", ["scripts/marketplace-devnet-smoke.ts"]);
}

async function runDispute(): Promise<LaneResult> {
  return runChild("dispute-lifecycle", true, "tsx", ["scripts/marketplace-devnet-smoke.ts"]);
}

async function runArtifact(): Promise<LaneResult[]> {
  const localArtifactTests = await runChild("artifact-result-rail-local", true, "npm", [
    "run",
    "test",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "src/marketplace/artifact-delivery.test.ts",
    "src/tools/agenc/mutation-tools.test.ts",
  ]);

  return [
    localArtifactTests,
    await runChild(
      "artifact-result-rail-live-devnet",
      true,
      "tsx",
      [
        "scripts/marketplace-devnet-smoke.ts",
        "--flow",
        "reviewed-public-artifact",
      ],
    ),
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeBaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

async function fetchExplorerJson(baseUrl: string, pathname: string): Promise<Record<string, unknown>> {
  const url = new URL(pathname, `${baseUrl}/`);
  const response = await fetch(url);
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`${url.toString()} returned non-JSON response: ${body.slice(0, 160)}`);
  }
  if (!response.ok) {
    const error = asRecord(parsed).error ?? response.statusText;
    throw new Error(`${url.toString()} failed with ${response.status}: ${String(error)}`);
  }
  return asRecord(parsed);
}

type ExplorerVisibilityEvidence = {
  baseUrl: string;
  taskPda: string;
  expectedProgramId: string;
  attempts: number;
  observedAt: string;
  health: Record<string, unknown>;
  bootstrapMeta: Record<string, unknown>;
  task: Record<string, unknown>;
  listTotal: number;
};

async function waitForExplorerTaskVisibility(params: {
  baseUrl: string;
  taskPda: string;
  expectedProgramId: string;
  waitSeconds: number;
  pollMs: number;
}): Promise<ExplorerVisibilityEvidence> {
  const deadline = Date.now() + params.waitSeconds * 1_000;
  let attempts = 0;
  let lastError: string | null = null;

  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      const [health, bootstrap, detail, list] = await Promise.all([
        fetchExplorerJson(params.baseUrl, "/healthz"),
        fetchExplorerJson(params.baseUrl, "/api/bootstrap"),
        fetchExplorerJson(params.baseUrl, `/api/tasks/${encodeURIComponent(params.taskPda)}`),
        fetchExplorerJson(params.baseUrl, `/api/tasks?q=${encodeURIComponent(params.taskPda)}&pageSize=5`),
      ]);
      const bootstrapMeta = asRecord(asRecord(bootstrap.dashboard).meta);
      const detailTask = asRecord(detail.data);
      const listData = asRecord(list.data);
      const listItems = Array.isArray(listData.items) ? listData.items : [];
      const listHasTask = listItems.some((item) => asRecord(item).pda === params.taskPda);
      const programId = String(health.programId ?? bootstrapMeta.programId ?? "");
      const taskStatus = String(detailTask.status ?? "");

      if (programId !== params.expectedProgramId) {
        throw new Error(`explorer program mismatch: expected ${params.expectedProgramId}, got ${programId}`);
      }
      if (detailTask.pda !== params.taskPda) {
        throw new Error(`explorer task detail mismatch: expected ${params.taskPda}, got ${String(detailTask.pda ?? "")}`);
      }
      if (taskStatus.trim().toLowerCase() !== "completed") {
        throw new Error(`explorer task ${params.taskPda} is visible but status=${taskStatus}`);
      }
      if (!listHasTask) {
        throw new Error(`explorer task ${params.taskPda} detail is visible but list/search does not include it`);
      }

      return {
        baseUrl: params.baseUrl,
        taskPda: params.taskPda,
        expectedProgramId: params.expectedProgramId,
        attempts,
        observedAt: new Date().toISOString(),
        health,
        bootstrapMeta,
        task: detailTask,
        listTotal: Number(listData.total ?? listItems.length),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(params.pollMs);
    }
  }

  throw new Error(
    `explorer did not index completed task ${params.taskPda} within ${params.waitSeconds}s` +
      (lastError ? `; last error: ${lastError}` : ""),
  );
}

async function runReviewedPublic(): Promise<LaneResult> {
  return runChild(
    "reviewed-public-lifecycle",
    true,
    "tsx",
    [
      "scripts/marketplace-devnet-smoke.ts",
      "--flow",
      "reviewed-public-artifact",
    ],
  );
}

async function runContention(): Promise<LaneResult> {
  return runChild(
    "exclusive-claim-contention-live-devnet",
    true,
    "tsx",
    [
      "scripts/marketplace-devnet-smoke.ts",
      "--flow",
      "claim-contention",
    ],
  );
}

async function runExplorer(options: CliOptions): Promise<LaneResult> {
  if (!options.explorerUrl) {
    return {
      lane: "explorer-indexing-visibility",
      status: "fail",
      required: true,
      command: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      notes: "AGENC_EXPLORER_URL or --explorer-url is required for the explorer gate",
      exitCode: null,
    };
  }

  const smokeArtifactPath = path.join(
    os.tmpdir(),
    "agenc-marketplace-mainnet-v1-devnet",
    `explorer-reviewed-public-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}.json`,
  );
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const lifecycle = await runChild(
    "explorer-indexing-visibility",
    true,
    "tsx",
    [
      "scripts/marketplace-devnet-smoke.ts",
      "--flow",
      "reviewed-public-artifact",
      "--artifact",
      smokeArtifactPath,
    ],
  );
  if (lifecycle.status !== "pass") {
    return lifecycle;
  }

  try {
    const smokeArtifact = asRecord(JSON.parse(await readFile(smokeArtifactPath, "utf8")));
    const taskPda = String(smokeArtifact.taskPda ?? "");
    const programId = String(smokeArtifact.programId ?? "");
    if (!taskPda || !programId) {
      throw new Error(`smoke artifact ${smokeArtifactPath} is missing taskPda or programId`);
    }
    const evidence = await waitForExplorerTaskVisibility({
      baseUrl: normalizeBaseUrl(options.explorerUrl),
      taskPda,
      expectedProgramId: programId,
      waitSeconds: options.explorerWaitSeconds,
      pollMs: options.explorerPollMs,
    });
    const finished = Date.now();
    return {
      ...lifecycle,
      command:
        `${lifecycle.command} && poll ${evidence.baseUrl}/api/tasks/${taskPda}`,
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: lifecycle.durationMs + (finished - started),
      notes:
        `explorer indexed completed task ${taskPda} after ${evidence.attempts} attempt(s); ` +
        `smokeArtifact=${smokeArtifactPath}`,
      evidence: {
        explorerUrl: evidence.baseUrl,
        taskPda: evidence.taskPda,
        observedAt: evidence.observedAt,
        attempts: evidence.attempts,
        programId: String(evidence.health.programId ?? evidence.bootstrapMeta.programId ?? ""),
        slot: evidence.bootstrapMeta.slot ?? null,
        taskStatus: evidence.task.status ?? null,
        taskJobSpecPresent: evidence.task.jobSpec !== null && evidence.task.jobSpec !== undefined,
        listTotal: evidence.listTotal,
      },
    };
  } catch (error) {
    const finished = Date.now();
    return {
      ...lifecycle,
      status: "fail",
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: lifecycle.durationMs + (finished - started),
      notes: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

async function runSafety(): Promise<LaneResult> {
  return runChild("signer-wallet-safety", true, "tsx", ["scripts/marketplace-hardening-devnet-matrix.ts"]);
}

async function runOperator(): Promise<LaneResult> {
  const outputPath = path.join(
    os.tmpdir(),
    "agenc-marketplace-mainnet-v1-devnet",
    `operator-live-drill-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}.json`,
  );
  const result = await runChild(
    "operator-controls-live-drill",
    true,
    "tsx",
    ["scripts/compiled-job-phase1-operator-drill.ts", "--output", outputPath],
  );
  if (result.status === "fail") {
    return result;
  }

  try {
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as {
      overallPassed?: unknown;
      alertRoutingStatus?: { status?: unknown };
      onCallStatus?: { status?: unknown };
    };
    if (parsed.overallPassed === true) {
      return {
        ...result,
        notes: `operator live drill passed with artifact ${outputPath}`,
      };
    }
    return {
      ...result,
      status: "fail",
      notes:
        `operator live drill did not pass; artifact=${outputPath}, ` +
        `alertRouting=${String(parsed.alertRoutingStatus?.status ?? "unknown")}, ` +
        `onCall=${String(parsed.onCallStatus?.status ?? "unknown")}`,
    };
  } catch (error) {
    return {
      ...result,
      status: "fail",
      notes: `operator live drill artifact could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function runSoak(options: CliOptions): Promise<LaneResult[]> {
  const results: LaneResult[] = [];
  for (let index = 1; index <= options.iterations; index += 1) {
    results.push(
      await runChild(`soak-tui-${index}`, true, "tsx", [
        "scripts/marketplace-tui-devnet-smoke.ts",
        ...childWaitArgs(options),
      ]),
    );
  }
  return results;
}

async function runAll(options: CliOptions): Promise<LaneResult[]> {
  const results: LaneResult[] = [];
  results.push(await runPreflight());
  results.push(await runPublic());
  results.push(await runReviewedPublic());
  results.push(await runContention());
  results.push(...(await runArtifact()));
  results.push(await runDispute());
  results.push(await runExplorer(options));
  results.push(await runSafety());
  results.push(...(await runSoak(options)));
  results.push(await runOperator());
  return results;
}

async function runSelected(options: CliOptions): Promise<LaneResult[]> {
  switch (options.mode) {
    case "all":
      return runAll(options);
    case "preflight":
      return [await runPreflight()];
    case "public":
      return [await runPublic()];
    case "reviewed-public":
      return [await runReviewedPublic()];
    case "contention":
      return [await runContention()];
    case "artifact":
      return runArtifact();
    case "dispute":
      return [await runDispute()];
    case "explorer":
      return [await runExplorer(options)];
    case "safety":
      return [await runSafety()];
    case "soak":
      return runSoak(options);
    case "operator":
      return [await runOperator()];
  }
}

async function writeArtifact(artifactPath: string, results: LaneResult[], options: CliOptions): Promise<void> {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  const payload = {
    kind: "agenc.marketplace.mainnetV1DevnetReadiness",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    issue: "https://github.com/tetsuo-ai/agenc-core/issues/549",
    scope: {
      included: [
        "core protocol task lifecycle",
        "CLI/runtime task creation and completion",
        "reviewed-public settlement",
        "exclusive claim contention",
        "artifact result rail",
        "dispute lifecycle",
        "explorer/indexing visibility",
        "signer and wallet safety",
        "operator controls",
      ],
      excluded: [
        "Private ZK marketplace tasks",
        "storefront/no-code checkout",
        "AgenC Lab/Telegram buyer rails",
      ],
    },
    options,
    results,
  };
  await writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const options = parseOptions();
  const results = await runSelected(options);
  await writeArtifact(options.artifactPath, results, options);

  const failures = results.filter((result) => result.required && result.status === "fail");
  const pending = results.filter((result) => result.required && result.status === "pending");

  process.stdout.write(`\n[artifact] ${options.artifactPath}\n`);
  process.stdout.write(`[summary] pass=${results.filter((r) => r.status === "pass").length} fail=${failures.length} pending=${pending.length}\n`);

  if (failures.length > 0 || (pending.length > 0 && !options.allowPending)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
