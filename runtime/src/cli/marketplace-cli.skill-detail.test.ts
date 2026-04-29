import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const { parseAgentState, serializeMarketplaceSkill, isPurchased } = vi.hoisted(
  () => ({
    parseAgentState: vi.fn(),
    serializeMarketplaceSkill: vi.fn(),
    isPurchased: vi.fn(),
  }),
);

vi.mock("../agent/types.js", async () => {
  const actual = await vi.importActual<typeof import("../agent/types.js")>(
    "../agent/types.js",
  );
  return {
    ...actual,
    parseAgentState,
  };
});

vi.mock("../marketplace/serialization.js", async () => {
  const actual = await vi.importActual<
    typeof import("../marketplace/serialization.js")
  >("../marketplace/serialization.js");
  return {
    ...actual,
    serializeMarketplaceSkill,
  };
});

vi.mock("../skills/registry/client.js", () => ({
  OnChainSkillRegistryClient: class OnChainSkillRegistryClient {},
}));

vi.mock("../skills/registry/payment.js", () => ({
  SkillPurchaseManager: class SkillPurchaseManager {
    async isPurchased(...args: unknown[]) {
      return isPurchased(...args);
    }
  },
}));

import {
  resetMarketplaceCliProgramContextOverrides,
  runMarketTaskCreateCommand,
  runMarketSkillDetailCommand,
  setMarketplaceCliProgramContextOverrides,
} from "./marketplace-cli.js";

function createContext() {
  const output = vi.fn();
  const error = vi.fn();
  return {
    context: {
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      },
      output,
      error,
      outputFormat: "json",
    },
    output,
    error,
  };
}

const BASE_OPTIONS = {
  help: false,
  outputFormat: "json" as const,
  strictMode: false,
  rpcUrl: "https://api.devnet.solana.com",
  programId: "GN69CoBM1XUt8MJtA6Kwd7WRwLzTNtVqLwf5o3fwWDV3",
  storeType: "memory" as const,
  idempotencyWindow: 60_000,
  skillPda: "11111111111111111111111111111111",
};

describe("runMarketSkillDetailCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serializeMarketplaceSkill.mockReturnValue({
      skillPda: BASE_OPTIONS.skillPda,
      skillId: "deadbeef",
      author: "Author1111111111111111111111111111111111",
      name: "skill detail",
      tags: ["marketplace"],
      priceLamports: "500000",
      priceSol: "0.0005",
      priceMint: null,
      rating: 0,
      ratingCount: 0,
      downloads: 0,
      version: 1,
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
      contentHash: "cafebabe",
    });
  });

  afterEach(() => {
    resetMarketplaceCliProgramContextOverrides();
    vi.unstubAllEnvs();
  });

  it("returns bare skill detail when signer context is unavailable", async () => {
    setMarketplaceCliProgramContextOverrides({
      async createReadOnlyProgramContext() {
        return {
          connection: {} as never,
          program: {
            account: {
              skillRegistration: {
                fetchNullable: vi.fn(async () => ({ skillId: new Uint8Array(32) })),
              },
            },
          } as never,
        };
      },
      async createSignerProgramContext() {
        throw new Error("no signer context");
      },
    });

    const { context, output, error } = createContext();
    const status = await runMarketSkillDetailCommand(context, BASE_OPTIONS);

    expect(status).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith({
      status: "ok",
      command: "market.skills.detail",
      schema: "market.skills.detail.output.v1",
      skill: serializeMarketplaceSkill.mock.results[0]!.value,
    });
  });

  it("surfaces purchase lookup failures instead of silently dropping purchased visibility", async () => {
    const signerAuthority = new PublicKey(
      "5rUtdMbmkNsQ1wbVaKAkyWv16ZLzGka5CgWqQZRqxGcS",
    );
    parseAgentState.mockReturnValue({
      authority: signerAuthority,
      agentId: new Uint8Array(32),
    });
    isPurchased.mockRejectedValue(new Error("429 Too Many Requests"));

    setMarketplaceCliProgramContextOverrides({
      async createReadOnlyProgramContext() {
        return {
          connection: {} as never,
          program: {
            account: {
              skillRegistration: {
                fetchNullable: vi.fn(async () => ({ skillId: new Uint8Array(32) })),
              },
            },
          } as never,
        };
      },
      async createSignerProgramContext() {
        return {
          connection: {} as never,
          program: {
            programId: new PublicKey(BASE_OPTIONS.programId),
            provider: {
              publicKey: signerAuthority,
            },
            account: {
              agentRegistration: {
                fetch: vi.fn(async () => ({})),
              },
            },
          } as never,
        };
      },
    });

    const { context, output, error } = createContext();
    const status = await runMarketSkillDetailCommand(context, {
      ...BASE_OPTIONS,
      buyerAgentPda: "BbRg9DTts7fQ5xrkfLgHKxeADuCLAbv214KnQEEPsVQT",
    });

    expect(status).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        code: "MARKET_SKILL_DETAIL_FAILED",
        message: "429 Too Many Requests",
      }),
    );
  });
});

describe("marketplace CLI signer policy", () => {
  afterEach(() => {
    resetMarketplaceCliProgramContextOverrides();
    vi.unstubAllEnvs();
  });

  it("denies task creation from AGENC_MARKETPLACE_SIGNER_POLICY before signing", async () => {
    const signerAuthority = new PublicKey(
      "5rUtdMbmkNsQ1wbVaKAkyWv16ZLzGka5CgWqQZRqxGcS",
    );
    setMarketplaceCliProgramContextOverrides({
      async createSignerProgramContext() {
        return {
          connection: {} as never,
          program: {
            programId: new PublicKey(BASE_OPTIONS.programId),
            provider: {
              publicKey: signerAuthority,
            },
          } as never,
        };
      },
    });
    vi.stubEnv(
      "AGENC_MARKETPLACE_SIGNER_POLICY",
      JSON.stringify({ allowedTools: ["agenc.claimTask"] }),
    );

    const { context, output, error } = createContext();
    const status = await runMarketTaskCreateCommand(context, {
      ...BASE_OPTIONS,
      description: "blocked signer policy task",
      reward: "1000",
      requiredCapabilities: "1",
    });

    expect(status).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        code: "MARKET_TASK_CREATE_FAILED",
        message: expect.stringContaining("agenc.createTask is not allowed"),
      }),
    );
  });

  it("extracts jobSpec hash from CLI jobSpec input for signer policy", async () => {
    const signerAuthority = Keypair.generate().publicKey;
    setMarketplaceCliProgramContextOverrides({
      async createSignerProgramContext() {
        return {
          connection: {} as never,
          program: {
            programId: new PublicKey(BASE_OPTIONS.programId),
            provider: {
              publicKey: signerAuthority,
            },
          } as never,
        };
      },
    });
    vi.stubEnv(
      "AGENC_MARKETPLACE_SIGNER_POLICY",
      JSON.stringify({
        allowedTools: ["agenc.createTask"],
        allowedJobSpecHashes: ["b".repeat(64)],
      }),
    );

    const { context, output, error } = createContext();
    const status = await runMarketTaskCreateCommand(context, {
      ...BASE_OPTIONS,
      description: "wrong job spec hash",
      reward: "1000",
      requiredCapabilities: "1",
      jobSpec: JSON.stringify({ hash: "a".repeat(64), uri: "agenc://job-spec" }),
    });

    expect(status).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        code: "MARKET_TASK_CREATE_FAILED",
        message: expect.stringContaining("Job spec hash"),
      }),
    );
  });
});
