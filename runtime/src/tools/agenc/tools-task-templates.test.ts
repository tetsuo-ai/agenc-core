import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  createCreateTaskTool,
  createGetApprovedTaskTemplateTool,
  createListApprovedTaskTemplatesTool,
} from "./tools.js";

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
    setTaskJobSpecAccountsPartial,
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
      setTaskJobSpecAccountsPartial,
    } = createMockTaskCreateProgram(unsupportedInstructionError);
    const tool = createCreateTaskTool(program as never, createLogger() as never, {
      allowRawTaskCreation: true,
      jobSpecStoreDir,
    });

    const result = await tool.execute({
      description: "Devnet ABI warning task",
      reward: "1",
      requiredCapabilities: "1",
      taskId: "11".repeat(32),
      jobSpec: {
        fullDescription: "Exercise unsupported job spec metadata on devnet.",
      },
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
    expect(setTaskJobSpecAccountsPartial).toHaveBeenCalledOnce();
    expect(createTaskAccountsPartial).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorAgent: creatorAgentPda,
        authority: creator,
        creator,
      }),
    );
    expect(createTaskAccountsPartial.mock.calls[0]?.[0]).not.toHaveProperty(
      "authorityRateLimit",
    );
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
