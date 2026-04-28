import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  createAgencMutationTools,
  createAgencReadOnlyTools,
  createAgencTools,
  type MarketplaceSignerPolicy,
} from "./index.js";
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

  it("can explicitly opt into marketplace mutation tools", () => {
    const toolNames = names(
      createAgencTools(makeContext(), { includeMutationTools: true }),
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
    const mutationNames = names(createAgencMutationTools(makeContext()));

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
});
