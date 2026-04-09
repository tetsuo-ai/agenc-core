import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  CAPABILITY_ARBITER,
  CAPABILITY_COMPUTE,
  VALID_EVIDENCE,
  deriveProtocolPda,
  ensureAgentRegistered,
} from "../../tests/test-utils.ts";
import { createReadOnlyProgram } from "../src/idl.js";
import {
  resetMarketplaceCliProgramContextOverrides,
  runMarketDisputeDetailCommand,
  runMarketDisputeResolveCommand,
  runMarketDisputesListCommand,
  runMarketGovernanceDetailCommand,
  runMarketGovernanceListCommand,
  runMarketGovernanceVoteCommand,
  runMarketReputationDelegateCommand,
  runMarketReputationStakeCommand,
  runMarketReputationSummaryCommand,
  runMarketSkillDetailCommand,
  runMarketSkillPurchaseCommand,
  runMarketSkillRateCommand,
  runMarketSkillsListCommand,
  runMarketTaskCancelCommand,
  runMarketTaskClaimCommand,
  runMarketTaskCompleteCommand,
  runMarketTaskCreateCommand,
  runMarketTaskDetailCommand,
  runMarketTaskDisputeCommand,
  runMarketTasksListCommand,
  setMarketplaceCliProgramContextOverrides,
} from "../src/cli/marketplace-cli.js";
import type { BaseCliOptions, CliRuntimeContext } from "../src/cli/types.js";
import { DisputeOperations } from "../src/dispute/operations.js";
import { GovernanceOperations } from "../src/governance/operations.js";
import {
  createCreateProposalTool,
  createRegisterSkillTool,
} from "../src/tools/agenc/mutation-tools.js";
import type { ToolResult } from "../src/tools/types.js";
import { silentLogger } from "../src/utils/logger.js";
import { isProtocolWorkspaceAvailable } from "../../tests/protocol-workspace.ts";
import {
  advanceClock,
  createRuntimeSignerContext,
  createRuntimeTestContext,
  fundAccount,
  initializeProtocol,
  type RuntimeTestContext,
} from "./litesvm-setup.js";
import { registerLiteSVMProgramAccount } from "../../tests/litesvm-connection-proxy.ts";

interface Actor {
  label: string;
  wallet: Keypair;
  agentId: Buffer;
  agentPda: PublicKey;
  runtime: RuntimeTestContext;
}

const BASE_OPTIONS: BaseCliOptions = {
  help: false,
  outputFormat: "json",
  strictMode: true,
  storeType: "memory",
  idempotencyWindow: 900,
  rpcUrl: "http://litesvm.test",
};

const ZERO_AGENT_ID = new Uint8Array(32);
const runId =
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let baseCtx: RuntimeTestContext;
let protocolPda: PublicKey;
let activeSignerAgentPda: string | null = null;
const describeIfProtocolWorkspace = isProtocolWorkspaceAvailable()
  ? describe
  : describe.skip;

let creator: Actor;
let worker: Actor;
let author: Actor;
let buyer: Actor;
let proposer: Actor;
let voter: Actor;
let delegatee: Actor;
let arbiter1: Actor;
let arbiter2: Actor;
let arbiter3: Actor;

const actorsByAgentPda = new Map<string, Actor>();

function makeAgentId(label: string): Buffer {
  return Buffer.from(`${label}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

function expectString(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

function expectNumber(value: unknown): number {
  expect(typeof value).toBe("number");
  return value as number;
}

function expectArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

function parseToolPayload(result: ToolResult): Record<string, unknown> {
  expect(result.isError, result.content).not.toBe(true);
  return asRecord(JSON.parse(result.content));
}

function resolveSignerAgentPda(options: BaseCliOptions): string | null {
  if (activeSignerAgentPda) {
    return activeSignerAgentPda;
  }

  const lookup = options as Record<string, unknown>;
  const keys = [
    "creatorAgentPda",
    "workerAgentPda",
    "initiatorAgentPda",
    "buyerAgentPda",
    "raterAgentPda",
    "voterAgentPda",
    "stakerAgentPda",
    "delegatorAgentPda",
  ];

  for (const key of keys) {
    const value = lookup[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

async function createActor(
  label: string,
  capabilities: number,
): Promise<Actor> {
  const wallet = Keypair.generate();
  fundAccount(baseCtx.svm, wallet.publicKey, 20 * LAMPORTS_PER_SOL);

  const runtime = createRuntimeSignerContext(baseCtx.svm, wallet);
  const agentId = makeAgentId(label);
  const agentPda = await ensureAgentRegistered({
    program: runtime.program,
    protocolPda,
    agentId,
    authority: wallet,
    capabilities,
    stakeLamports: LAMPORTS_PER_SOL,
  });

  const actor: Actor = {
    label,
    wallet,
    agentId,
    agentPda,
    runtime,
  };
  actorsByAgentPda.set(agentPda.toBase58(), actor);
  registerLiteSVMProgramAccount(baseCtx.connection, agentPda);
  registerLiteSVMProgramAccount(actor.runtime.connection, agentPda);
  return actor;
}

async function runMarketCommand(
  runner: (
    context: CliRuntimeContext,
    options: any,
  ) => Promise<0 | 1 | 2>,
  options: Record<string, unknown>,
  signerAgentPda?: string,
): Promise<Record<string, unknown>> {
  let output: unknown;
  let error: unknown;

  activeSignerAgentPda = signerAgentPda ?? null;
  try {
    const code = await runner(
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
        ...BASE_OPTIONS,
        ...options,
      },
    );

    expect(code, JSON.stringify(error)).toBe(0);
    expect(error).toBeUndefined();
    expect(output).toBeDefined();
    return asRecord(output);
  } finally {
    activeSignerAgentPda = null;
  }
}

beforeAll(async () => {
  if (!isProtocolWorkspaceAvailable()) {
    return;
  }
  baseCtx = createRuntimeTestContext();
  await initializeProtocol(baseCtx);
  protocolPda = deriveProtocolPda(baseCtx.program.programId);

  const governanceOps = new GovernanceOperations({
    program: baseCtx.program,
    agentId: ZERO_AGENT_ID,
    logger: silentLogger,
  });
  if (!(await governanceOps.fetchGovernanceConfig())) {
    await governanceOps.initializeGovernance({
      votingPeriod: 300,
      executionDelay: 60,
      quorumBps: 1000,
      approvalThresholdBps: 5001,
      minProposalStake: 1_000_000,
    });
  }

  creator = await createActor("creator", CAPABILITY_COMPUTE);
  worker = await createActor("worker", CAPABILITY_COMPUTE);
  author = await createActor("author", CAPABILITY_COMPUTE);
  buyer = await createActor("buyer", CAPABILITY_COMPUTE);
  proposer = await createActor("proposer", CAPABILITY_COMPUTE);
  voter = await createActor("voter", CAPABILITY_COMPUTE);
  delegatee = await createActor("delegatee", CAPABILITY_COMPUTE);
  arbiter1 = await createActor("arbiter1", CAPABILITY_ARBITER);
  arbiter2 = await createActor("arbiter2", CAPABILITY_ARBITER);
  arbiter3 = await createActor("arbiter3", CAPABILITY_ARBITER);

  setMarketplaceCliProgramContextOverrides({
    async createReadOnlyProgramContext() {
      const connection = baseCtx.connection as Connection;
      return {
        connection,
        program: createReadOnlyProgram(connection, baseCtx.program.programId),
      };
    },
    async createSignerProgramContext(options) {
      const agentPda = resolveSignerAgentPda(options);
      if (!agentPda) {
        return {
          connection: baseCtx.connection as Connection,
          program: baseCtx.program,
        };
      }
      const actor = actorsByAgentPda.get(agentPda);
      if (!actor) {
        throw new Error(`Unknown marketplace test signer: ${agentPda}`);
      }
      return {
        connection: actor.runtime.connection as Connection,
        program: actor.runtime.program,
      };
    },
  });
});

afterEach(() => {
  activeSignerAgentPda = null;
  if (baseCtx) {
    advanceClock(baseCtx.svm, 61);
  }
});

afterAll(() => {
  resetMarketplaceCliProgramContextOverrides();
});

describeIfProtocolWorkspace("marketplace CLI integration", () => {
  it("runs task lifecycle commands against LiteSVM", async () => {
    const createPayload = await runMarketCommand(
      runMarketTaskCreateCommand,
      {
        description: "LiteSVM task lifecycle integration",
        reward: String(LAMPORTS_PER_SOL / 20),
        requiredCapabilities: "1",
        creatorAgentPda: creator.agentPda.toBase58(),
      },
      creator.agentPda.toBase58(),
    );
    const createdTask = asRecord(createPayload.result);
    const taskPda = expectString(createdTask.taskPda);
    registerLiteSVMProgramAccount(baseCtx.connection, new PublicKey(taskPda));

    const listPayload = await runMarketCommand(runMarketTasksListCommand, {
      statuses: ["open"],
    });
    const openTasks = expectArray(listPayload.tasks);
    expect(
      openTasks.some(
        (task) => expectString(asRecord(task).taskPda) === taskPda,
      ),
    ).toBe(true);

    const detailBeforeClaim = await runMarketCommand(
      runMarketTaskDetailCommand,
      {
        taskPda,
      },
    );
    expect(asRecord(detailBeforeClaim.task).status).toBe("open");

    const claimPayload = await runMarketCommand(
      runMarketTaskClaimCommand,
      {
        taskPda,
        workerAgentPda: worker.agentPda.toBase58(),
      },
      worker.agentPda.toBase58(),
    );
    const claimResult = asRecord(claimPayload.result);
    expect(expectString(claimResult.workerAgentPda)).toBe(
      worker.agentPda.toBase58(),
    );

    const detailAfterClaim = await runMarketCommand(
      runMarketTaskDetailCommand,
      {
        taskPda,
      },
    );
    expect(asRecord(detailAfterClaim.task).status).toBe("in_progress");

    await runMarketCommand(
      runMarketTaskCompleteCommand,
      {
        taskPda,
        workerAgentPda: worker.agentPda.toBase58(),
        resultData: "marketplace-cli integration result",
      },
      worker.agentPda.toBase58(),
    );

    const detailAfterComplete = await runMarketCommand(
      runMarketTaskDetailCommand,
      {
        taskPda,
      },
    );
    expect(asRecord(detailAfterComplete.task).status).toBe("completed");

    advanceClock(baseCtx.svm, 61);

    const cancelCreatePayload = await runMarketCommand(
      runMarketTaskCreateCommand,
      {
        description: "LiteSVM task cancel integration",
        reward: String(LAMPORTS_PER_SOL / 25),
        requiredCapabilities: "1",
        creatorAgentPda: creator.agentPda.toBase58(),
      },
      creator.agentPda.toBase58(),
    );
    const cancelTaskPda = expectString(
      asRecord(cancelCreatePayload.result).taskPda,
    );
    registerLiteSVMProgramAccount(
      baseCtx.connection,
      new PublicKey(cancelTaskPda),
    );

    await runMarketCommand(
      runMarketTaskCancelCommand,
      {
        taskPda: cancelTaskPda,
      },
      creator.agentPda.toBase58(),
    );

    const cancelledDetail = await runMarketCommand(
      runMarketTaskDetailCommand,
      {
        taskPda: cancelTaskPda,
      },
    );
    expect(asRecord(cancelledDetail.task).status).toBe("cancelled");
  });

  it("runs creator-initiated dispute list/detail/resolve commands", async () => {
    const taskCreatePayload = await runMarketCommand(
      runMarketTaskCreateCommand,
      {
        description: "LiteSVM dispute integration",
        reward: String(LAMPORTS_PER_SOL / 20),
        requiredCapabilities: "1",
        creatorAgentPda: creator.agentPda.toBase58(),
      },
      creator.agentPda.toBase58(),
    );
    const taskPda = expectString(asRecord(taskCreatePayload.result).taskPda);
    registerLiteSVMProgramAccount(baseCtx.connection, new PublicKey(taskPda));

    const claimPayload = await runMarketCommand(
      runMarketTaskClaimCommand,
      {
        taskPda,
        workerAgentPda: worker.agentPda.toBase58(),
      },
      worker.agentPda.toBase58(),
    );
    const claimPda = new PublicKey(
      expectString(asRecord(claimPayload.result).claimPda),
    );

    const disputePayload = await runMarketCommand(
      runMarketTaskDisputeCommand,
      {
        taskPda,
        evidence: VALID_EVIDENCE,
        resolutionType: "refund",
        initiatorAgentPda: creator.agentPda.toBase58(),
      },
      creator.agentPda.toBase58(),
    );
    const disputePda = expectString(asRecord(disputePayload.result).disputePda);
    registerLiteSVMProgramAccount(baseCtx.connection, new PublicKey(disputePda));

    const disputesListPayload = await runMarketCommand(
      runMarketDisputesListCommand,
      {
        statuses: ["active"],
      },
    );
    const disputes = expectArray(disputesListPayload.disputes);
    expect(
      disputes.some(
        (dispute) => expectString(asRecord(dispute).disputePda) === disputePda,
      ),
    ).toBe(true);

    const disputeDetailPayload = await runMarketCommand(
      runMarketDisputeDetailCommand,
      {
        disputePda,
      },
    );
    const detail = asRecord(disputeDetailPayload.dispute);
    expect(detail.status).toBe("active");
    expect(detail.initiatedByCreator).toBe(true);

    const disputeOps1 = new DisputeOperations({
      program: arbiter1.runtime.program,
      agentId: arbiter1.agentId,
      logger: silentLogger,
    });
    const disputeOps2 = new DisputeOperations({
      program: arbiter2.runtime.program,
      agentId: arbiter2.agentId,
      logger: silentLogger,
    });
    const vote1 = await disputeOps1.voteOnDispute({
      disputePda: new PublicKey(disputePda),
      taskPda: new PublicKey(taskPda),
      approve: true,
      workerClaimPda: claimPda,
    });
    const vote2 = await disputeOps2.voteOnDispute({
      disputePda: new PublicKey(disputePda),
      taskPda: new PublicKey(taskPda),
      approve: true,
      workerClaimPda: claimPda,
    });
    const disputeOps3 = new DisputeOperations({
      program: arbiter3.runtime.program,
      agentId: arbiter3.agentId,
      logger: silentLogger,
    });
    const vote3 = await disputeOps3.voteOnDispute({
      disputePda: new PublicKey(disputePda),
      taskPda: new PublicKey(taskPda),
      approve: true,
      workerClaimPda: claimPda,
    });

    const votingDeadline = expectNumber(detail.votingDeadline);
    const now = Number(baseCtx.svm.getClock().unixTimestamp);
    if (votingDeadline >= now) {
      advanceClock(baseCtx.svm, votingDeadline - now + 1);
    }

    await runMarketCommand(
      runMarketDisputeResolveCommand,
      {
        disputePda,
        arbiterVotes: [
          {
            votePda: vote1.votePda.toBase58(),
            arbiterAgentPda: arbiter1.agentPda.toBase58(),
          },
          {
            votePda: vote2.votePda.toBase58(),
            arbiterAgentPda: arbiter2.agentPda.toBase58(),
          },
          {
            votePda: vote3.votePda.toBase58(),
            arbiterAgentPda: arbiter3.agentPda.toBase58(),
          },
        ],
      },
    );

    const resolvedDetailPayload = await runMarketCommand(
      runMarketDisputeDetailCommand,
      {
        disputePda,
      },
    );
    expect(asRecord(resolvedDetailPayload.dispute).status).toBe("resolved");
  });

  it("runs skill marketplace commands with on-chain purchase and rating", async () => {
    const registerTool = createRegisterSkillTool(
      author.runtime.program,
      silentLogger,
    );
    const contentHash = createHash("sha256")
      .update(`marketplace-cli-skill-${runId}`)
      .digest("hex");
    const registeredSkill = parseToolPayload(
      await registerTool.execute({
        name: "Marketplace CLI Test Skill",
        contentHash,
        price: "50000",
        tags: ["cli", "integration"],
        authorAgentPda: author.agentPda.toBase58(),
      }),
    );
    const skillPda = expectString(registeredSkill.skillPda);
    registerLiteSVMProgramAccount(baseCtx.connection, new PublicKey(skillPda));

    const listPayload = await runMarketCommand(runMarketSkillsListCommand, {
      query: "Marketplace CLI Test Skill",
    });
    const skills = expectArray(listPayload.skills);
    expect(
      skills.some(
        (skill) => expectString(asRecord(skill).skillPda) === skillPda,
      ),
    ).toBe(true);

    const detailBeforePurchase = await runMarketCommand(
      runMarketSkillDetailCommand,
      {
        skillPda,
      },
      buyer.agentPda.toBase58(),
    );
    expect(asRecord(detailBeforePurchase.skill).purchased).toBe(false);

    const purchasePayload = await runMarketCommand(
      runMarketSkillPurchaseCommand,
      {
        skillPda,
        buyerAgentPda: buyer.agentPda.toBase58(),
        expectedPrice: "50000",
      },
      buyer.agentPda.toBase58(),
    );
    const purchaseResult = asRecord(purchasePayload.result);
    expect(expectString(purchaseResult.buyerAgentPda)).toBe(
      buyer.agentPda.toBase58(),
    );
    expect(purchaseResult.pricePaid).toBe("50000");

    const detailAfterPurchase = await runMarketCommand(
      runMarketSkillDetailCommand,
      {
        skillPda,
      },
      buyer.agentPda.toBase58(),
    );
    expect(asRecord(detailAfterPurchase.skill).purchased).toBe(true);

    await runMarketCommand(
      runMarketSkillRateCommand,
      {
        skillPda,
        rating: 5,
        review: "Strong terminal flow coverage",
        raterAgentPda: buyer.agentPda.toBase58(),
      },
      buyer.agentPda.toBase58(),
    );

    const detailAfterRating = await runMarketCommand(
      runMarketSkillDetailCommand,
      {
        skillPda,
      },
      buyer.agentPda.toBase58(),
    );
    const ratedSkill = asRecord(detailAfterRating.skill);
    const buyerAgentAccount = asRecord(
      await buyer.runtime.program.account.agentRegistration.fetch(buyer.agentPda),
    );
    expect(ratedSkill.rating).toBe(
      5 * expectNumber(buyerAgentAccount.reputation),
    );
    expect(ratedSkill.ratingCount).toBe(1);
  });

  it("runs governance list/detail/vote commands", async () => {
    const createProposalTool = createCreateProposalTool(
      proposer.runtime.program,
      silentLogger,
    );
    const createdProposal = parseToolPayload(
      await createProposalTool.execute({
        proposalType: "protocol_upgrade",
        title: "Marketplace CLI governance integration",
        description: "Exercise the governance terminal flow against LiteSVM.",
        payload: "marketplace governance terminal coverage",
        proposerAgentPda: proposer.agentPda.toBase58(),
      }),
    );
    const proposalPda = expectString(createdProposal.proposalPda);
    registerLiteSVMProgramAccount(baseCtx.connection, new PublicKey(proposalPda));

    const listPayload = await runMarketCommand(runMarketGovernanceListCommand, {});
    const proposals = expectArray(listPayload.proposals);
    expect(
      proposals.some(
        (proposal) =>
          expectString(asRecord(proposal).proposalPda) === proposalPda,
      ),
    ).toBe(true);

    const detailBeforeVote = await runMarketCommand(
      runMarketGovernanceDetailCommand,
      {
        proposalPda,
      },
    );
    expect(asRecord(detailBeforeVote.proposal).status).toBe("active");

    const votePayload = await runMarketCommand(
      runMarketGovernanceVoteCommand,
      {
        proposalPda,
        approve: true,
        voterAgentPda: voter.agentPda.toBase58(),
      },
      voter.agentPda.toBase58(),
    );
    registerLiteSVMProgramAccount(
      baseCtx.connection,
      new PublicKey(expectString(asRecord(votePayload.result).votePda)),
    );
    const detailAfterVoteRecord = await runMarketCommand(
      runMarketGovernanceDetailCommand,
      {
        proposalPda,
      },
    );
    const proposalAfterVote = asRecord(detailAfterVoteRecord.proposal);
    const proposal = proposalAfterVote;
    expect(proposal.totalVoters).toBe(1);
    expect(proposal.votesFor).toBeTruthy();
    expect(expectArray(proposal.votes)).toHaveLength(1);
  });

  it("runs reputation summary, stake, and delegation commands", async () => {
    await runMarketCommand(
      runMarketReputationStakeCommand,
      {
        amount: String(LAMPORTS_PER_SOL / 10),
        stakerAgentPda: buyer.agentPda.toBase58(),
      },
      buyer.agentPda.toBase58(),
    );

    const delegatePayload = await runMarketCommand(
      runMarketReputationDelegateCommand,
      {
        amount: 500,
        delegatorAgentPda: buyer.agentPda.toBase58(),
        delegateeAgentPda: delegatee.agentPda.toBase58(),
        expiresAt: Number(baseCtx.svm.getClock().unixTimestamp) + 3600,
      },
      buyer.agentPda.toBase58(),
    );
    registerLiteSVMProgramAccount(
      baseCtx.connection,
      new PublicKey(
        expectString(asRecord(delegatePayload.result).delegationPda),
      ),
    );

    const buyerSummaryPayload = await runMarketCommand(
      runMarketReputationSummaryCommand,
      {
        agentPda: buyer.agentPda.toBase58(),
      },
    );
    const buyerSummary = asRecord(buyerSummaryPayload.summary);
    expect(buyerSummary.registered).toBe(true);
    expect(buyerSummary.stakedAmount).toBe(String(LAMPORTS_PER_SOL / 10));
    expect(expectArray(buyerSummary.outboundDelegations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delegatee: delegatee.agentPda.toBase58(),
          amount: 500,
        }),
      ]),
    );

    const delegateeSummaryPayload = await runMarketCommand(
      runMarketReputationSummaryCommand,
      {
        agentPda: delegatee.agentPda.toBase58(),
      },
    );
    const delegateeSummary = asRecord(delegateeSummaryPayload.summary);
    expect(expectArray(delegateeSummary.inboundDelegations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delegator: buyer.agentPda.toBase58(),
          amount: 500,
        }),
      ]),
    );
  });
});
