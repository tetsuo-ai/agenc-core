#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

type LaneStatus = "pass" | "fail" | "pending";
type Mode =
  | "all"
  | "preflight"
  | "public"
  | "reviewed-public"
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
}

interface CliOptions {
  mode: Mode;
  iterations: number;
  artifactPath: string;
  allowPending: boolean;
  childMaxWaitSeconds: number | null;
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
  artifact           Buyer-facing artifact rail gate, local tests plus live devnet smoke.
  dispute            Dispute lifecycle using the plain devnet smoke.
  explorer           Explorer/indexing visibility gate. Currently required and pending.
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
  --help                         Show this help.

Required env for live protocol lanes:
  CREATOR_WALLET
  WORKER_WALLET
  ARBITER_A_WALLET
  ARBITER_B_WALLET
  ARBITER_C_WALLET
  PROTOCOL_AUTHORITY_WALLET

Optional:
  AGENC_RPC_URL
  AGENC_PROGRAM_ID
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

function pendingLane(lane: string, required: boolean, notes: string): LaneResult {
  const now = new Date().toISOString();
  return {
    lane,
    status: "pending",
    required,
    command: null,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    notes,
    exitCode: null,
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

async function runExplorer(): Promise<LaneResult> {
  return pendingLane(
    "explorer-indexing-visibility",
    true,
    "Missing automated devnet assertion that newly-created, claimed, completed, and disputed task PDAs appear in the explorer/indexing view within the expected polling window.",
  );
}

async function runSafety(): Promise<LaneResult> {
  return runChild("signer-wallet-safety", true, "tsx", ["scripts/marketplace-hardening-devnet-matrix.ts"]);
}

async function runOperator(): Promise<LaneResult> {
  return pendingLane(
    "operator-controls-live-drill",
    true,
    "Requires runtime-host evidence for pause/disable/rollback/alert acknowledgement. This cannot be proven by devnet RPC alone.",
  );
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
  results.push(...(await runArtifact()));
  results.push(await runDispute());
  results.push(await runExplorer());
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
    case "artifact":
      return runArtifact();
    case "dispute":
      return [await runDispute()];
    case "explorer":
      return [await runExplorer()];
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
