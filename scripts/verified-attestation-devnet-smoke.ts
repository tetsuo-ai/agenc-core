#!/usr/bin/env node
/**
 * Devnet smoke for the verified-task attestation flow added in PR #541.
 *
 * Exercises the three review fixes end-to-end against the live devnet
 * marketplace program:
 *   1. Pending → consumed replay marker lifecycle around create_task.
 *   2. Re-verification at read time (link store).
 *   3. Pre-submit failures do not consume a nonce.
 *
 * Requires:
 *   - SOLANA_KEYPAIR_PATH (or default ~/.config/solana/id.json) funded on devnet.
 *   - AGENC_RPC_URL (default https://api.devnet.solana.com).
 *   - Optional AGENC_PROGRAM_ID override; otherwise the runtime default is used.
 *
 * Usage:
 *   npx tsx scripts/verified-attestation-devnet-smoke.ts
 */

import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  createProgram,
  keypairToWallet,
  loadKeypairFromFileSync,
  silentLogger,
} from "../runtime/src/index.js";
import { runMarketTaskCreateCommand } from "../runtime/src/cli/marketplace-cli.js";
import { createAgencTools } from "../runtime/src/tools/agenc/index.js";
import {
  buildCanonicalMarketplaceTaskPayload,
  canonicalJson,
  computeCanonicalMarketplaceTaskHash,
  type MarketplaceCanonicalTaskInput,
  type VerifiedTaskAttestation,
} from "../runtime/src/marketplace/verified-task-attestation.js";
import {
  linkMarketplaceJobSpecToTask,
  persistMarketplaceJobSpec,
  readMarketplaceJobSpecPointerForTask,
} from "../runtime/src/marketplace/job-spec-store.js";
import { signAgentMessage } from "../runtime/src/social/crypto.js";
import { AnchorProvider } from "@coral-xyz/anchor";

const RPC_URL = process.env.AGENC_RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR_PATH ??
  path.join(homedir(), ".config", "solana", "id.json");
const PROGRAM_ID_OVERRIDE = process.env.AGENC_PROGRAM_ID;

type SectionResult = "pass" | "fail";

interface SectionReport {
  name: string;
  result: SectionResult;
  notes: string;
}

const reports: SectionReport[] = [];

function record(name: string, result: SectionResult, notes = ""): void {
  reports.push({ name, result, notes });
  const tag = result === "pass" ? "PASS" : "FAIL";
  process.stdout.write(`[${tag}] ${name}${notes ? ` — ${notes}` : ""}\n`);
}

function info(message: string): void {
  process.stdout.write(`  · ${message}\n`);
}

function makeNonce(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function makeTaskIdHex(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function captureCli(): {
  context: any;
  records: { stdout: string[]; stderr: string[] };
  lastJson: () => unknown;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context = {
    output: (payload: unknown) => {
      stdout.push(typeof payload === "string" ? payload : JSON.stringify(payload));
    },
    error: (payload: unknown) => {
      stderr.push(typeof payload === "string" ? payload : JSON.stringify(payload));
    },
  };
  return {
    context,
    records: { stdout, stderr },
    lastJson: () => {
      const last = stdout[stdout.length - 1];
      if (!last) return null;
      try {
        return JSON.parse(last);
      } catch {
        return last;
      }
    },
  };
}

function signAttestation(
  keypair: Keypair,
  unsigned: Omit<VerifiedTaskAttestation, "signature">,
): VerifiedTaskAttestation {
  const sig = signAgentMessage(
    keypair,
    new TextEncoder().encode(canonicalJson(unsigned)),
  );
  return { ...unsigned, signature: Buffer.from(sig).toString("hex") };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Discriminator + offsets must stay in sync with the on-chain agent layout.
const AGENT_DISCRIMINATOR = Buffer.from([130, 53, 100, 103, 121, 77, 148, 19]);
const AGENT_AUTHORITY_OFFSET = 40;

async function ensureCreatorAgent(
  rpcUrl: string,
  creator: Keypair,
  programIdOverride?: string,
): Promise<PublicKey> {
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new AnchorProvider(
    connection,
    keypairToWallet(creator),
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  const program = programIdOverride
    ? createProgram(provider, new PublicKey(programIdOverride))
    : createProgram(provider);

  // Look for an existing registration owned by this signer.
  const bs58 = await import("bs58");
  const matches = await connection.getProgramAccounts(program.programId, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.default.encode(AGENT_DISCRIMINATOR) } },
      {
        memcmp: {
          offset: AGENT_AUTHORITY_OFFSET,
          bytes: creator.publicKey.toBase58(),
        },
      },
    ],
  });
  if (matches.length > 0) {
    return new PublicKey(matches[0]!.pubkey);
  }

  // No agent — register one.
  info("no creator agent found; registering one");
  const tools = createAgencTools(
    {
      connection,
      wallet: keypairToWallet(creator),
      programId: program.programId,
      logger: silentLogger,
    },
    { includeMutationTools: true },
  );
  const registerTool = tools.find((t) => t.name === "agenc.registerAgent");
  if (!registerTool) throw new Error("agenc.registerAgent tool unavailable");
  const result = await registerTool.execute({
    capabilities: "1",
    endpoint: `https://agenc.local/devnet-smoke/${creator.publicKey.toBase58().slice(0, 8)}`,
    stakeAmount: "5000000",
  });
  if (result.isError) {
    throw new Error(
      `registerAgent failed: ${typeof result.content === "string" ? result.content : JSON.stringify(result.content)}`,
    );
  }
  const payload = JSON.parse(result.content as string) as { agentPda?: string };
  if (!payload.agentPda) throw new Error("registerAgent returned no agentPda");
  return new PublicKey(payload.agentPda);
}

async function main(): Promise<number> {
  process.stdout.write(
    `verified-attestation devnet smoke\n  rpc=${RPC_URL}\n  keypair=${KEYPAIR_PATH}\n`,
  );

  const creator = loadKeypairFromFileSync(KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, "confirmed");
  const balance = await connection.getBalance(creator.publicKey);
  process.stdout.write(
    `  signer=${creator.publicKey.toBase58()} balance=${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`,
  );
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    record("balance", "fail", `${balance} lamports < 0.05 SOL`);
    return 1;
  }

  // Workspace dirs.
  const jobSpecStoreDir = await mkdtemp(
    path.join(tmpdir(), "agenc-verified-jobspec-"),
  );
  const replayStoreDir = await mkdtemp(
    path.join(tmpdir(), "agenc-verified-replay-"),
  );
  await mkdir(jobSpecStoreDir, { recursive: true });
  await mkdir(replayStoreDir, { recursive: true });
  process.stdout.write(
    `  jobSpecStoreDir=${jobSpecStoreDir}\n  replayStoreDir=${replayStoreDir}\n`,
  );

  // Issuer keypair — its public key goes into the allowlist.
  const issuer = Keypair.generate();
  const issuerKeyId = "storefront-devnet-smoke";
  const issuerKeysJson = JSON.stringify({
    [issuerKeyId]: issuer.publicKey.toBase58(),
  });

  const creatorAgentPda = await ensureCreatorAgent(
    RPC_URL,
    creator,
    PROGRAM_ID_OVERRIDE,
  );
  process.stdout.write(`  creatorAgentPda=${creatorAgentPda.toBase58()}\n`);

  // ---------- Section 1: happy path create_task with verified attestation ----------
  const taskId = makeTaskIdHex();
  const taskDescription = `Smoke verified task ${new Date().toISOString()}`;
  const reward = "10000000"; // 0.01 SOL
  const requiredCapabilities = "1";
  const deadline = Math.floor(Date.now() / 1000) + 6 * 60 * 60; // +6h
  const taskType = 0;
  const minReputation = 0;
  const validationMode = "auto" as const;

  const jobSpec = await persistMarketplaceJobSpec(
    {
      description: taskDescription,
      jobSpec: { custom: { smokeRun: true } },
      acceptanceCriteria: ["smoke run succeeds"],
      deliverables: ["verified marker on devnet"],
      attachments: [],
      context: {
        rewardLamports: reward,
        requiredCapabilities,
        rewardMint: null,
        maxWorkers: 1,
        deadline,
        taskType,
        minReputation,
        validationMode,
        reviewWindowSecs: null,
        creatorAgentPda: creatorAgentPda.toBase58(),
      },
    },
    { rootDir: jobSpecStoreDir },
  );
  info(`jobSpecHash=${jobSpec.hash}`);

  const canonical: MarketplaceCanonicalTaskInput = {
    environment: "devnet",
    creatorWallet: creator.publicKey.toBase58(),
    creatorAgentPda: creatorAgentPda.toBase58(),
    taskDescription,
    rewardLamports: reward,
    requiredCapabilities,
    rewardMint: null,
    maxWorkers: 1,
    deadline,
    taskType,
    minReputation,
    constraintHash: null,
    validationMode: "auto",
    reviewWindowSecs: null,
    jobSpecHash: jobSpec.hash,
  };
  buildCanonicalMarketplaceTaskPayload(canonical);
  const canonicalTaskHash = computeCanonicalMarketplaceTaskHash(canonical);
  const nonce = makeNonce("devnet-smoke");
  const attestation = signAttestation(issuer, {
    kind: "agenc.marketplace.verifiedTaskAttestation",
    schemaVersion: 1,
    environment: "devnet",
    issuer: "agenc-services-storefront",
    issuerKeyId,
    orderId: `smoke-${nonce}`,
    serviceTemplateId: "smoke-template",
    jobSpecHash: jobSpec.hash,
    canonicalTaskHash,
    buyerWallet: creator.publicKey.toBase58(),
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const attestationPath = path.join(jobSpecStoreDir, "attestation.json");
  await writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);

  const baseCliOptions = {
    rpcUrl: RPC_URL,
    keypairPath: KEYPAIR_PATH,
    output: "json" as const,
    ...(PROGRAM_ID_OVERRIDE ? { programId: PROGRAM_ID_OVERRIDE } : {}),
  };

  const cli1 = captureCli();
  const code1 = await runMarketTaskCreateCommand(cli1.context as any, {
    ...baseCliOptions,
    description: taskDescription,
    reward,
    requiredCapabilities,
    deadline,
    taskType: String(taskType),
    minReputation,
    validationMode,
    reviewWindowSecs: undefined,
    rewardMint: undefined,
    maxWorkers: 1,
    constraintHash: undefined,
    creatorAgentPda: creatorAgentPda.toBase58(),
    jobSpec: undefined,
    jobSpecUri: jobSpec.uri,
    jobSpecPublishUri: undefined,
    verifiedAttestation: attestationPath,
    verifiedTaskIssuerKeys: issuerKeysJson,
    verifiedTaskReplayStoreDir: replayStoreDir,
    jobSpecStoreDir,
  } as any);

  if (code1 !== 0) {
    record(
      "create verified task on devnet",
      "fail",
      `exit=${code1} stdout=${cli1.records.stdout.join(" | ").slice(0, 600)} stderr=${cli1.records.stderr.join(" | ").slice(0, 600)}`,
    );
    return 1;
  }
  const created = cli1.lastJson() as Record<string, any>;
  // The CLI envelopes results — peel either shape.
  const inner =
    (created?.result as Record<string, any>) ??
    (created as Record<string, any>) ??
    {};
  const taskPda = inner?.taskPda ?? created?.taskPda;
  const txSig = inner?.transactionSignature ?? created?.transactionSignature;
  const verifiedStatus = inner?.verifiedStatus ?? created?.verifiedStatus;
  const verifiedHash = inner?.verifiedTaskHash ?? created?.verifiedTaskHash;
  if (!taskPda || verifiedStatus !== "verified" || !verifiedHash) {
    record(
      "create verified task on devnet",
      "fail",
      `payload=${JSON.stringify(created).slice(0, 600)}`,
    );
    return 1;
  }
  // Print the FULL transaction signature so reviewers can copy it directly into
  // the explorer / RPC without truncation guesswork.
  process.stdout.write(`  · createTaskTxSignature=${txSig}\n`);
  const jobSpecTxSig =
    inner?.jobSpecTransactionSignature ?? created?.jobSpecTransactionSignature;
  if (jobSpecTxSig) {
    process.stdout.write(`  · setTaskJobSpecTxSignature=${jobSpecTxSig}\n`);
  }
  record(
    "create verified task on devnet",
    "pass",
    `taskPda=${taskPda} verifiedTaskHash=${verifiedHash} createTaskTx=${txSig}`,
  );

  // ---------- Section 2: replay marker is `consumed`, not `pending` ----------
  const hashMarkerPath = path.join(replayStoreDir, "hashes", `${verifiedHash}.json`);
  let hashMarker: any;
  try {
    hashMarker = JSON.parse(await readFile(hashMarkerPath, "utf8"));
  } catch (error) {
    record(
      "replay marker finalized to consumed",
      "fail",
      `unable to read ${hashMarkerPath}: ${(error as Error).message}`,
    );
    return 1;
  }
  if (
    hashMarker?.state !== "consumed" ||
    !hashMarker?.consumedAt ||
    hashMarker?.verifiedTask?.transactionSignature !== txSig
  ) {
    record(
      "replay marker finalized to consumed",
      "fail",
      `marker=${JSON.stringify(hashMarker).slice(0, 600)}`,
    );
    return 1;
  }
  record(
    "replay marker finalized to consumed",
    "pass",
    `state=consumed reservedAt=${hashMarker.reservedAt} consumedAt=${hashMarker.consumedAt}`,
  );

  // ---------- Section 3: re-submission with the same attestation is rejected ----------
  // The in-process createTask dedup keys on (creator|description) with a 30s
  // TTL — wait it out so we exercise the replay-store rejection rather than
  // the dedup short-circuit.
  info("waiting 31s for createTask dedup TTL to expire…");
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  const cli2 = captureCli();
  const replayCode = await runMarketTaskCreateCommand(cli2.context as any, {
    ...baseCliOptions,
    description: taskDescription,
    reward,
    requiredCapabilities,
    deadline,
    taskType: String(taskType),
    minReputation,
    validationMode,
    reviewWindowSecs: undefined,
    rewardMint: undefined,
    maxWorkers: 1,
    constraintHash: undefined,
    creatorAgentPda: creatorAgentPda.toBase58(),
    jobSpec: undefined,
    jobSpecUri: jobSpec.uri,
    jobSpecPublishUri: undefined,
    verifiedAttestation: attestationPath,
    verifiedTaskIssuerKeys: issuerKeysJson,
    verifiedTaskReplayStoreDir: replayStoreDir,
    jobSpecStoreDir,
  } as any);
  const replayPayload =
    cli2.lastJson() ?? cli2.records.stderr.join(" | ");
  const replayMessage = JSON.stringify(replayPayload);
  if (
    replayCode === 0 ||
    !/already consumed|in flight|replay/i.test(replayMessage)
  ) {
    record(
      "second submission rejected by replay store",
      "fail",
      `exit=${replayCode} payload=${replayMessage.slice(0, 600)}`,
    );
    return 1;
  }
  record(
    "second submission rejected by replay store",
    "pass",
    `exit=${replayCode}`,
  );

  // ---------- Section 4: re-verification on read of the task link ----------
  const pointerWithKeys = await readMarketplaceJobSpecPointerForTask(taskPda, {
    rootDir: jobSpecStoreDir,
    verifiedTaskIssuerKeys: { [issuerKeyId]: issuer.publicKey.toBase58() },
  });
  if (
    !pointerWithKeys?.verifiedTask ||
    pointerWithKeys.verifiedTask.verifiedTaskHash !== verifiedHash ||
    pointerWithKeys.verifiedTask.status !== "verified"
  ) {
    record(
      "re-read with issuer keys reproduces verifiedTask",
      "fail",
      `pointer=${JSON.stringify(pointerWithKeys).slice(0, 600)}`,
    );
    return 1;
  }
  record(
    "re-read with issuer keys reproduces verifiedTask",
    "pass",
    `verifiedTaskHash=${pointerWithKeys.verifiedTask.verifiedTaskHash}`,
  );

  const pointerNoKeys = await readMarketplaceJobSpecPointerForTask(taskPda, {
    rootDir: jobSpecStoreDir,
  });
  if (pointerNoKeys?.verifiedTask) {
    record(
      "re-read without issuer keys reports unverified",
      "fail",
      `pointer.verifiedTask=${JSON.stringify(pointerNoKeys.verifiedTask).slice(0, 600)}`,
    );
    return 1;
  }
  record(
    "re-read without issuer keys reports unverified",
    "pass",
    "verifiedTask=null",
  );

  // Tamper test — flip a byte in the on-disk attestation signature.
  const linkPath = pointerWithKeys.jobSpecTaskLinkPath;
  const linkRaw = JSON.parse(await readFile(linkPath, "utf8"));
  const original = JSON.parse(JSON.stringify(linkRaw));
  linkRaw.verifiedTaskAttestation = {
    ...linkRaw.verifiedTaskAttestation,
    signature: "00".repeat(64),
  };
  await writeFile(linkPath, `${JSON.stringify(linkRaw)}\n`);
  const tamperedPointer = await readMarketplaceJobSpecPointerForTask(taskPda, {
    rootDir: jobSpecStoreDir,
    verifiedTaskIssuerKeys: { [issuerKeyId]: issuer.publicKey.toBase58() },
  });
  await writeFile(linkPath, `${JSON.stringify(original)}\n`);
  if (tamperedPointer?.verifiedTask) {
    record(
      "tampered link signature is rejected",
      "fail",
      `verifiedTask=${JSON.stringify(tamperedPointer.verifiedTask).slice(0, 600)}`,
    );
    return 1;
  }
  record("tampered link signature is rejected", "pass", "verifiedTask=null");

  // ---------- Section 4b: cross-link attestation copy (independent canonical binding) ----------
  // Persist a second link sharing the same jobSpecHash but with different
  // canonical task material, then copy the live A-attestation into B's link
  // and assert verifiedTask comes back null. This validates the
  // independent-binding fix against the same on-disk format the live
  // create-task path just produced.
  const taskBPda = Keypair.generate().publicKey.toBase58();
  const taskBId = createHash("sha256").update("smoke-task-B").digest("hex");
  const canonicalA = {
    environment: "devnet" as const,
    creatorWallet: creator.publicKey.toBase58(),
    creatorAgentPda: creatorAgentPda.toBase58(),
    taskDescription,
    rewardLamports: reward,
    requiredCapabilities,
    rewardMint: null,
    maxWorkers: 1,
    deadline,
    taskType,
    minReputation,
    constraintHash: null,
    validationMode: "auto" as const,
    reviewWindowSecs: null,
    jobSpecHash: jobSpec.hash,
  };
  const canonicalB = {
    ...canonicalA,
    taskDescription: `${taskDescription} — task B (different)`,
    rewardLamports: "20000000",
    maxWorkers: 2,
  };
  const attestationB = signAttestation(issuer, {
    kind: "agenc.marketplace.verifiedTaskAttestation",
    schemaVersion: 1,
    environment: "devnet",
    issuer: "agenc-services-storefront",
    issuerKeyId,
    orderId: `smoke-${nonce}-B`,
    serviceTemplateId: "smoke-template",
    jobSpecHash: jobSpec.hash,
    canonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalB),
    buyerWallet: creator.publicKey.toBase58(),
    nonce: makeNonce("devnet-smoke-B"),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const linkBPath = await linkMarketplaceJobSpecToTask(
    {
      hash: jobSpec.hash,
      uri: jobSpec.uri,
      taskPda: taskBPda,
      taskId: taskBId,
      transactionSignature: "tx-B-mock",
      verifiedTaskAttestation: attestationB,
      verifiedTaskAcceptedAt: new Date().toISOString(),
      verifiedTaskCanonicalInput: canonicalB,
    },
    { rootDir: jobSpecStoreDir },
  );

  // Sanity: B reads as verified before tampering.
  const okB = await readMarketplaceJobSpecPointerForTask(taskBPda, {
    rootDir: jobSpecStoreDir,
    verifiedTaskIssuerKeys: { [issuerKeyId]: issuer.publicKey.toBase58() },
  });
  if (!okB?.verifiedTask) {
    record(
      "task-B link verified before swap",
      "fail",
      `pointer=${JSON.stringify(okB).slice(0, 600)}`,
    );
    return 1;
  }

  // Read the live A-attestation off the live A-link on disk and copy it into
  // B's link, leaving B's persisted canonical task material in place.
  const liveALinkPath = pointerWithKeys.jobSpecTaskLinkPath;
  const liveALink = JSON.parse(await readFile(liveALinkPath, "utf8"));
  const linkBObj = JSON.parse(await readFile(linkBPath, "utf8"));
  linkBObj.verifiedTaskAttestation = liveALink.verifiedTaskAttestation;
  await writeFile(linkBPath, `${JSON.stringify(linkBObj)}\n`);
  const tamperedB = await readMarketplaceJobSpecPointerForTask(taskBPda, {
    rootDir: jobSpecStoreDir,
    verifiedTaskIssuerKeys: { [issuerKeyId]: issuer.publicKey.toBase58() },
  });
  if (tamperedB?.verifiedTask) {
    record(
      "cross-link attestation swap is rejected",
      "fail",
      `verifiedTask=${JSON.stringify(tamperedB.verifiedTask).slice(0, 600)}`,
    );
    return 1;
  }
  record(
    "cross-link attestation swap is rejected",
    "pass",
    "verifiedTask=null (independent canonical binding caught the swap)",
  );

  // ---------- Section 5: pre-submit failure does NOT consume a new nonce ----------
  const failNonce = makeNonce("devnet-smoke-fail");
  const badAttestation = signAttestation(issuer, {
    kind: "agenc.marketplace.verifiedTaskAttestation",
    schemaVersion: 1,
    environment: "devnet",
    issuer: "agenc-services-storefront",
    issuerKeyId,
    orderId: `fail-${failNonce}`,
    serviceTemplateId: "smoke-template",
    jobSpecHash: jobSpec.hash,
    // Wrong canonicalTaskHash — won't match the runtime's canonical recompute.
    canonicalTaskHash: "f".repeat(64),
    buyerWallet: creator.publicKey.toBase58(),
    nonce: failNonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const badAttestationPath = path.join(jobSpecStoreDir, "bad-attestation.json");
  await writeFile(
    badAttestationPath,
    `${JSON.stringify(badAttestation, null, 2)}\n`,
  );
  const cli3 = captureCli();
  const failCode = await runMarketTaskCreateCommand(cli3.context as any, {
    ...baseCliOptions,
    description: `${taskDescription} fail`,
    reward,
    requiredCapabilities,
    deadline,
    taskType: String(taskType),
    minReputation,
    validationMode,
    reviewWindowSecs: undefined,
    rewardMint: undefined,
    maxWorkers: 1,
    constraintHash: undefined,
    creatorAgentPda: creatorAgentPda.toBase58(),
    jobSpec: undefined,
    jobSpecUri: jobSpec.uri,
    jobSpecPublishUri: undefined,
    verifiedAttestation: badAttestationPath,
    verifiedTaskIssuerKeys: issuerKeysJson,
    verifiedTaskReplayStoreDir: replayStoreDir,
    jobSpecStoreDir,
  } as any);
  if (failCode === 0) {
    record(
      "pre-submit verification rejects tampered canonicalTaskHash",
      "fail",
      "command unexpectedly succeeded",
    );
    return 1;
  }
  const failNonceKey = sha256Hex(`${issuerKeyId}\0${failNonce}`);
  const failMarker = path.join(replayStoreDir, "nonces", `${failNonceKey}.json`);
  let leakedFailMarker = false;
  try {
    await access(failMarker);
    leakedFailMarker = true;
  } catch {
    leakedFailMarker = false;
  }
  if (leakedFailMarker) {
    record(
      "pre-submit failure leaves no replay marker",
      "fail",
      `marker present at ${failMarker}`,
    );
    return 1;
  }
  record(
    "pre-submit failure leaves no replay marker",
    "pass",
    `nonce=${failNonce}`,
  );

  process.stdout.write("\nsummary:\n");
  for (const r of reports) {
    process.stdout.write(`  [${r.result.toUpperCase()}] ${r.name}\n`);
  }
  return reports.some((r) => r.result === "fail") ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`\nfatal: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
