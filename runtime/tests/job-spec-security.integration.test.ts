import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  resetMarketplaceCliProgramContextOverrides,
  runMarketTaskDetailCommand,
  setMarketplaceCliProgramContextOverrides,
} from "../src/cli/marketplace-cli.js";
import { linkMarketplaceJobSpecToTask } from "../src/marketplace/job-spec-store.js";
import { silentLogger } from "../src/utils/logger.js";

function fixedBytes(value: string, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode(value).slice(0, size));
  return bytes;
}

function bnLike(value: number | bigint) {
  return {
    toNumber: () => Number(value),
    toString: () => String(value),
  };
}

afterEach(() => {
  resetMarketplaceCliProgramContextOverrides();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("marketplace job spec security integration", () => {
  it("market.tasks.detail fails closed without fetching remote job specs by default", async () => {
    const taskPda = PublicKey.unique();
    const taskId = new Uint8Array(32).fill(7);
    const jobSpecStoreDir = await mkdtemp(join(tmpdir(), "agenc-cli-job-spec-"));
    const rawTask = {
      taskId,
      creator: PublicKey.unique(),
      requiredCapabilities: bnLike(1),
      description: fixedBytes("Remote job spec guard", 64),
      constraintHash: new Uint8Array(32),
      rewardAmount: bnLike(1_000_000),
      maxWorkers: 1,
      currentWorkers: 0,
      status: 0,
      taskType: 0,
      createdAt: bnLike(1_700_000_000),
      deadline: bnLike(1_700_010_000),
      completedAt: bnLike(0),
      escrow: PublicKey.unique(),
      result: fixedBytes("", 64),
      completions: 0,
      requiredCompletions: 1,
      bump: 1,
      rewardMint: null,
    };
    const fakeProgram = {
      programId: PublicKey.unique(),
      account: {
        task: {
          fetch: vi.fn(async () => rawTask),
        },
        taskJobSpec: {
          fetch: vi.fn(async () => {
            throw new Error("Account does not exist");
          }),
        },
      },
    };
    setMarketplaceCliProgramContextOverrides({
      async createReadOnlyProgramContext() {
        return { connection: {} as never, program: fakeProgram as never };
      },
    });
    await linkMarketplaceJobSpecToTask(
      {
        hash: "c".repeat(64),
        uri: "https://attacker.invalid/job-spec.json",
        taskPda: taskPda.toBase58(),
        taskId: Buffer.from(taskId).toString("hex"),
        transactionSignature: "remote-job-spec-test",
      },
      { rootDir: jobSpecStoreDir },
    );
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    let output: unknown;
    let error: unknown;
    const code = await runMarketTaskDetailCommand(
      {
        logger: silentLogger,
        outputFormat: "json",
        output(value) {
          output = value;
        },
        error(value) {
          error = value;
        },
      },
      {
        help: false,
        outputFormat: "json",
        strictMode: true,
        storeType: "memory",
        idempotencyWindow: 900,
        rpcUrl: "http://unit.test",
        taskPda: taskPda.toBase58(),
        jobSpecStoreDir,
      },
    );

    expect(code).toBe(1);
    expect(output).toBeUndefined();
    expect(error).toMatchObject({
      code: "MARKET_TASK_DETAIL_FAILED",
      message: expect.stringMatching(/allowRemote=true/),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
