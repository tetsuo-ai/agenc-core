#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { AnchorProvider } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import {
  AgentCapabilities,
  createProgram,
  createReadOnlyProgram,
  findProtocolPda,
  GovernanceOperations,
  hasCapability,
  keypairToWallet,
  ReputationEconomyOperations,
  AGENT_REGISTRATION_SIZE,
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
  runMarketGovernanceDetailCommand,
  runMarketReputationSummaryCommand,
  runMarketSkillDetailCommand,
  runMarketTaskDetailCommand,
  setMarketplaceCliProgramContextOverrides,
} from "../runtime/src/cli/marketplace-cli.js";
import { runMarketTuiCommand } from "../runtime/src/cli/marketplace-tui.js";
import type { BaseCliOptions, CliRuntimeContext } from "../runtime/src/cli/types.js";
import { DisputeOperations } from "../runtime/src/dispute/operations.js";
import { MIN_DELEGATION_AMOUNT } from "../runtime/src/reputation/types.js";
import { createAgencTools } from "../runtime/src/tools/agenc/index.js";

const DEFAULT_RPC_URL =
  process.env.AGENC_RPC_URL ?? "https://api.devnet.solana.com";
const DEFAULT_TASK_REWARD_LAMPORTS = 10_000_000n;
const DEFAULT_SKILL_PRICE_LAMPORTS = 500_000n;
const DEFAULT_REPUTATION_STAKE_LAMPORTS = 1_000_000n;
const DEFAULT_DELEGATION_AMOUNT = 137;
const DEFAULT_PROPOSAL_VOTING_PERIOD = 600;
const DEFAULT_GOVERNANCE_EXECUTION_DELAY = 60;
const DEFAULT_GOVERNANCE_QUORUM_BPS = 1000;
const DEFAULT_GOVERNANCE_APPROVAL_THRESHOLD_BPS = 5001;
const DEFAULT_MAX_WAIT_SECONDS = 300;
const DEFAULT_STATE_WAIT_SECONDS = 45;
const DEFAULT_RPC_COOLDOWN_MS = 1_000;
const DEFAULT_RPC_RETRY_ATTEMPTS = 5;
const DEFAULT_RPC_RETRY_DELAY_MS = 1_500;
const DEFAULT_ENDPOINT_BASE = "https://agenc.local";
const DEFAULT_FEE_BUFFER_LAMPORTS = 10_000_000n;
const DEFAULT_AUTHORITY_FEE_BUFFER_LAMPORTS = 1_000_000n;
const ARTIFACT_DIR = path.join(os.tmpdir(), "agenc-marketplace-tui-smoke");
const AGENT_DISCRIMINATOR = Buffer.from([130, 53, 100, 103, 121, 77, 148, 19]);
const AGENT_AUTHORITY_OFFSET = 40;
const DEBUG_SIGNER_RESOLUTION =
  process.env.AGENC_TUI_SIGNER_DEBUG === "1";

type MarketRunner = (
  context: CliRuntimeContext,
  options: Record<string, unknown>,
) => Promise<0 | 1 | 2>;

interface SignerContext {
  label: string;
  walletPath: string;
  keypair: Keypair;
  program: ReturnType<typeof createProgram>;
}

interface AgentActor extends SignerContext {
  agentPda: PublicKey;
  agentId: Uint8Array;
}

interface SmokeRuntime {
  connection: Connection;
  readOnlyProgram: ReturnType<typeof createReadOnlyProgram>;
  signersByKey: Map<string, SignerContext>;
}

interface TuiSmokeArtifact {
  version: 1;
  kind: "marketplace-tui-devnet-smoke";
  createdAt: string;
  rpcUrl: string;
  programId: string;
  runId: string;
  authorityPubkey: string;
  taskPda: string;
  disputePda: string;
  workerClaimPda: string;
  votingDeadline: number;
  arbiterVotes: Array<{ votePda: string; arbiterAgentPda: string }>;
}

let activeSignerKey: string | null = null;

function usage(): void {
  process.stdout.write(`Usage:
  CREATOR_WALLET=/path/to/creator.json \\
  WORKER_WALLET=/path/to/worker.json \\
  ARBITER_A_WALLET=/path/to/arbiter-a.json \\
  ARBITER_B_WALLET=/path/to/arbiter-b.json \\
  ARBITER_C_WALLET=/path/to/arbiter-c.json \\
  PROTOCOL_AUTHORITY_WALLET=/path/to/authority.json \\
  npm run smoke:marketplace:tui:devnet

  PROTOCOL_AUTHORITY_WALLET=/path/to/authority.json \\
  npm run smoke:marketplace:tui:devnet -- --resume /tmp/agenc-marketplace-tui-smoke/marketplace-tui-devnet-smoke-....json

Environment:
  CREATOR_WALLET                Required for the initial run.
  WORKER_WALLET                 Required for the initial run.
  ARBITER_A_WALLET              Required for the initial run.
  ARBITER_B_WALLET              Required for the initial run.
  ARBITER_C_WALLET              Required for the initial run.
  PROTOCOL_AUTHORITY_WALLET     Required in both modes.
  AGENC_RPC_URL                 Optional. Defaults to ${DEFAULT_RPC_URL}
  AGENC_PROGRAM_ID              Optional. Defaults to the runtime program ID.
  AGENC_TASK_REWARD_LAMPORTS    Optional. Defaults to ${DEFAULT_TASK_REWARD_LAMPORTS.toString()}
  AGENC_SKILL_PRICE_LAMPORTS    Optional. Defaults to ${DEFAULT_SKILL_PRICE_LAMPORTS.toString()}
  AGENC_REPUTATION_STAKE_LAMPORTS Optional. Defaults to ${DEFAULT_REPUTATION_STAKE_LAMPORTS.toString()}
  AGENC_DELEGATION_AMOUNT       Optional. Defaults to ${DEFAULT_DELEGATION_AMOUNT}
  AGENC_PROPOSAL_VOTING_PERIOD  Optional. Defaults to ${DEFAULT_PROPOSAL_VOTING_PERIOD}
  AGENC_MAX_WAIT_SECONDS        Optional. Defaults to ${DEFAULT_MAX_WAIT_SECONDS}

Flags:
  --resume <path>               Resume a saved dispute-resolution artifact.
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

function isRpcRateLimitError(error: unknown): boolean {
  const message = stringifyUnknown(error);
  return (
    message.includes("429 Too Many Requests") ||
    message.includes('"code":429') ||
    message.includes('"code": 429') ||
    message.includes("Too many requests for a specific RPC call")
  );
}

async function withRpcRateLimitRetry<T>(
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  const retryAttempts = readNumberEnv(
    "AGENC_RPC_RETRY_ATTEMPTS",
    DEFAULT_RPC_RETRY_ATTEMPTS,
  );
  let delayMs = readNumberEnv(
    "AGENC_RPC_RETRY_DELAY_MS",
    DEFAULT_RPC_RETRY_DELAY_MS,
  );

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isRpcRateLimitError(error) || attempt >= retryAttempts) {
        throw error;
      }
      console.log(
        `[retry] ${label} hit RPC 429, sleeping ${delayMs}ms before retry ${attempt + 1}/${retryAttempts}`,
      );
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
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

function getBooleanField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`${label}.${field} is missing or invalid`);
  }
  return value;
}

function getArrayField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new Error(`${label}.${field} is missing or invalid`);
  }
  return value;
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

async function getRentExemptLamports(
  connection: Connection,
  size: number,
): Promise<bigint> {
  return BigInt(await connection.getMinimumBalanceForRentExemption(size));
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

async function countAgentRegistrations(
  connection: Connection,
  programId: PublicKey,
  authority: PublicKey,
): Promise<number> {
  const matches = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(AGENT_DISCRIMINATOR) } },
      { memcmp: { offset: AGENT_AUTHORITY_OFFSET, bytes: authority.toBase58() } },
    ],
  });
  return matches.length;
}

async function loadProtocolConfig(
  program: ReturnType<typeof createReadOnlyProgram> | ReturnType<typeof createProgram>,
): Promise<ProtocolConfig> {
  const raw = await withRpcRateLimitRetry(
    "protocol config fetch",
    async () =>
      (program.account as any).protocolConfig.fetch(
        findProtocolPda(program.programId),
      ),
  );
  return parseProtocolConfig(raw);
}

async function validateProtocolConfigHealth(
  connection: Connection,
  program: ReturnType<typeof createReadOnlyProgram> | ReturnType<typeof createProgram>,
  protocolConfig: ProtocolConfig,
): Promise<void> {
  if (!protocolConfig.multisigOwners.some((owner) => owner.equals(protocolConfig.authority))) {
    throw new Error(
      `Protocol authority ${protocolConfig.authority.toBase58()} is not present in multisig owners for program ${program.programId.toBase58()}`,
    );
  }
  if (protocolConfig.multisigThreshold > protocolConfig.multisigOwners.length) {
    throw new Error(
      `Protocol multisig threshold ${protocolConfig.multisigThreshold} exceeds owner count ${protocolConfig.multisigOwners.length} for program ${program.programId.toBase58()}`,
    );
  }

  const treasuryInfo = await withRpcRateLimitRetry(
    "protocol treasury fetch",
    async () => connection.getAccountInfo(protocolConfig.treasury, "confirmed"),
  );
  if (!treasuryInfo) {
    throw new Error(
      `Protocol treasury ${protocolConfig.treasury.toBase58()} is missing on-chain for program ${program.programId.toBase58()}; reward settlement will fail until protocol config is repaired.`,
    );
  }
}

async function ensureGovernanceInitialized(
  authoritySigner: SignerContext,
  protocolConfig: ProtocolConfig,
  votingPeriod: number,
): Promise<void> {
  if (!authoritySigner.keypair.publicKey.equals(protocolConfig.authority)) {
    throw new Error(
      `Authority wallet ${authoritySigner.keypair.publicKey.toBase58()} does not match protocol authority ${protocolConfig.authority.toBase58()}`,
    );
  }

  const governanceOps = new GovernanceOperations({
    program: authoritySigner.program,
    agentId: new Uint8Array(32),
    logger: silentLogger,
  });

  const governanceConfig = await withRpcRateLimitRetry(
    "governance config fetch",
    async () => governanceOps.fetchGovernanceConfig(),
  );
  if (governanceConfig) {
    if (!governanceConfig.authority.equals(protocolConfig.authority)) {
      throw new Error(
        `Governance authority ${governanceConfig.authority.toBase58()} does not match protocol authority ${protocolConfig.authority.toBase58()}`,
      );
    }
    console.log(
      `[config] governance already initialized: authority=${governanceConfig.authority.toBase58()} minProposalStake=${governanceConfig.minProposalStake.toString()} votingPeriod=${governanceConfig.votingPeriod}`,
    );
    return;
  }

  const minProposalStake =
    protocolConfig.minAgentStake > 0n ? protocolConfig.minAgentStake : 1n;
  const initialized = await withRpcRateLimitRetry(
    "governance initialize",
    async () =>
      governanceOps.initializeGovernance({
        votingPeriod,
        executionDelay: DEFAULT_GOVERNANCE_EXECUTION_DELAY,
        quorumBps: DEFAULT_GOVERNANCE_QUORUM_BPS,
        approvalThresholdBps: DEFAULT_GOVERNANCE_APPROVAL_THRESHOLD_BPS,
        minProposalStake,
      }),
  );
  console.log(
    `[config] governance initialized: ${initialized.governanceConfigPda.toBase58()} (${initialized.transactionSignature})`,
  );
}

async function findExistingAgentPda(
  signer: SignerContext,
  connection: Connection,
): Promise<PublicKey | null> {
  return withRpcRateLimitRetry(
    `${signer.label} existing-agent lookup`,
    async () => {
      const matches = await connection.getProgramAccounts(signer.program.programId, {
        filters: [
          { memcmp: { offset: 0, bytes: bs58.encode(AGENT_DISCRIMINATOR) } },
          {
            memcmp: {
              offset: AGENT_AUTHORITY_OFFSET,
              bytes: signer.keypair.publicKey.toBase58(),
            },
          },
        ],
      });

      if (matches.length === 0) {
        return null;
      }
      if (matches.length === 1) {
        return matches[0]!.pubkey;
      }

      const fetchedAccounts = await (signer.program.account as any).agentRegistration.fetchMultiple(
        matches.map((entry) => entry.pubkey),
      );
      const activeMatches = matches.filter((_, index) => {
        const raw = fetchedAccounts[index];
        if (!raw) return false;
        try {
          return parseAgentState(raw).status === AgentStatus.Active;
        } catch {
          return false;
        }
      });
      return (activeMatches[0] ?? matches[0])!.pubkey;
    },
  );
}

async function registerOrLoadAgent(
  signer: SignerContext,
  connection: Connection,
  programId: PublicKey | undefined,
  requiredCapabilities: bigint,
  stakeAmount: bigint,
  minimumExpectedStake: bigint,
): Promise<AgentActor> {
  const existingAgentPda = await findExistingAgentPda(signer, connection);
  if (existingAgentPda) {
    const rawAgent = await withRpcRateLimitRetry(
      `${signer.label} existing-agent fetch`,
      async () =>
        (signer.program.account as any).agentRegistration.fetch(existingAgentPda),
    );
    const agent = parseAgentState(rawAgent);

    if (!agent.authority.equals(signer.keypair.publicKey)) {
      throw new Error(
        `${signer.label} agent authority mismatch for ${existingAgentPda.toBase58()}`,
      );
    }
    if (!hasCapability(agent.capabilities, requiredCapabilities)) {
      throw new Error(
        `${signer.label} agent ${existingAgentPda.toBase58()} does not have required capabilities ${requiredCapabilities.toString()}`,
      );
    }
    if (agent.stake < minimumExpectedStake) {
      throw new Error(
        `${signer.label} agent ${existingAgentPda.toBase58()} has insufficient stake ${agent.stake.toString()} < ${minimumExpectedStake.toString()}`,
      );
    }

    return {
      ...signer,
      agentPda: existingAgentPda,
      agentId: agent.agentId,
    };
  }

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
    async createSignerProgramContext(options) {
      if (options.keypairPath) {
        for (const signer of runtime.signersByKey.values()) {
          if (signer.walletPath === options.keypairPath) {
            if (DEBUG_SIGNER_RESOLUTION) {
              console.log(
                `[debug] signer context via keypairPath ${options.keypairPath} -> ${signer.label} ${signer.keypair.publicKey.toBase58()}`,
              );
            }
            return {
              connection: runtime.connection,
              program: signer.program,
            };
          }
        }
        throw new Error(`Unknown signer keypair path: ${options.keypairPath}`);
      }

      if (!activeSignerKey) {
        throw new Error("Missing active signer key for marketplace command");
      }

      const signer = runtime.signersByKey.get(activeSignerKey);
      if (!signer) {
        throw new Error(`Unknown signer context: ${activeSignerKey}`);
      }
      if (DEBUG_SIGNER_RESOLUTION) {
        console.log(
          `[debug] signer context via activeSignerKey ${activeSignerKey} -> ${signer.label} ${signer.keypair.publicKey.toBase58()}`,
        );
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
  return withRpcRateLimitRetry("marketplace command", async () => {
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
  });
}

async function executeToolJson(
  signer: SignerContext,
  connection: Connection,
  programId: PublicKey | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withRpcRateLimitRetry(toolName, async () => {
    const tool = createAgencTools({
      connection,
      wallet: keypairToWallet(signer.keypair),
      programId,
      logger: silentLogger,
    }).find((entry) => entry.name === toolName);

    if (!tool) {
      throw new Error(`${toolName} is not available`);
    }

    const result = await tool.execute(args);
    if (result.isError) {
      throw new Error(`${toolName} failed: ${stringifyUnknown(result.content)}`);
    }

    return asRecord(JSON.parse(result.content) as unknown, `${toolName}.result`);
  });
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
    console.log(`[wait] sleeping ${waitSeconds}s until ${formatUnix(votingDeadline)}`);
    await new Promise((resolve) => {
      setTimeout(resolve, waitSeconds * 1000);
    });
  }

  return true;
}

async function writeArtifact(
  artifact: TuiSmokeArtifact,
  explicitPath?: string | null,
): Promise<string> {
  const filePath =
    explicitPath ??
    path.join(
      ARTIFACT_DIR,
      `marketplace-tui-devnet-smoke-${Date.now()}.json`,
    );

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}

async function readArtifact(filePath: string): Promise<TuiSmokeArtifact> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  const artifact = asRecord(parsed, "artifact");

  if (artifact.kind !== "marketplace-tui-devnet-smoke") {
    throw new Error(`Unsupported artifact kind: ${String(artifact.kind)}`);
  }
  if (artifact.version !== 1) {
    throw new Error(`Unsupported artifact version: ${String(artifact.version)}`);
  }
  if (!Array.isArray(artifact.arbiterVotes) || artifact.arbiterVotes.length === 0) {
    throw new Error("Artifact is missing arbiterVotes");
  }

  return artifact as unknown as TuiSmokeArtifact;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor<T>(
  label: string,
  timeoutSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError: unknown = null;

  while (Date.now() <= deadline) {
    try {
      return await loader();
    } catch (error) {
      lastError = error;
      await sleep(1500);
    }
  }

  throw new Error(
    `${label} timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function createTtyInput(): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  return stream;
}

function createTtyOutput(): {
  stream: PassThrough & { isTTY: boolean; columns: number };
  getText: () => string;
} {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
  };
  stream.isTTY = true;
  stream.columns = 100;
  stream.on("data", (chunk) => {
    chunks.push(String(chunk));
  });
  return {
    stream,
    getText: () => chunks.join(""),
  };
}

async function runTuiSession(
  baseOptions: BaseCliOptions,
  signer: SignerContext | AgentActor,
  lines: string[],
): Promise<string> {
  await sleep(
    readNumberEnv("AGENC_RPC_COOLDOWN_MS", DEFAULT_RPC_COOLDOWN_MS),
  );

  const input = createTtyInput();
  const stdout = createTtyOutput();
  let errorOutput: unknown;
  let lineIndex = 0;
  let feedScheduled = false;
  const maybeFeedNextLine = () => {
    if (feedScheduled || lineIndex >= lines.length) {
      return;
    }

    const text = stdout.getText();
    const tail = text.slice(-256);
    const promptMatch = tail.match(/(?:^|\n)([^\n]*(?:> |: ))$/);
    const prompt = promptMatch?.[1] ?? "";
    if (!prompt) {
      return;
    }

    feedScheduled = true;
    setTimeout(() => {
      feedScheduled = false;
      input.write(`${lines[lineIndex++] ?? ""}\n`);
    }, 10);
  };

  stdout.stream.on("data", () => {
    maybeFeedNextLine();
  });

  activeSignerKey =
    "agentPda" in signer
      ? signer.agentPda.toBase58()
      : signer.walletPath;
  try {
    const code = await runMarketTuiCommand(
      {
        logger: silentLogger,
        outputFormat: "table",
        output() {
          // TUI writes directly to stdout.
        },
        error(value) {
          errorOutput = value;
        },
      },
      {
        ...baseOptions,
        outputFormat: "table",
        keypairPath: signer.walletPath,
      },
      {
        stdin: input,
        stdout: stdout.stream,
      },
    );

    const text = stdout.getText();
    if (code !== 0) {
      throw new Error(
        errorOutput
          ? stringifyUnknown(errorOutput)
          : `TUI exited with code ${code}`,
      );
    }
    if (errorOutput) {
      throw new Error(stringifyUnknown(errorOutput));
    }
    return text;
  } catch (error) {
    const partialOutput = stdout.getText();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}
[partial tui output]
${partialOutput}`,
    );
  } finally {
    activeSignerKey = null;
    input.destroy();
    stdout.stream.destroy();
  }
}

function assertTuiSuccess(text: string, title: string): void {
  if (text.includes(`${title} failed`)) {
    throw new Error(`TUI ${title} failed:\n${text}`);
  }
  if (!text.includes(title)) {
    throw new Error(`TUI output did not include ${title}:\n${text}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPayloadRecord(
  text: string,
  title: string,
): Record<string, unknown> {
  const pattern = new RegExp(
    `${escapeRegExp(title)}\\n-+\\n([\\s\\S]*?)\\n\\[enter\\] continue`,
    "g",
  );
  const matches = [...text.matchAll(pattern)];
  const match = matches[matches.length - 1];
  if (!match) {
    throw new Error(`Could not find ${title} payload in TUI output:\n${text}`);
  }
  try {
    return asRecord(JSON.parse(match[1]!.trim()) as unknown, `${title}.payload`);
  } catch (error) {
    throw new Error(
      `Failed to parse ${title} payload: ${error instanceof Error ? error.message : String(error)}\n${match[1]}`,
    );
  }
}

function extractPayloadString(text: string, title: string, key: string): string {
  const payload = extractPayloadRecord(text, title);
  const direct = payload[key];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const nestedResult = payload.result;
  if (
    nestedResult &&
    typeof nestedResult === "object" &&
    !Array.isArray(nestedResult)
  ) {
    return getStringField(
      nestedResult as Record<string, unknown>,
      key,
      `${title}.payload.result`,
    );
  }
  return getStringField(payload, key, `${title}.payload`);
}

function formatVotePairs(
  votes: Array<{ votePda: string; arbiterAgentPda: string }>,
): string {
  return votes
    .map((entry) => `${entry.votePda}:${entry.arbiterAgentPda}`)
    .join(",");
}

async function fetchTaskDetail(
  baseOptions: BaseCliOptions,
  taskPda: string,
): Promise<Record<string, unknown>> {
  const output = await runMarketCommand(
    baseOptions,
    runMarketTaskDetailCommand as MarketRunner,
    { taskPda },
  );
  return asRecord(output.task, "taskDetail.task");
}

async function fetchSkillDetail(
  baseOptions: BaseCliOptions,
  skillPda: string,
  signerKey?: string,
): Promise<Record<string, unknown>> {
  const output = await runMarketCommand(
    baseOptions,
    runMarketSkillDetailCommand as MarketRunner,
    { skillPda },
    signerKey,
  );
  return asRecord(output.skill, "skillDetail.skill");
}

async function fetchProposalDetail(
  baseOptions: BaseCliOptions,
  proposalPda: string,
): Promise<Record<string, unknown>> {
  const output = await runMarketCommand(
    baseOptions,
    runMarketGovernanceDetailCommand as MarketRunner,
    { proposalPda },
  );
  return asRecord(output.proposal, "proposalDetail.proposal");
}

async function fetchDisputeDetail(
  baseOptions: BaseCliOptions,
  disputePda: string,
): Promise<Record<string, unknown>> {
  const output = await runMarketCommand(
    baseOptions,
    runMarketDisputeDetailCommand as MarketRunner,
    { disputePda },
  );
  return asRecord(output.dispute, "disputeDetail.dispute");
}

async function fetchReputationSummary(
  baseOptions: BaseCliOptions,
  signerKey: string,
  agentPda?: string,
): Promise<Record<string, unknown>> {
  const output = await runMarketCommand(
    baseOptions,
    runMarketReputationSummaryCommand as MarketRunner,
    { agentPda },
    signerKey,
  );
  return asRecord(output.summary, "reputationSummary.summary");
}

function isDelegationActive(expiresAt: number, nowUnixSeconds: number): boolean {
  return expiresAt === 0 || expiresAt > nowUnixSeconds;
}

function formatDelegationOccupancy(
  candidate: AgentActor,
  amount: number,
  expiresAt: number,
  nowUnixSeconds: number,
): string {
  const expiry =
    expiresAt === 0
      ? "no-expiry"
      : isDelegationActive(expiresAt, nowUnixSeconds)
        ? `expires:${formatUnix(expiresAt)}`
        : `expired:${formatUnix(expiresAt)}`;
  return `${candidate.label}:${candidate.agentPda.toBase58()}=amount:${amount},${expiry}`;
}

async function selectDelegationTarget(
  reputationOps: ReputationEconomyOperations,
  delegator: AgentActor,
  candidates: AgentActor[],
  amount: number,
): Promise<{ target: AgentActor; reusedExisting: boolean }> {
  const occupied: string[] = [];
  let reusable: AgentActor | null = null;
  const nowUnixSeconds = Math.floor(Date.now() / 1000);

  for (const candidate of candidates) {
    const existing = await reputationOps.getDelegation(
      delegator.agentPda,
      candidate.agentPda,
    );
    if (!existing) {
      return { target: candidate, reusedExisting: false };
    }

    occupied.push(
      formatDelegationOccupancy(
        candidate,
        existing.amount,
        existing.expiresAt,
        nowUnixSeconds,
      ),
    );
    if (
      reusable === null &&
      existing.amount === amount &&
      isDelegationActive(existing.expiresAt, nowUnixSeconds)
    ) {
      reusable = candidate;
    }
  }

  if (reusable) {
    return { target: reusable, reusedExisting: true };
  }

  throw new Error(
    `No delegation target available for amount ${amount}. Existing delegation accounts: ${occupied.join(", ")}`,
  );
}

async function resolveDisputeViaTui(
  baseOptions: BaseCliOptions,
  authoritySigner: SignerContext,
  disputePda: string,
  votes: Array<{ votePda: string; arbiterAgentPda: string }>,
): Promise<void> {
  const text = await runTuiSession(baseOptions, authoritySigner, [
    "4",
    `resolve ${disputePda}`,
    formatVotePairs(votes),
    "",
    "",
    "back",
    "q",
  ]);
  assertTuiSuccess(text, "dispute resolve");
}

const taskCreationMsBySigner = new Map<string, number>();

async function waitForTaskCreationCooldown(
  signerKey: string,
  cooldownSeconds: number,
): Promise<void> {
  if (cooldownSeconds <= 0) {
    return;
  }

  const lastCreatedAt = taskCreationMsBySigner.get(signerKey);
  if (lastCreatedAt === undefined) {
    return;
  }

  const remainingMs = lastCreatedAt + cooldownSeconds * 1000 - Date.now();
  if (remainingMs <= 0) {
    return;
  }

  const waitSeconds = Math.ceil(remainingMs / 1000);
  console.log(
    `[wait] sleeping ${waitSeconds}s for task creation cooldown on ${signerKey}`,
  );
  await sleep(remainingMs + 1000);
}

async function createTaskViaTui(
  baseOptions: BaseCliOptions,
  signer: AgentActor,
  description: string,
  rewardLamports: bigint,
  requiredCapabilities: number,
  taskCreationCooldownSeconds: number,
): Promise<{ text: string; taskPda: string }> {
  await waitForTaskCreationCooldown(
    signer.agentPda.toBase58(),
    taskCreationCooldownSeconds,
  );

  // Keep this sequence aligned with the prompts in runtime/src/cli/marketplace-tui.ts.
  const text = await runTuiSession(baseOptions, signer, [
    "1",
    "create",
    description,
    "",
    "",
    "",
    "",
    "",
    "",
    rewardLamports.toString(),
    requiredCapabilities.toString(),
    "",
    "",
    "",
    "auto",
    "",
    "back",
    "q",
  ]);
  assertTuiSuccess(text, "task creation");
  const taskPda = extractPayloadString(text, "task creation", "taskPda");
  taskCreationMsBySigner.set(signer.agentPda.toBase58(), Date.now());
  return { text, taskPda };
}

async function runInitial(): Promise<void> {
  const rpcUrl = process.env.AGENC_RPC_URL ?? DEFAULT_RPC_URL;
  const programId = parseOptionalProgramId();
  const taskRewardLamports = readBigIntEnv(
    "AGENC_TASK_REWARD_LAMPORTS",
    DEFAULT_TASK_REWARD_LAMPORTS,
  );
  const skillPriceLamports = readBigIntEnv(
    "AGENC_SKILL_PRICE_LAMPORTS",
    DEFAULT_SKILL_PRICE_LAMPORTS,
  );
  const reputationStakeLamports = readBigIntEnv(
    "AGENC_REPUTATION_STAKE_LAMPORTS",
    DEFAULT_REPUTATION_STAKE_LAMPORTS,
  );
  const delegationAmount = readNumberEnv(
    "AGENC_DELEGATION_AMOUNT",
    DEFAULT_DELEGATION_AMOUNT,
  );
  const proposalVotingPeriod = readNumberEnv(
    "AGENC_PROPOSAL_VOTING_PERIOD",
    DEFAULT_PROPOSAL_VOTING_PERIOD,
  );
  const maxWaitSeconds = readNumberEnv(
    "AGENC_MAX_WAIT_SECONDS",
    DEFAULT_MAX_WAIT_SECONDS,
  );
  const rpcCooldownMs = readNumberEnv(
    "AGENC_RPC_COOLDOWN_MS",
    DEFAULT_RPC_COOLDOWN_MS,
  );
  const rpcRetryAttempts = readNumberEnv(
    "AGENC_RPC_RETRY_ATTEMPTS",
    DEFAULT_RPC_RETRY_ATTEMPTS,
  );
  const rpcRetryDelayMs = readNumberEnv(
    "AGENC_RPC_RETRY_DELAY_MS",
    DEFAULT_RPC_RETRY_DELAY_MS,
  );
  const artifactPath = getFlagValue("--artifact");

  if (delegationAmount < MIN_DELEGATION_AMOUNT) {
    throw new Error(
      `AGENC_DELEGATION_AMOUNT must be at least ${MIN_DELEGATION_AMOUNT}`,
    );
  }

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
  await validateProtocolConfigHealth(connection, readOnlyProgram, protocolConfig);

  const creatorStake = maxBigInt(
    protocolConfig.minAgentStake,
    protocolConfig.minStakeForDispute * 2n,
  );
  const workerStake = protocolConfig.minAgentStake;
  const arbiterStake = maxBigInt(
    protocolConfig.minAgentStake,
    protocolConfig.minArbiterStake,
  );
  const agentRegistrationRentLamports = await getRentExemptLamports(
    connection,
    AGENT_REGISTRATION_SIZE,
  );

  const [
    creatorAgentCount,
    workerAgentCount,
    arbiterAgentCountA,
    arbiterAgentCountB,
    arbiterAgentCountC,
  ] = await Promise.all([
    countAgentRegistrations(
      connection,
      readOnlyProgram.programId,
      creatorSigner.keypair.publicKey,
    ),
    countAgentRegistrations(
      connection,
      readOnlyProgram.programId,
      workerSigner.keypair.publicKey,
    ),
    countAgentRegistrations(
      connection,
      readOnlyProgram.programId,
      arbiterASigner.keypair.publicKey,
    ),
    countAgentRegistrations(
      connection,
      readOnlyProgram.programId,
      arbiterBSigner.keypair.publicKey,
    ),
    countAgentRegistrations(
      connection,
      readOnlyProgram.programId,
      arbiterCSigner.keypair.publicKey,
    ),
  ]);

  await Promise.all([
    ensureBalance(
      connection,
      "creator",
      creatorSigner.keypair.publicKey,
      (creatorAgentCount > 0
        ? 0n
        : creatorStake + agentRegistrationRentLamports) +
        reputationStakeLamports +
        taskRewardLamports * 3n +
        DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "worker",
      workerSigner.keypair.publicKey,
      (workerAgentCount > 0
        ? 0n
        : workerStake + agentRegistrationRentLamports) +
        skillPriceLamports +
        DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "arbiter-a",
      arbiterASigner.keypair.publicKey,
      (arbiterAgentCountA > 0
        ? 0n
        : arbiterStake + agentRegistrationRentLamports) +
        DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "arbiter-b",
      arbiterBSigner.keypair.publicKey,
      (arbiterAgentCountB > 0
        ? 0n
        : arbiterStake + agentRegistrationRentLamports) +
        DEFAULT_FEE_BUFFER_LAMPORTS,
    ),
    ensureBalance(
      connection,
      "arbiter-c",
      arbiterCSigner.keypair.publicKey,
      (arbiterAgentCountC > 0
        ? 0n
        : arbiterStake + agentRegistrationRentLamports) +
        DEFAULT_FEE_BUFFER_LAMPORTS,
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
  console.log(`[config] task reward lamports: ${taskRewardLamports.toString()}`);
  console.log(`[config] skill price lamports: ${skillPriceLamports.toString()}`);
  console.log(`[config] reputation stake lamports: ${reputationStakeLamports.toString()}`);
  console.log(`[config] delegation amount: ${delegationAmount}`);
  console.log(`[config] proposal voting period: ${proposalVotingPeriod}`);
  console.log(`[config] max wait seconds: ${maxWaitSeconds}`);
  console.log(`[config] rpc cooldown ms: ${rpcCooldownMs}`);
  console.log(`[config] rpc retry attempts: ${rpcRetryAttempts}`);
  console.log(`[config] rpc retry delay ms: ${rpcRetryDelayMs}`);
  console.log(`[config] agent registration rent lamports: ${agentRegistrationRentLamports.toString()}`);
  console.log(`[config] creator wallet: ${creatorSigner.keypair.publicKey.toBase58()}`);
  console.log(`[config] worker wallet: ${workerSigner.keypair.publicKey.toBase58()}`);
  console.log(`[config] authority wallet: ${authoritySigner.keypair.publicKey.toBase58()}`);

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

  await ensureGovernanceInitialized(
    authoritySigner,
    protocolConfig,
    proposalVotingPeriod,
  );

  const runtime: SmokeRuntime = {
    connection,
    readOnlyProgram,
    signersByKey: new Map<string, SignerContext>([
      [creator.agentPda.toBase58(), creator],
      [creator.walletPath, creator],
      [worker.agentPda.toBase58(), worker],
      [worker.walletPath, worker],
      [arbiterA.agentPda.toBase58(), arbiterA],
      [arbiterA.walletPath, arbiterA],
      [arbiterB.agentPda.toBase58(), arbiterB],
      [arbiterB.walletPath, arbiterB],
      [arbiterC.agentPda.toBase58(), arbiterC],
      [arbiterC.walletPath, arbiterC],
      ["authority", authoritySigner],
      [authoritySigner.walletPath, authoritySigner],
    ]),
  };
  installMarketplaceCliOverrides(runtime);

  const baseOptions = buildBaseOptions(
    rpcUrl,
    readOnlyProgram.programId.toBase58(),
  );
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const creatorKey = creator.agentPda.toBase58();
  const workerKey = worker.agentPda.toBase58();
  const creatorReputationOps = new ReputationEconomyOperations({
    program: readOnlyProgram,
    agentId: creator.agentId,
    logger: silentLogger,
  });

  try {
    console.log("[phase] reputation");
    const beforeStakeSummary = await fetchReputationSummary(baseOptions, creatorKey);
    const beforeStakedAmount = BigInt(
      getStringField(beforeStakeSummary, "stakedAmount", "beforeStakeSummary"),
    );

    console.log("[tui] reputation summary start");
    const summaryText = await runTuiSession(baseOptions, creator, [
      "5",
      "summary",
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(summaryText, "reputation summary");
    console.log("[tui] reputation summary done");

    console.log("[tui] reputation stake start");
    const stakeText = await runTuiSession(baseOptions, creator, [
      "5",
      "stake",
      reputationStakeLamports.toString(),
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(stakeText, "reputation stake");
    console.log("[tui] reputation stake done");

    await waitFor(
      "reputation stake to settle",
      DEFAULT_STATE_WAIT_SECONDS,
      async () => {
        const summary = await fetchReputationSummary(baseOptions, creatorKey);
        const stakedAmount = BigInt(
          getStringField(summary, "stakedAmount", "afterStakeSummary"),
        );
        if (stakedAmount < beforeStakedAmount + reputationStakeLamports) {
          throw new Error(
            `stakedAmount ${stakedAmount.toString()} is below expected minimum ${(beforeStakedAmount + reputationStakeLamports).toString()}`,
          );
        }
        return summary;
      },
    );

    const delegationSelection = await selectDelegationTarget(
      creatorReputationOps,
      creator,
      [worker, arbiterA, arbiterB, arbiterC],
      delegationAmount,
    );
    const delegationTarget = delegationSelection.target;
    console.log(
      `[delegation] target: ${delegationTarget.label} ${delegationTarget.agentPda.toBase58()}${
        delegationSelection.reusedExisting ? " (reusing existing delegation)" : ""
      }`,
    );
    if (!delegationSelection.reusedExisting) {
      console.log("[tui] reputation delegate start");
      const delegateText = await runTuiSession(baseOptions, creator, [
        "5",
        "delegate",
        String(delegationAmount),
        delegationTarget.agentPda.toBase58(),
        "",
        "",
        "back",
        "q",
      ]);
      assertTuiSuccess(delegateText, "reputation delegate");
      console.log("[tui] reputation delegate done");
    } else {
      console.log("[tui] reputation delegate skipped; matching delegation already exists");
    }

    await waitFor(
      "reputation delegation to settle",
      DEFAULT_STATE_WAIT_SECONDS,
      async () => {
        const delegation = await creatorReputationOps.getDelegation(
          creator.agentPda,
          delegationTarget.agentPda,
        );
        if (!delegation) {
          throw new Error(
            `delegation account missing for ${delegationTarget.agentPda.toBase58()}`,
          );
        }
        if (delegation.amount !== delegationAmount) {
          throw new Error(
            `delegation amount ${delegation.amount} does not match ${delegationAmount}`,
          );
        }
        if (delegation.expiresAt !== 0) {
          throw new Error(
            `delegation expiresAt ${delegation.expiresAt} does not match the expected no-expiry delegation`,
          );
        }
        return delegation;
      },
    );

    console.log("[phase] task cancel flow");
    const { taskPda: cancelTaskPda } = await createTaskViaTui(
      baseOptions,
      creator,
      `tui-cancel-${runId}`,
      taskRewardLamports,
      AgentCapabilities.COMPUTE,
      protocolConfig.taskCreationCooldown,
    );
    await waitFor("cancel task creation settlement", DEFAULT_STATE_WAIT_SECONDS, async () => {
      const task = await fetchTaskDetail(baseOptions, cancelTaskPda);
      const status = getStringField(task, "status", "cancelCreatedTask");
      const creator = getStringField(task, "creator", "cancelCreatedTask");
      if (status !== "open") {
        throw new Error(`task status is ${status}`);
      }
      if (creator !== creatorSigner.keypair.publicKey.toBase58()) {
        throw new Error(`task creator ${creator} does not match creator wallet`);
      }
      return task;
    });

    const cancelText = await runTuiSession(baseOptions, creator, [
      "1",
      `cancel ${cancelTaskPda}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(cancelText, "task cancel");

    await waitFor("cancelled task status", DEFAULT_STATE_WAIT_SECONDS, async () => {
      const task = await fetchTaskDetail(baseOptions, cancelTaskPda);
      const status = getStringField(task, "status", "cancelTaskDetail");
      if (status !== "cancelled") {
        throw new Error(`task status is ${status}`);
      }
      return task;
    });

    console.log("[phase] task completion flow");
    const { taskPda: completeTaskPda } = await createTaskViaTui(
      baseOptions,
      creator,
      `tui-complete-${runId}`,
      taskRewardLamports,
      AgentCapabilities.COMPUTE,
      protocolConfig.taskCreationCooldown,
    );
    await waitFor(
      "completion task creation settlement",
      DEFAULT_STATE_WAIT_SECONDS,
      async () => {
        const task = await fetchTaskDetail(baseOptions, completeTaskPda);
        const status = getStringField(task, "status", "completeCreatedTask");
        const creator = getStringField(task, "creator", "completeCreatedTask");
        if (status !== "open") {
          throw new Error(`task status is ${status}`);
        }
        if (creator !== creatorSigner.keypair.publicKey.toBase58()) {
          throw new Error(`task creator ${creator} does not match creator wallet`);
        }
        return task;
      },
    );

    const claimText = await runTuiSession(baseOptions, worker, [
      "1",
      `claim ${completeTaskPda}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(claimText, "task claim");
    const completeClaimPda = extractPayloadString(claimText, "task claim", "claimPda");

    await waitFor("claimed task worker count", DEFAULT_STATE_WAIT_SECONDS, async () => {
      const task = await fetchTaskDetail(baseOptions, completeTaskPda);
      const workers = getNumberField(task, "currentWorkers", "claimedTaskDetail");
      if (workers < 1) {
        throw new Error(`currentWorkers is ${workers}`);
      }
      return task;
    });

    const completionText = await runTuiSession(baseOptions, worker, [
      "1",
      `complete ${completeTaskPda}`,
      `tui complete ${runId}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(completionText, "task completion");

    await waitFor("completed task status", DEFAULT_STATE_WAIT_SECONDS, async () => {
      const task = await fetchTaskDetail(baseOptions, completeTaskPda);
      const status = getStringField(task, "status", "completedTaskDetail");
      if (status !== "completed") {
        throw new Error(`task status is ${status}`);
      }
      return task;
    });

    console.log("[phase] skills");
    const skillRegistration = await executeToolJson(
      creator,
      connection,
      programId,
      "agenc.registerSkill",
      {
        name: `tui-skill-${runId}`.slice(0, 32),
        contentHash: createHash("sha256")
          .update(`skill-content-${runId}`)
          .digest("hex"),
        price: skillPriceLamports.toString(),
        tags: ["tui", "devnet", runId.slice(0, 8)],
      },
    );
    const skillPda = getStringField(skillRegistration, "skillPda", "registerSkill");
    console.log(`[skill] registered ${skillPda}`);

    const skillDetailText = await runTuiSession(baseOptions, worker, [
      "2",
      `detail ${skillPda}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(skillDetailText, "skill detail");

    const skillPurchaseText = await runTuiSession(baseOptions, worker, [
      "2",
      `purchase ${skillPda}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(skillPurchaseText, "skill purchase");

    await waitFor("skill purchase visibility", DEFAULT_STATE_WAIT_SECONDS, async () => {
      const skill = await fetchSkillDetail(baseOptions, skillPda, workerKey);
      if (!getBooleanField(skill, "purchased", "purchasedSkillDetail")) {
        throw new Error("skill detail does not show purchased=true");
      }
      return skill;
    });

    const skillRateText = await runTuiSession(baseOptions, worker, [
      "2",
      `rate ${skillPda}`,
      "5",
      `solid skill ${runId}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(skillRateText, "skill rating");

    await waitFor("skill rating visibility", DEFAULT_STATE_WAIT_SECONDS, async () => {
      const skill = await fetchSkillDetail(baseOptions, skillPda, workerKey);
      const ratingCount = getNumberField(skill, "ratingCount", "ratedSkillDetail");
      const rating = getNumberField(skill, "rating", "ratedSkillDetail");
      if (ratingCount < 1) {
        throw new Error(`ratingCount is ${ratingCount}`);
      }
      if (rating < 5) {
        throw new Error(`rating is ${rating}`);
      }
      return skill;
    });

    console.log("[phase] governance");
    const proposalRegistration = await executeToolJson(
      creator,
      connection,
      programId,
      "agenc.createProposal",
      {
        proposalType: "protocol_upgrade",
        title: `TUI governance ${runId}`,
        description: `TUI governance proposal ${runId}`,
        votingPeriod: proposalVotingPeriod,
      },
    );
    const proposalPda = getStringField(
      proposalRegistration,
      "proposalPda",
      "createProposal",
    );
    console.log(`[proposal] created ${proposalPda}`);

    const governanceDetailText = await runTuiSession(baseOptions, creator, [
      "3",
      `detail ${proposalPda}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(governanceDetailText, "governance proposal detail");

    const governanceVoteText = await runTuiSession(baseOptions, creator, [
      "3",
      `vote ${proposalPda}`,
      "yes",
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(governanceVoteText, "governance vote");

    await waitFor("governance vote visibility", DEFAULT_STATE_WAIT_SECONDS, async () => {
      const proposal = await fetchProposalDetail(baseOptions, proposalPda);
      const votesFor = BigInt(
        getStringField(proposal, "votesFor", "proposalAfterVote"),
      );
      if (votesFor < 1n) {
        throw new Error(`votesFor is ${votesFor.toString()}`);
      }
      return proposal;
    });

    console.log("[phase] dispute flow");
    const { taskPda: disputeTaskPda } = await createTaskViaTui(
      baseOptions,
      creator,
      `tui-dispute-${runId}`,
      taskRewardLamports,
      AgentCapabilities.COMPUTE,
      protocolConfig.taskCreationCooldown,
    );
    await waitFor("dispute task creation settlement", DEFAULT_STATE_WAIT_SECONDS, async () => {
      const task = await fetchTaskDetail(baseOptions, disputeTaskPda);
      const status = getStringField(task, "status", "disputeCreatedTask");
      const creator = getStringField(task, "creator", "disputeCreatedTask");
      if (status !== "open") {
        throw new Error(`task status is ${status}`);
      }
      if (creator !== creatorSigner.keypair.publicKey.toBase58()) {
        throw new Error(`task creator ${creator} does not match creator wallet`);
      }
      return task;
    });

    const disputeClaimText = await runTuiSession(baseOptions, worker, [
      "1",
      `claim ${disputeTaskPda}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(disputeClaimText, "task claim");
    const disputeClaimPda = extractPayloadString(disputeClaimText, "task claim", "claimPda");

    const taskDisputeText = await runTuiSession(baseOptions, creator, [
      "1",
      `dispute ${disputeTaskPda}`,
      `creator dispute ${runId}`,
      "refund",
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(taskDisputeText, "task dispute");
    const disputePda = extractPayloadString(taskDisputeText, "task dispute", "disputePda");

    const disputeDetailText = await runTuiSession(baseOptions, creator, [
      "4",
      `detail ${disputePda}`,
      "",
      "back",
      "q",
    ]);
    assertTuiSuccess(disputeDetailText, "dispute detail");

    const arbiterVotes = await castVotes(disputePda, disputeTaskPda, disputeClaimPda, [
      arbiterA,
      arbiterB,
      arbiterC,
    ]);

    const disputeBeforeResolve = await fetchDisputeDetail(baseOptions, disputePda);
    const votingDeadline = getNumberField(
      disputeBeforeResolve,
      "votingDeadline",
      "disputeBeforeResolve",
    );
    console.log(`[dispute] voting deadline: ${formatUnix(votingDeadline)}`);

    const waited = await waitForDeadline(votingDeadline, maxWaitSeconds);
    if (!waited) {
      const artifact: TuiSmokeArtifact = {
        version: 1,
        kind: "marketplace-tui-devnet-smoke",
        createdAt: new Date().toISOString(),
        rpcUrl,
        programId: readOnlyProgram.programId.toBase58(),
        runId,
        authorityPubkey: authoritySigner.keypair.publicKey.toBase58(),
        taskPda: disputeTaskPda,
        disputePda,
        workerClaimPda: disputeClaimPda,
        votingDeadline,
        arbiterVotes,
      };
      const savedPath = await writeArtifact(artifact, artifactPath);
      console.log(
        `[pending] dispute deadline ${formatUnix(votingDeadline)} exceeds max wait of ${maxWaitSeconds}s`,
      );
      console.log(`[artifact] ${savedPath}`);
      console.log(
        `[resume] PROTOCOL_AUTHORITY_WALLET=${authoritySigner.walletPath} npm run smoke:marketplace:tui:devnet -- --resume ${savedPath}`,
      );
      return;
    }

    await resolveDisputeViaTui(baseOptions, authoritySigner, disputePda, arbiterVotes);

    const disputeAfterResolve = await waitFor(
      "resolved dispute status",
      DEFAULT_STATE_WAIT_SECONDS,
      async () => {
        const dispute = await fetchDisputeDetail(baseOptions, disputePda);
        const status = getStringField(dispute, "status", "disputeAfterResolve");
        if (status === "active") {
          throw new Error("dispute is still active");
        }
        return dispute;
      },
    );
    const taskAfterResolve = await fetchTaskDetail(baseOptions, disputeTaskPda);

    console.log(
      `[ok] marketplace TUI devnet smoke complete: dispute status=${getStringField(disputeAfterResolve, "status", "disputeAfterResolve")}, task status=${getStringField(taskAfterResolve, "status", "taskAfterResolve")}, task claim=${completeClaimPda}`,
    );
  } finally {
    resetMarketplaceCliProgramContextOverrides();
  }
}

async function runResume(): Promise<void> {
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
    const disputeBeforeResolve = await fetchDisputeDetail(baseOptions, artifact.disputePda);
    const disputeStatus = getStringField(
      disputeBeforeResolve,
      "status",
      "resume.disputeBefore",
    );
    const votingDeadline = getNumberField(
      disputeBeforeResolve,
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

    await resolveDisputeViaTui(baseOptions, authoritySigner, artifact.disputePda, artifact.arbiterVotes);

    const disputeAfterResolve = await waitFor(
      "resumed dispute resolution",
      DEFAULT_STATE_WAIT_SECONDS,
      async () => {
        const dispute = await fetchDisputeDetail(baseOptions, artifact.disputePda);
        const status = getStringField(dispute, "status", "resume.disputeAfter");
        if (status === "active") {
          throw new Error("dispute is still active");
        }
        return dispute;
      },
    );
    const taskAfterResolve = await fetchTaskDetail(baseOptions, artifact.taskPda);

    console.log(
      `[ok] resumed marketplace TUI dispute resolution complete: dispute status=${getStringField(disputeAfterResolve, "status", "resume.disputeAfter")}, task status=${getStringField(taskAfterResolve, "status", "resume.taskAfter")}`,
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
    await runResume();
    return;
  }

  await runInitial();
}

main().catch((error) => {
  console.error(
    `[error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
