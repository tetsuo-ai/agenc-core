import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  createCreateTaskTool,
  createGetApprovedTaskTemplateTool,
  createListApprovedTaskTemplatesTool,
} from "./tools.js";
import { signAgentMessage } from "../../social/crypto.js";
import { persistMarketplaceJobSpec, readMarketplaceJobSpecPointerForTask } from "../../marketplace/job-spec-store.js";
import {
  canonicalJson,
  computeCanonicalMarketplaceTaskHash,
  type MarketplaceCanonicalTaskInput,
  type VerifiedTaskAttestation,
} from "../../marketplace/verified-task-attestation.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createAgentRegistrationData(agentIdSeed: number) {
  const data = new Uint8Array(72);
  data.set(new Uint8Array(32).fill(agentIdSeed), 8);
  return data;
}

function createMockTaskCreateProgram(jobSpecPublishError: Error) {
  const creator = PublicKey.unique();
  const creatorAgentPda = PublicKey.unique();
  const createTaskRpc = vi.fn(async () => "create-task-tx");
  const createTaskAccountsPartial = vi.fn(() => ({ rpc: createTaskRpc }));
  const createTask = vi.fn(() => ({ accountsPartial: createTaskAccountsPartial }));
  const setTaskJobSpecRpc = vi.fn(async () => {
    throw jobSpecPublishError;
  });
  const setTaskJobSpecAccountsPartial = vi.fn(() => ({
    rpc: setTaskJobSpecRpc,
  }));
  const setTaskJobSpec = vi.fn(() => ({
    accountsPartial: setTaskJobSpecAccountsPartial,
  }));

  const program = {
    programId: PublicKey.unique(),
    provider: {
      publicKey: creator,
      connection: {
        getProgramAccounts: vi.fn(async () => [
          {
            pubkey: creatorAgentPda,
            account: { data: createAgentRegistrationData(7) },
          },
        ]),
      },
    },
    methods: {
      createTask,
      setTaskJobSpec,
    },
  };

  return {
    program,
    creator,
    creatorAgentPda,
    createTaskAccountsPartial,
    setTaskJobSpec,
    setTaskJobSpecAccountsPartial,
  };
}

function signVerifiedTaskAttestation(
  keypair: Keypair,
  unsigned: Omit<VerifiedTaskAttestation, "signature">,
): VerifiedTaskAttestation {
  const signature = signAgentMessage(
    keypair,
    new TextEncoder().encode(canonicalJson(unsigned)),
  );
  return {
    ...unsigned,
    signature: Buffer.from(signature).toString("hex"),
  };
}

describe("agenc task template tools", () => {
  it("blocks raw agenc.createTask by default", async () => {
    const tool = createCreateTaskTool(
      {
        provider: { publicKey: new PublicKey("11111111111111111111111111111111") },
      } as never,
      createLogger() as never,
    );

    const result = await tool.execute({
      description: "Unsafe raw task",
      reward: "1",
      requiredCapabilities: "1",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      error: expect.stringContaining("Raw agenc.createTask is disabled"),
    });
  });

  it("preserves task creation when devnet does not support job spec metadata publishing", async () => {
    const jobSpecStoreDir = await mkdtemp(
      join(tmpdir(), "agenc-create-task-job-spec-"),
    );
    const unsupportedInstructionError = new Error(
      "InstructionFallbackNotFound\nFallback functions are not supported.",
    );
    const {
      program,
      creator,
      creatorAgentPda,
      createTaskAccountsPartial,
      setTaskJobSpec,
      setTaskJobSpecAccountsPartial,
    } = createMockTaskCreateProgram(unsupportedInstructionError);
    const tool = createCreateTaskTool(program as never, createLogger() as never, {
      allowRawTaskCreation: true,
      jobSpecStoreDir,
    });

    const result = await tool.execute({
      taskDescription: "Devnet ABI warning task",
      reward: "1",
      requiredCapabilities: "1",
      taskId: "11".repeat(32),
      jobSpec: {
        fullDescription: "Exercise unsupported job spec metadata on devnet.",
      },
      jobSpecPublishUri: "https://marketplace-devnet.agenc.tech/api/job-specs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const payload = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(payload.taskPda).toEqual(expect.any(String));
    expect(payload.transactionSignature).toBe("create-task-tx");
    expect(payload.jobSpecTransactionSignature).toBeNull();
    expect(payload.jobSpecTaskLinkPath).toEqual(expect.any(String));
    expect(payload.jobSpecPublishWarning).toContain("Task was created");
    expect(payload.jobSpecPublishWarning).toContain("does not support");
    expect(payload.jobSpecPublishWarning).toContain("InstructionFallbackNotFound");
    expect(setTaskJobSpec).toHaveBeenCalledWith(
      expect.any(Array),
      `https://marketplace-devnet.agenc.tech/api/job-specs/${payload.jobSpecHash}`,
    );
    expect(setTaskJobSpecAccountsPartial).toHaveBeenCalledOnce();
    expect(setTaskJobSpecAccountsPartial).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolConfig: expect.any(PublicKey),
      }),
    );
    expect(createTaskAccountsPartial).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorAgent: creatorAgentPda,
        authorityRateLimit: expect.any(PublicKey),
        authority: creator,
        creator,
      }),
    );
  });

  it("accepts a valid verified storefront attestation and persists verified task metadata", async () => {
    const jobSpecStoreDir = await mkdtemp(
      join(tmpdir(), "agenc-create-task-verified-job-spec-"),
    );
    const replayStoreDir = await mkdtemp(
      join(tmpdir(), "agenc-create-task-verified-replay-"),
    );
    const unsupportedInstructionError = new Error(
      "InstructionFallbackNotFound\nFallback functions are not supported.",
    );
    const {
      program,
      creator,
      creatorAgentPda,
    } = createMockTaskCreateProgram(unsupportedInstructionError);
    const issuer = Keypair.generate();
    const deadline = 4_102_444_800;
    const jobSpec = {
      fullDescription: "Exercise verified storefront task attestation.",
    };
    const stored = await persistMarketplaceJobSpec(
      {
        description: "Verified devnet task",
        jobSpec,
        context: {
          rewardLamports: "1",
          requiredCapabilities: "1",
          templateAudit: null,
          rewardMint: null,
          maxWorkers: 1,
          deadline,
          taskType: 0,
          minReputation: 0,
          validationMode: "auto",
          reviewWindowSecs: null,
          creatorAgentPda: creatorAgentPda.toBase58(),
        },
      },
      { rootDir: jobSpecStoreDir },
    );
    const canonicalTask: MarketplaceCanonicalTaskInput = {
      environment: "devnet",
      creatorWallet: creator.toBase58(),
      creatorAgentPda: creatorAgentPda.toBase58(),
      taskDescription: "Verified devnet task",
      rewardLamports: "1",
      requiredCapabilities: "1",
      rewardMint: null,
      maxWorkers: 1,
      deadline,
      taskType: 0,
      minReputation: 0,
      constraintHash: null,
      validationMode: "auto",
      reviewWindowSecs: null,
      jobSpecHash: stored.hash,
    };
    const attestation = signVerifiedTaskAttestation(issuer, {
      kind: "agenc.marketplace.verifiedTaskAttestation",
      schemaVersion: 1,
      environment: "devnet",
      issuer: "agenc-services-storefront",
      issuerKeyId: "storefront-devnet-1",
      orderId: "order-verified-1",
      serviceTemplateId: "runtime-smoke-test",
      jobSpecHash: stored.hash,
      canonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalTask),
      buyerWallet: creator.toBase58(),
      nonce: "verified-nonce-1",
      issuedAt: "2026-04-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const tool = createCreateTaskTool(program as never, createLogger() as never, {
      allowRawTaskCreation: true,
      jobSpecStoreDir,
      verifiedTaskReplayStoreDir: replayStoreDir,
      verifiedTaskIssuerKeys: {
        "storefront-devnet-1": issuer.publicKey.toBase58(),
      },
    });

    const result = await tool.execute({
      taskDescription: "Verified devnet task",
      reward: "1",
      requiredCapabilities: "1",
      deadline,
      taskId: "22".repeat(32),
      jobSpec,
      verifiedAttestation: attestation,
    });
    const payload = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(payload.verifiedStatus).toBe("verified");
    expect(payload.verifiedIssuerKeyId).toBe("storefront-devnet-1");
    expect(payload.verifiedTaskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.verifiedTaskUri).toBe(
      `agenc://verified-task/devnet/${payload.verifiedTaskHash}`,
    );
    expect(payload.verifiedTask).toMatchObject({
      status: "verified",
      issuer: "agenc-services-storefront",
      issuerKeyId: "storefront-devnet-1",
      orderId: "order-verified-1",
      serviceTemplateId: "runtime-smoke-test",
      jobSpecHash: stored.hash,
      taskPda: payload.taskPda,
      taskId: "22".repeat(32),
      transactionSignature: "create-task-tx",
    });

    const pointer = await readMarketplaceJobSpecPointerForTask(payload.taskPda, {
      rootDir: jobSpecStoreDir,
      verifiedTaskIssuerKeys: {
        "storefront-devnet-1": issuer.publicKey.toBase58(),
      },
    });
    expect(pointer?.verifiedTask).toMatchObject({
      verifiedTaskHash: payload.verifiedTaskHash,
      verifiedTaskUri: payload.verifiedTaskUri,
      status: "verified",
    });

    // Re-reading without the issuer keyring should report the task as
    // unverified; on-disk metadata is never trusted directly.
    const pointerWithoutKeys = await readMarketplaceJobSpecPointerForTask(
      payload.taskPda,
      { rootDir: jobSpecStoreDir },
    );
    expect(pointerWithoutKeys?.verifiedTask).toBeNull();

    // Tampering with the on-disk file should not be enough to surface
    // verified status either — re-verification of the signed attestation must
    // still succeed against the issuer keyring.
    const linkPath = pointer?.jobSpecTaskLinkPath;
    if (linkPath) {
      const { readFile, writeFile } = await import("node:fs/promises");
      const raw = JSON.parse(await readFile(linkPath, "utf8"));
      raw.verifiedTaskAttestation = {
        ...raw.verifiedTaskAttestation,
        signature: "00".repeat(64),
      };
      await writeFile(linkPath, `${JSON.stringify(raw)}\n`, "utf8");
      const tamperedPointer = await readMarketplaceJobSpecPointerForTask(
        payload.taskPda,
        {
          rootDir: jobSpecStoreDir,
          verifiedTaskIssuerKeys: {
            "storefront-devnet-1": issuer.publicKey.toBase58(),
          },
        },
      );
      expect(tamperedPointer?.verifiedTask).toBeNull();
    }
  });

  it("uses taskDescription (not description) as the input schema property name", () => {
    const tool = createCreateTaskTool(
      {
        provider: { publicKey: new PublicKey("11111111111111111111111111111111") },
      } as never,
      createLogger() as never,
    );

    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("taskDescription");
    expect(props).not.toHaveProperty("description");
  });

  it("requires taskDescription (not description) in the input schema", () => {
    const tool = createCreateTaskTool(
      {
        provider: { publicKey: new PublicKey("11111111111111111111111111111111") },
      } as never,
      createLogger() as never,
    );

    const required = tool.inputSchema.required as string[];
    expect(required).toContain("taskDescription");
    expect(required).not.toContain("description");
  });

  it("lists approved task templates", async () => {
    const result = await createListApprovedTaskTemplatesTool(
      createLogger() as never,
    ).execute({});

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content) as { templates: { id: string }[] };
    expect(payload.templates.some((template) => template.id === "runtime-smoke-test")).toBe(true);
  });

  it("fetches a selected approved task template", async () => {
    const result = await createGetApprovedTaskTemplateTool(
      createLogger() as never,
    ).execute({ templateId: "runtime-smoke-test" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      template: { id: "runtime-smoke-test", status: "approved" },
    });
  });
});
