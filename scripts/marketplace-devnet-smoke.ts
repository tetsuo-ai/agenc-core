#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { AnchorProvider, type Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import {
  AgentCapabilities,
  createProgram,
  createReadOnlyProgram,
  findProtocolPda,
  hasCapability,
  keypairToWallet,
  loadKeypairFromFileSync,
  parseAgentState,
  parseProtocolConfig,
  silentLogger,
  type AgencCoordination,
  type ProtocolConfig,
} from "../runtime/src/index.js";
import {
  resetMarketplaceCliProgramContextOverrides,
  runMarketDisputeDetailCommand,
  runMarketDisputeResolveCommand,
  runMarketTaskClaimCommand,
  runMarketTaskCreateCommand,
  runMarketTaskDetailCommand,
  runMarketTaskDisputeCommand,
  setMarketplaceCliProgramContextOverrides,
} from "../runtime/src/cli/marketplace-cli.js";
import type { BaseCliOptions, CliRuntimeContext } from "../runtime/src/cli/types.js";
import { DisputeOperations } from "../runtime/src/dispute/operations.js";
import { createAgencTools } from "../runtime/src/tools/agenc/index.js";

const DEFAULT_RPC_URL =
  process.env.AGENC_RPC_URL ?? "https://api.devnet.solana.com";
const DEFAULT_REWARD_LAMPORTS = 10_000_000n;
const DEFAULT_MAX_WAIT_SECONDS = 90;
const DEFAULT_ENDPOINT_BASE = "https://agenc.local";
const DEFAULT_FEE_BUFFER_LAMPORTS = 20_000_000n;
const DEFAULT_AUTHORITY_FEE_BUFFER_LAMPORTS = 10_000_000n;
const ARTIFACT_DIR = path.join(os.tmpdir(), "agenc-marketplace-smoke");

interface SignerContext {
  label: string;
  walletPath: string;
  keypair: Keypair;
  program: Program<AgencCoordination>;
}

interface AgentActor extends SignerContext {
  agentPda: PublicKey;
  agentId: Uint8Array;
}

interface SmokeRuntime {
  connection: Connection;
  readOnlyProgram: Program<AgencCoordination>;
  signersByKey: Map<string, SignerContext>;
}

interface SmokeArtifact {
  version: 1;
  kind: "marketplace-devnet-smoke";
  createdAt: string;
  rpcUrl: string;
  programId: string;
  runId: string;
  description: string;
  rewardLamports: string;
  authorityPubkey: string;
  creatorAgentPda: string;
  workerAgentPda: string;
  workerClaimPda: string;
  taskPda: string;
  disputePda: string;
  votingDeadline: number;
  arbiterVotes: Array<{ votePda: string; arbiterAgentPda: string }>;
}

type MarketRunner = (
  context: CliRuntimeContext,
  options: Record<string, unknown>,
) => Promise<0 | 1 | 2>;

let activeSignerKey: string | null = null;

function usage(): void {
  process.stdout.write(`Usage:
  CREATOR_WALLET=/path/to/creator.json \\
  WORKER_WALLET=/path/to/worker.json \\
  ARBITER_A_WALLET=/path/to/arbiter-a.json \\
  ARBITER_B_WALLET=/path/to/arbiter-b.json \\
  ARBITER_C_WALLET=/path/to/arbiter-c.json \\
  PROTOCOL_AUTHORITY_WALLET=/path/to/authority.json \\
  npm run smoke:marketplace:devnet

  PROTOCOL_AUTHORITY_WALLET=/path/to/authority.json \\
  npm run smoke:marketplace:devnet -- --resume /tmp/agenc-marketplace-smoke/marketplace-devnet-smoke-....json

Environment:
  CREATOR_WALLET                Required for initial run.
  WORKER_WALLET                 Required for initial run.
  ARBITER_A_WALLET              Required for initial run.
  ARBITER_B_WALLET              Required for initial run.
  ARBITER_C_WALLET              Required for initial run.
  PROTOCOL_AUTHORITY_WALLET     Required in both modes.
  AGENC_RPC_URL                 Optional. Defaults to ${DEFAULT_RPC_URL}
  AGENC_PROGRAM_ID              Optional. Defaults to the runtime program ID.
  AGENC_REWARD_LAMPORTS         Optional. Defaults to ${DEFAULT_REWARD_LAMPORTS.toString()}
  AGENC_MAX_WAIT_SECONDS        Optional. Defaults to ${DEFAULT_MAX_WAIT_SECONDS}

Flags:
  --resume <path>               Resume a previously-created artifact and resolve.
  --artifact <path>             Custom output path for the resume artifact.
  --help                        Show this message.
`);
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function parseOptionalProgramId(): PublicKey | undefined {
  const value = process.env.AGENC_PROGRAM_ID;
  if (!value) {
    return undefined;
  }
  return new PublicKey(value);
}

function readBigIntEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return BigInt(raw);
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.trunc(parsed);
}

function formatUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function lamportsToSol(value: bigint): string {
  return (Number(value) / 1_000_000_000).toFixed(4);
}

function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((current, value) => (value > current ? value : current));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function getStringField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${field} is missing or invalid`);
  }
  return value;
}

function getNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}.${field} is missing or invalid`);
  }
  return value;
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildBaseOptions(rpcUrl: string, programId?: string): BaseCliOptions {
  return {
    help: false,
    outputFormat: "json",
    strictMode: true,
    rpcUrl,
    programId,
    storeType: "memory",
    idempotencyWindow: 900,
  };
}

function createSignerContext(
  label: string,
  walletPath: string,
  connection: Connection,
  programId?: PublicKey,
): SignerContext {
  const keypair = loadKeypairFromFileSync(walletPath);
  const provider = new AnchorProvider(connection, keypairToWallet(keypair), {
    commitment: "confirmed",
  });

  return {
    label,
    walletPath,
    keypair,
    program: programId ? createProgram(provider, programId) : createProgram(provider),
  };
}

function ensureDistinctWallets(signers: SignerContext[]): void {
  const seen = new Map<string, string>();

  for (const signer of signers) {
    const pubkey = signer.keypair.publicKey.toBase58();
    const existing = seen.get(pubkey);
    if (existing) {
      throw new Error(
        `${signer.label} and ${existing} must use different wallets (${pubkey})`,
      );
    }
    seen.set(pubkey, signer.label);
  }
}

async function ensureBalance(
  connection: Connection,
  label: string,
  pubkey: PublicKey,
  minimumLamports: bigint,
): Promise<void> {
  const balance = BigInt(await connection.getBalance(pubkey, "confirmed"));
  if (balance < minimumLamports) {
    throw new Error(
      `${label} ${pubkey.toBase58()} has ${balance.toString()} lamports (${lamportsToSol(balance)} SOL), needs at least ${minimumLamports.toString()} lamports (${lamportsToSol(minimumLamports)} SOL)`,
    );
  }
}

async function loadProtocolConfig(
  program: Program<AgencCoordination>,
): Promise<ProtocolConfig> {
  const raw = await (program.account as any).protocolConfig.fetch(
    findProtocolPda(program.programId),
  );
  return parseProtocolConfig(raw);
}

async function registerOrLoadAgent(
  signer: SignerContext,
  connection: Connection,
  programId: PublicKey | undefined,
  requiredCapabilities: bigint,
  stakeAmount: bigint,
  minimumExpectedStake: bigint,
): Promise<AgentActor> {
  const registerTool = createAgencTools({
    connection,
    wallet: keypairToWallet(signer.keypair),
    programId,
    logger: silentLogger,
  }).find((tool) => tool.name === "agenc.registerAgent");

  if (!registerTool) {
    throw new Error("agenc.registerAgent tool is not available");
  }

  const endpoint = `${DEFAULT_ENDPOINT_BASE}/${signer.label}`;
  const result = await registerTool.execute({
    capabilities: requiredCapabilities.toString(),
    endpoint,
    stakeAmount: stakeAmount.toString(),
  });

  if (result.isError) {
    throw new Error(
      `${signer.label} registration failed: ${stringifyUnknown(result.content)}`,
    );
  }

  const payload = asRecord(
    JSON.parse(result.content) as unknown,
    `${signer.label}.registerAgent`,
  );
  const agentPda = new PublicKey(
    getStringField(payload, "agentPda", `${signer.label}.registerAgent`),
  );
  const rawAgent = await (signer.program.account as any).agentRegistration.fetch(
    agentPda,
  );
  const agent = parseAgentState(rawAgent);

  if (!agent.authority.equals(signer.keypair.publicKey)) {
    throw new Error(
      `${signer.label} agent authority mismatch for ${agentPda.toBase58()}`,
    );
  }
  if (!hasCapability(agent.capabilities, requiredCapabilities)) {
    throw new Error(
      `${signer.label} agent ${agentPda.toBase58()} does not have required capabilities ${requiredCapabilities.toString()}`,
    );
  }
  if (agent.stake < minimumExpectedStake) {
    throw new Error(
      `${signer.label} agent ${agentPda.toBase58()} has insufficient stake ${agent.stake.toString()} < ${minimumExpectedStake.toString()}`,
    );
  }

  return {
    ...signer,
    agentPda,
    agentId: agent.agentId,
  };
}

function installMarketplaceCliOverrides(runtime: SmokeRuntime): void {
  setMarketplaceCliProgramContextOverrides({
    async createReadOnlyProgramContext() {
      return {
        connection: runtime.connection,
        program: runtime.readOnlyProgram,
      };
    },
    async createSignerProgramContext() {
      if (!activeSignerKey) {
        throw new Error("Missing active signer key for marketplace command");
      }

      const signer = runtime.signersByKey.get(activeSignerKey);
      if (!signer) {
        throw new Error(`Unknown signer context: ${activeSignerKey}`);
      }

      return {
        connection: runtime.connection,
        program: signer.program,
      };
    },
  });
}

async function runMarketCommand(
  baseOptions: BaseCliOptions,
  runner: MarketRunner,
  options: Record<string, unknown>,
  signerKey?: string,
): Promise<Record<string, unknown>> {
  let output: unknown;
  let errorOutput: unknown;

  activeSignerKey = signerKey ?? null;
  try {
    const code = await runner(
      {
        logger: silentLogger,
        outputFormat: "json",
        output(value) {
          output = value;
        },
        error(value) {
          errorOutput = value;
        },
      },
      {
        ...baseOptions,
        ...options,
      },
    );

    if (code !== 0) {
      throw new Error(
        errorOutput
          ? stringifyUnknown(errorOutput)
          : `Marketplace command failed with exit code ${code}`,
      );
    }
    if (errorOutput) {
      throw new Error(stringifyUnknown(errorOutput));
    }
    if (output === undefined) {
      throw new Error("Marketplace command produced no output");
    }

    return asRecord(output, "marketplaceCommand");
  } finally {
    activeSignerKey = null;
  }
}

async function castVotes(
  disputePda: string,
  taskPda: string,
  workerClaimPda: string,
  arbiters: AgentActor[],
): Promise<Array<{ votePda: string; arbiterAgentPda: string }>> {
  const disputeKey = new PublicKey(disputePda);
  const taskKey = new PublicKey(taskPda);
  const claimKey = new PublicKey(workerClaimPda);
  const votes: Array<{ votePda: string; arbiterAgentPda: string }> = [];

  for (const arbiter of arbiters) {
    const ops = new DisputeOperations({
      program: arbiter.program,
      agentId: arbiter.agentId,
      logger: silentLogger,
    });
    const vote = await ops.voteOnDispute({
      disputePda: disputeKey,
      taskPda: taskKey,
      approve: true,
      workerClaimPda: claimKey,
    });

    votes.push({
      votePda: vote.votePda.toBase58(),
      arbiterAgentPda: arbiter.agentPda.toBase58(),
    });
    console.log(
      `[vote] ${arbiter.label} approved dispute ${disputePda} -> ${vote.votePda.toBase58()}`,
    );
  }

  return votes;
}

async function waitForDeadline(
  votingDeadline: number,
  maxWaitSeconds: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const waitSeconds = Math.max(0, votingDeadline - now + 1);

  if (waitSeconds > maxWaitSeconds) {
    return false;
  }

  if (waitSeconds > 0) {
    console.log(
      `[wait] sleeping ${waitSeconds}s until ${formatUnix(votingDeadline)}`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, waitSeconds * 1000);
    });
  }

  return true;
}

async function writeArtifact(
  artifact: SmokeArtifact,
  explicitPath?: string | null,
): Promise<string> {
  const filePath =
    explicitPath ??
    path.join(
      ARTIFACT_DIR,
      `marketplace-devnet-smoke-${Date.now()}.json`,
    );

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}

async function readArtifact(filePath: string): Promise<SmokeArtifact> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  const artifact = asRecord(parsed, "artifact");

  if (artifact.kind !== "marketplace-devnet-smoke") {
    throw new Error(`Unsupported artifact kind: ${String(artifact.kind)}`);
  }
  if (artifact.version !== 1) {
    throw new Error(`Unsupported artifact version: ${String(artifact.version)}`);
  }
  if (!Array.isArray(artifact.arbiterVotes) || artifact.arbiterVotes.length === 0) {
    throw new Error("Artifact is missing arbiterVotes");
  }

  return artifact as unknown as SmokeArtifact;
}

async function initial(): Promise<void> {
  const rpcUrl = process.env.AGENC_RPC_URL ?? DEFAULT_RPC_URL;
  const programId = parseOptionalProgramId();
  const rewardLamports = readBigIntEnv(
    "AGENC_REWARD_LAMPORTS",
    DEFAULT_REWARD_LAMPORTS,
  );
  const maxWaitSeconds = readNumberEnv(
    "AGENC_MAX_WAIT_SECONDS",
    DEFAULT_MAX_WAIT_SECONDS,
  );
  const artifactPath = getFlagValue("--artifact");
  const connection = new Connection(rpcUrl, "confirmed");

  const creatorSigner = createSignerContext(
    "creator",
    env("CREATOR_WALLET"),
    connection,
    programId,
  );
  const workerSigner = createSignerContext(
    "worker",
    env("WORKER_WALLET"),
    connection,
    programId,
  );
  const arbiterASigner = createSignerContext(
    "arbiter-a",
    env("ARBITER_A_WALLET"),
    connection,
    programId,
  );
  const arbiterBSigner = createSignerContext(
    "arbiter-b",
    env("ARBITER_B_WALLET"),
    connection,
    programId,
  );
  const arbiterCSigner = createSignerContext(
    "arbiter-c",
    env("ARBITER_C_WALLET"),
    connection,
    programId,
  );
  const authoritySigner = createSignerContext(
    "authority",
    env("PROTOCOL_AUTHORITY_WALLET"),
    connection,
    programId,
  );
  const readOnlyProgram = programId
    ? createReadOnlyProgram(connection, programId)
    : createReadOnlyProgram(connection);

  ensureDistinctWallets([
    creatorSigner,
    workerSigner,
    arbiterASigner,
    arbiterBSigner,
    arbiterCSigner,
    authoritySigner,
  ]);

  const protocolConfig = await loadProtocolConfig(readOnlyProgram);
  if (!authoritySigner.keypair.publicKey.equals(protocolConfig.authority)) {
    throw new Error(
      `PROTOCOL_AUTHORITY_WALLET ${authoritySigner.keypair.publicKey.toBase58()} does not match protocol authority ${protocolConfig.authority.toBase58()}`,
    );
  }

  const creatorStake = maxBigInt(
    protocolConfig.minAgentStake,
    protocolConfig.minStakeForDispute * 2n,
  );
  const workerStake = protocolConfig.minAgentStake;
  const arbiterStake = maxBigInt(
    protocolConfig.minAgentStake,
    protocolConfig.minArbiterStake,
  );

  await Promise.all([
    ensureBalance(
      connection,
      "creator",
      creatorSigner.keypair.publicKey,
      creatorStake + rewardLamports + DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "worker",
      workerSigner.keypair.publicKey,
      workerStake + DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "arbiter-a",
      arbiterASigner.keypair.publicKey,
      arbiterStake + DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "arbiter-b",
      arbiterBSigner.keypair.publicKey,
      arbiterStake + DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "arbiter-c",
      arbiterCSigner.keypair.publicKey,
      arbiterStake + DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "authority",
      authoritySigner.keypair.publicKey,
      DEFAULT_AUTHORITY_FEE_BUFFER_LAMPORTS,
    ),
  ]);

  console.log(`[config] rpc: ${rpcUrl}`);
  console.log(`[config] program: ${readOnlyProgram.programId.toBase58()}`);
  console.log(`[config] reward lamports: ${rewardLamports.toString()}`);
  console.log(`[config] max wait seconds: ${maxWaitSeconds}`);
  console.log(`[config] creator wallet: ${creatorSigner.keypair.publicKey.toBase58()}`);
  console.log(`[config] worker wallet: ${workerSigner.keypair.publicKey.toBase58()}`);
  console.log(
    `[config] authority wallet: ${authoritySigner.keypair.publicKey.toBase58()}`,
  );

  const creator = await registerOrLoadAgent(
    creatorSigner,
    connection,
    programId,
    AgentCapabilities.COMPUTE,
    creatorStake,
    maxBigInt(protocolConfig.minAgentStake, protocolConfig.minStakeForDispute),
  );
  const worker = await registerOrLoadAgent(
    workerSigner,
    connection,
    programId,
    AgentCapabilities.COMPUTE,
    workerStake,
    workerStake,
  );
  const arbiterA = await registerOrLoadAgent(
    arbiterASigner,
    connection,
    programId,
    AgentCapabilities.ARBITER,
    arbiterStake,
    arbiterStake,
  );
  const arbiterB = await registerOrLoadAgent(
    arbiterBSigner,
    connection,
    programId,
    AgentCapabilities.ARBITER,
    arbiterStake,
    arbiterStake,
  );
  const arbiterC = await registerOrLoadAgent(
    arbiterCSigner,
    connection,
    programId,
    AgentCapabilities.ARBITER,
    arbiterStake,
    arbiterStake,
  );

  console.log(`[agent] creator: ${creator.agentPda.toBase58()}`);
  console.log(`[agent] worker: ${worker.agentPda.toBase58()}`);
  console.log(`[agent] arbiter-a: ${arbiterA.agentPda.toBase58()}`);
  console.log(`[agent] arbiter-b: ${arbiterB.agentPda.toBase58()}`);
  console.log(`[agent] arbiter-c: ${arbiterC.agentPda.toBase58()}`);

  const runtime: SmokeRuntime = {
    connection,
    readOnlyProgram,
    signersByKey: new Map<string, SignerContext>([
      [creator.agentPda.toBase58(), creator],
      [worker.agentPda.toBase58(), worker],
      [arbiterA.agentPda.toBase58(), arbiterA],
      [arbiterB.agentPda.toBase58(), arbiterB],
      [arbiterC.agentPda.toBase58(), arbiterC],
      ["authority", authoritySigner],
    ]),
  };
  installMarketplaceCliOverrides(runtime);

  const baseOptions = buildBaseOptions(
    rpcUrl,
    readOnlyProgram.programId.toBase58(),
  );
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const description = `devnet smoke ${runId}`;

  try {
    const createOutput = await runMarketCommand(
      baseOptions,
      runMarketTaskCreateCommand as MarketRunner,
      {
        description,
        reward: rewardLamports.toString(),
        requiredCapabilities: AgentCapabilities.COMPUTE.toString(),
        creatorAgentPda: creator.agentPda.toBase58(),
      },
      creator.agentPda.toBase58(),
    );
    const createResult = asRecord(createOutput.result, "createTask.result");
    const taskPda = getStringField(createResult, "taskPda", "createTask.result");
    console.log(`[task] created ${taskPda}`);

    const claimOutput = await runMarketCommand(
      baseOptions,
      runMarketTaskClaimCommand as MarketRunner,
      {
        taskPda,
        workerAgentPda: worker.agentPda.toBase58(),
      },
      worker.agentPda.toBase58(),
    );
    const claimResult = asRecord(claimOutput.result, "claimTask.result");
    const workerClaimPda = getStringField(
      claimResult,
      "claimPda",
      "claimTask.result",
    );
    console.log(`[task] claimed ${workerClaimPda}`);

    const disputeOutput = await runMarketCommand(
      baseOptions,
      runMarketTaskDisputeCommand as MarketRunner,
      {
        taskPda,
        evidence: `creator dispute ${runId}`,
        resolutionType: "refund",
        initiatorAgentPda: creator.agentPda.toBase58(),
        workerAgentPda: worker.agentPda.toBase58(),
        workerClaimPda,
      },
      creator.agentPda.toBase58(),
    );
    const disputeResult = asRecord(
      disputeOutput.result,
      "initiateDispute.result",
    );
    const disputePda = getStringField(
      disputeResult,
      "disputePda",
      "initiateDispute.result",
    );
    console.log(`[dispute] opened ${disputePda}`);

    const arbiterVotes = await castVotes(disputePda, taskPda, workerClaimPda, [
      arbiterA,
      arbiterB,
      arbiterC,
    ]);

    const detailBeforeResolve = await runMarketCommand(
      baseOptions,
      runMarketDisputeDetailCommand as MarketRunner,
      {
        disputePda,
      },
    );
    const disputeDetail = asRecord(
      detailBeforeResolve.dispute,
      "disputeDetail.dispute",
    );
    const votingDeadline = getNumberField(
      disputeDetail,
      "votingDeadline",
      "disputeDetail.dispute",
    );
    console.log(`[dispute] voting deadline: ${formatUnix(votingDeadline)}`);

    const waited = await waitForDeadline(votingDeadline, maxWaitSeconds);
    if (!waited) {
      const artifact: SmokeArtifact = {
        version: 1,
        kind: "marketplace-devnet-smoke",
        createdAt: new Date().toISOString(),
        rpcUrl,
        programId: readOnlyProgram.programId.toBase58(),
        runId,
        description,
        rewardLamports: rewardLamports.toString(),
        authorityPubkey: authoritySigner.keypair.publicKey.toBase58(),
        creatorAgentPda: creator.agentPda.toBase58(),
        workerAgentPda: worker.agentPda.toBase58(),
        workerClaimPda,
        taskPda,
        disputePda,
        votingDeadline,
        arbiterVotes,
      };
      const savedPath = await writeArtifact(artifact, artifactPath);
      console.log(
        `[pending] deadline ${formatUnix(votingDeadline)} exceeds max wait of ${maxWaitSeconds}s`,
      );
      console.log(`[artifact] ${savedPath}`);
      console.log(
        `[resume] PROTOCOL_AUTHORITY_WALLET=${authoritySigner.walletPath} npm run smoke:marketplace:devnet -- --resume ${savedPath}`,
      );
      return;
    }

    await runMarketCommand(
      baseOptions,
      runMarketDisputeResolveCommand as MarketRunner,
      {
        disputePda,
        arbiterVotes,
      },
      "authority",
    );
    console.log(`[dispute] resolved ${disputePda}`);

    const disputeAfterResolve = await runMarketCommand(
      baseOptions,
      runMarketDisputeDetailCommand as MarketRunner,
      {
        disputePda,
      },
    );
    const taskAfterResolve = await runMarketCommand(
      baseOptions,
      runMarketTaskDetailCommand as MarketRunner,
      {
        taskPda,
      },
    );
    const disputeAfter = asRecord(
      disputeAfterResolve.dispute,
      "disputeAfterResolve.dispute",
    );
    const taskAfter = asRecord(taskAfterResolve.task, "taskAfterResolve.task");
    const disputeStatus = getStringField(
      disputeAfter,
      "status",
      "disputeAfterResolve.dispute",
    );
    const taskStatus = getStringField(
      taskAfter,
      "status",
      "taskAfterResolve.task",
    );

    if (disputeStatus === "active") {
      throw new Error(`Dispute ${disputePda} is still active after resolve`);
    }

    console.log(
      `[ok] lifecycle complete for ${taskPda}: dispute status=${disputeStatus}, task status=${taskStatus}`,
    );
  } finally {
    resetMarketplaceCliProgramContextOverrides();
  }
}

async function resume(): Promise<void> {
  const resumePath = getFlagValue("--resume");
  if (!resumePath) {
    throw new Error("Missing artifact path. Use --resume /path/to/file.json");
  }

  const artifact = await readArtifact(resumePath);
  const rpcUrl = process.env.AGENC_RPC_URL ?? artifact.rpcUrl ?? DEFAULT_RPC_URL;
  const programId = new PublicKey(
    process.env.AGENC_PROGRAM_ID ?? artifact.programId,
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const authoritySigner = createSignerContext(
    "authority",
    env("PROTOCOL_AUTHORITY_WALLET"),
    connection,
    programId,
  );
  const readOnlyProgram = createReadOnlyProgram(connection, programId);

  const protocolConfig = await loadProtocolConfig(readOnlyProgram);
  if (!authoritySigner.keypair.publicKey.equals(protocolConfig.authority)) {
    throw new Error(
      `PROTOCOL_AUTHORITY_WALLET ${authoritySigner.keypair.publicKey.toBase58()} does not match protocol authority ${protocolConfig.authority.toBase58()}`,
    );
  }

  await ensureBalance(
    connection,
    "authority",
    authoritySigner.keypair.publicKey,
    DEFAULT_AUTHORITY_FEE_BUFFER_LAMPORTS,
  );

  console.log(`[resume] artifact: ${resumePath}`);
  console.log(`[resume] rpc: ${rpcUrl}`);
  console.log(`[resume] program: ${programId.toBase58()}`);
  console.log(
    `[resume] authority wallet: ${authoritySigner.keypair.publicKey.toBase58()}`,
  );

  const runtime: SmokeRuntime = {
    connection,
    readOnlyProgram,
    signersByKey: new Map<string, SignerContext>([["authority", authoritySigner]]),
  };
  installMarketplaceCliOverrides(runtime);

  const baseOptions = buildBaseOptions(rpcUrl, programId.toBase58());

  try {
    const detailBeforeResolve = await runMarketCommand(
      baseOptions,
      runMarketDisputeDetailCommand as MarketRunner,
      {
        disputePda: artifact.disputePda,
      },
    );
    const disputeBefore = asRecord(
      detailBeforeResolve.dispute,
      "resume.disputeBefore",
    );
    const disputeStatus = getStringField(
      disputeBefore,
      "status",
      "resume.disputeBefore",
    );
    const votingDeadline = getNumberField(
      disputeBefore,
      "votingDeadline",
      "resume.disputeBefore",
    );

    if (disputeStatus !== "active") {
      console.log(
        `[resume] dispute ${artifact.disputePda} already moved to status=${disputeStatus}`,
      );
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (votingDeadline > now) {
      console.log(
        `[resume] dispute ${artifact.disputePda} is still locked until ${formatUnix(votingDeadline)}`,
      );
      return;
    }

    await runMarketCommand(
      baseOptions,
      runMarketDisputeResolveCommand as MarketRunner,
      {
        disputePda: artifact.disputePda,
        arbiterVotes: artifact.arbiterVotes,
      },
      "authority",
    );
    console.log(`[resume] resolved dispute ${artifact.disputePda}`);

    const disputeAfterResolve = await runMarketCommand(
      baseOptions,
      runMarketDisputeDetailCommand as MarketRunner,
      {
        disputePda: artifact.disputePda,
      },
    );
    const taskAfterResolve = await runMarketCommand(
      baseOptions,
      runMarketTaskDetailCommand as MarketRunner,
      {
        taskPda: artifact.taskPda,
      },
    );
    const disputeAfter = asRecord(
      disputeAfterResolve.dispute,
      "resume.disputeAfter",
    );
    const taskAfter = asRecord(taskAfterResolve.task, "resume.taskAfter");
    const disputeAfterStatus = getStringField(
      disputeAfter,
      "status",
      "resume.disputeAfter",
    );
    const taskStatus = getStringField(
      taskAfter,
      "status",
      "resume.taskAfter",
    );

    if (disputeAfterStatus === "active") {
      throw new Error(
        `Dispute ${artifact.disputePda} is still active after resume resolve`,
      );
    }

    console.log(
      `[ok] resumed lifecycle complete for ${artifact.taskPda}: dispute status=${disputeAfterStatus}, task status=${taskStatus}`,
    );
  } finally {
    resetMarketplaceCliProgramContextOverrides();
  }
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    usage();
    return;
  }

  if (hasFlag("--resume")) {
    await resume();
    return;
  }

  await initial();
}

main().catch((error) => {
  console.error(
    `[error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
