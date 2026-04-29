import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  createAgencMutationTools,
  createAgencReadOnlyTools,
  createAgencTools,
  type MarketplaceSignerPolicy,
} from "./index.js";
import {
  evaluateMarketplaceSignerPolicyForIntent,
  wrapMarketplaceSignerPolicy,
} from "./signer-policy.js";
import type { MarketplaceTransactionIntent } from "../../task/transaction-intent.js";
import { keypairToWallet } from "../../types/wallet.js";
import { silentLogger } from "../../utils/logger.js";

function makeContext(marketplaceSignerPolicy?: MarketplaceSignerPolicy) {
  const keypair = Keypair.generate();
  return {
    connection: new Connection("http://localhost:8899", "confirmed"),
    wallet: keypairToWallet(keypair),
    logger: silentLogger,
    marketplaceSignerPolicy,
  };
}

const ALLOW_ALL_MUTATION_TOOLS_POLICY: MarketplaceSignerPolicy = {
  allowedTools: [
    "agenc.createTaskFromTemplate",
    "agenc.submitTaskTemplateProposal",
    "agenc.registerAgent",
    "agenc.createTask",
    "agenc.claimTask",
    "agenc.completeTask",
    "agenc.registerSkill",
    "agenc.purchaseSkill",
    "agenc.rateSkill",
    "agenc.createProposal",
    "agenc.voteProposal",
    "agenc.initiateDispute",
    "agenc.resolveDispute",
    "agenc.stakeReputation",
    "agenc.delegateReputation",
  ],
};

function names(tools: ReturnType<typeof createAgencTools>): string[] {
  return tools.map((tool) => tool.name).sort();
}

describe("AgenC protocol tool factory", () => {
  it("is read-only by default even when a wallet is present", () => {
    const toolNames = names(createAgencTools(makeContext()));

    expect(toolNames).toContain("agenc.inspectMarketplace");
    expect(toolNames).toContain("agenc.getTask");
    expect(toolNames).toContain("agenc.getProtocolConfig");
    expect(toolNames).not.toContain("agenc.createTask");
    expect(toolNames).not.toContain("agenc.claimTask");
    expect(toolNames).not.toContain("agenc.completeTask");
    expect(toolNames).not.toContain("agenc.purchaseSkill");
    expect(toolNames).not.toContain("agenc.stakeReputation");
  });

  it("does not expose signer-backed mutation tools without a signer policy", () => {
    const toolNames = names(
      createAgencTools(makeContext(), { includeMutationTools: true }),
    );

    expect(toolNames).toContain("agenc.inspectMarketplace");
    expect(toolNames).not.toContain("agenc.createTask");
    expect(toolNames).not.toContain("agenc.claimTask");
    expect(toolNames).not.toContain("agenc.completeTask");
    expect(toolNames).not.toContain("agenc.initiateDispute");
    expect(createAgencMutationTools(makeContext())).toEqual([]);
  });

  it("denies direct signer-policy wrapper execution when policy is missing", async () => {
    const execute = vi.fn(async () => ({ content: "executed" }));
    const wrapped = wrapMarketplaceSignerPolicy(
      {
        name: "agenc.completeTask",
        description: "Complete task",
        inputSchema: {},
        execute,
      },
      {
        programId: PublicKey.unique(),
        signer: PublicKey.unique(),
        logger: silentLogger,
      },
    );

    const result = await wrapped.execute({ taskPda: PublicKey.unique().toBase58() });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("POLICY_REQUIRED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("can explicitly opt into marketplace mutation tools with a signer policy", () => {
    const toolNames = names(
      createAgencTools(makeContext(ALLOW_ALL_MUTATION_TOOLS_POLICY), {
        includeMutationTools: true,
      }),
    );

    expect(toolNames).toContain("agenc.createTask");
    expect(toolNames).toContain("agenc.createTaskFromTemplate");
    expect(toolNames).toContain("agenc.claimTask");
    expect(toolNames).toContain("agenc.completeTask");
    expect(toolNames).toContain("agenc.initiateDispute");
    expect(toolNames).toContain("agenc.resolveDispute");
  });

  it("exposes separate read-only and mutation surfaces", () => {
    const readOnlyNames = names(createAgencReadOnlyTools(makeContext()));
    const mutationNames = names(
      createAgencMutationTools(makeContext(ALLOW_ALL_MUTATION_TOOLS_POLICY)),
    );

    expect(readOnlyNames).toContain("agenc.listTasks");
    expect(readOnlyNames).not.toContain("agenc.createTask");
    expect(mutationNames).toContain("agenc.createTask");
    expect(mutationNames).not.toContain("agenc.listTasks");
  });

  it("denies mutation execution before signing when signer policy does not allow the tool", async () => {
    const registerTool = createAgencMutationTools(
      makeContext({ allowedTools: ["agenc.claimTask"] }),
    ).find((tool) => tool.name === "agenc.registerAgent");

    expect(registerTool).toBeDefined();
    const result = await registerTool!.execute({ stakeAmount: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("MARKETPLACE_SIGNER_POLICY_DENIED");
    expect(result.content).toContain("TOOL_NOT_ALLOWED");
  });

  it("enforces signer policy lamport caps before execution", async () => {
    const registerTool = createAgencMutationTools(
      makeContext({
        allowedTools: ["agenc.registerAgent"],
        maxStakeLamports: "1",
      }),
    ).find((tool) => tool.name === "agenc.registerAgent");

    expect(registerTool).toBeDefined();
    const result = await registerTool!.execute({ stakeAmount: "2" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("STAKE_LIMIT_EXCEEDED");
  });

  it("evaluates transaction intent previews against signer policy", () => {
    const intent: MarketplaceTransactionIntent = {
      kind: "claim_task_with_job_spec",
      programId: "Market11111111111111111111111111111111111111",
      signer: "Signer11111111111111111111111111111111111111",
      taskPda: "Task111111111111111111111111111111111111111",
      jobSpecHash: "a".repeat(64),
      constraintHash: "0".repeat(64),
      rewardLamports: "100",
      rewardMint: "SOL",
      accountMetas: [],
    };

    expect(
      evaluateMarketplaceSignerPolicyForIntent(
        {
          allowedTools: ["agenc.claimTask"],
          allowedProgramIds: [intent.programId],
          allowedTaskPdas: [intent.taskPda!],
          allowedJobSpecHashes: [intent.jobSpecHash!],
          maxRewardLamports: "100",
          allowedRewardMints: ["SOL"],
        },
        intent,
      ).allowed,
    ).toBe(true);

    const denied = evaluateMarketplaceSignerPolicyForIntent(
      {
        allowedTools: ["agenc.claimTask"],
        allowedConstraintHashes: ["f".repeat(64)],
      },
      intent,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("CONSTRAINT_HASH_NOT_ALLOWED");
  });

  it("evaluates dispute transaction intent previews against signer policy", () => {
    const intent: MarketplaceTransactionIntent = {
      kind: "resolve_dispute",
      programId: "Market11111111111111111111111111111111111111",
      signer: "Signer11111111111111111111111111111111111111",
      taskPda: "Task111111111111111111111111111111111111111",
      disputePda: "Dispute111111111111111111111111111111111111",
      accountMetas: [],
    };

    expect(
      evaluateMarketplaceSignerPolicyForIntent(
        {
          allowedTools: ["agenc.resolveDispute"],
          allowedDisputePdas: [intent.disputePda!],
        },
        intent,
      ).allowed,
    ).toBe(true);

    const denied = evaluateMarketplaceSignerPolicyForIntent(
      {
        allowedTools: ["agenc.resolveDispute"],
        allowedDisputePdas: ["OtherDispute1111111111111111111111111111111"],
      },
      intent,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("DISPUTE_NOT_ALLOWED");
  });

  it("rejects intent previews that violate signer policy bounds", () => {
    const intent: MarketplaceTransactionIntent = {
      kind: "complete_task",
      programId: "Market11111111111111111111111111111111111111",
      signer: "Signer11111111111111111111111111111111111111",
      taskPda: "Task111111111111111111111111111111111111111",
      jobSpecHash: "a".repeat(64),
      constraintHash: "b".repeat(64),
      rewardLamports: "101",
      rewardMint: "SOL",
      accountMetas: [
        {
          name: "task",
          pubkey: "Task111111111111111111111111111111111111111",
          isSigner: false,
          isWritable: true,
        },
      ],
    };

    const cases: Array<{
      name: string;
      policy: MarketplaceSignerPolicy;
      code: string;
    }> = [
      {
        name: "wrong program",
        policy: {
          allowedTools: ["agenc.completeTask"],
          allowedProgramIds: ["Other1111111111111111111111111111111111111"],
        },
        code: "PROGRAM_NOT_ALLOWED",
      },
      {
        name: "wrong task",
        policy: {
          allowedTools: ["agenc.completeTask"],
          allowedTaskPdas: ["OtherTask111111111111111111111111111111111"],
        },
        code: "TASK_NOT_ALLOWED",
      },
      {
        name: "wrong job spec",
        policy: {
          allowedTools: ["agenc.completeTask"],
          allowedJobSpecHashes: ["c".repeat(64)],
        },
        code: "JOB_SPEC_HASH_NOT_ALLOWED",
      },
      {
        name: "wrong constraint",
        policy: {
          allowedTools: ["agenc.completeTask"],
          allowedConstraintHashes: ["d".repeat(64)],
        },
        code: "CONSTRAINT_HASH_NOT_ALLOWED",
      },
      {
        name: "excessive reward",
        policy: {
          allowedTools: ["agenc.completeTask"],
          maxRewardLamports: "100",
        },
        code: "REWARD_LIMIT_EXCEEDED",
      },
      {
        name: "wrong mint",
        policy: {
          allowedTools: ["agenc.completeTask"],
          allowedRewardMints: ["USDC"],
        },
        code: "REWARD_MINT_NOT_ALLOWED",
      },
      {
        name: "mutated account meta",
        policy: {
          allowedTools: ["agenc.completeTask"],
          expectedAccountMetas: [
            {
              name: "task",
              pubkey: "OtherTask111111111111111111111111111111111",
              isWritable: true,
            },
          ],
        },
        code: "ACCOUNT_META_PUBKEY_MISMATCH",
      },
    ];

    for (const testCase of cases) {
      const decision = evaluateMarketplaceSignerPolicyForIntent(
        testCase.policy,
        intent,
      );
      expect(decision.allowed, testCase.name).toBe(false);
      expect(decision.code, testCase.name).toBe(testCase.code);
    }
  });
});
