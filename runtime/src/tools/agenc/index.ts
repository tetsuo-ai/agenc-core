/**
 * Built-in AgenC protocol query tools.
 *
 * @module
 */

import type { Tool, ToolContext } from "../types.js";
import { TaskOperations } from "../../task/operations.js";
import { createProgram, createReadOnlyProgram } from "../../idl.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  createListTasksTool,
  createInspectMarketplaceTool,
  createGetTaskTool,
  createListSkillsTool,
  createGetSkillTool,
  createListGovernanceProposalsTool,
  createGetGovernanceProposalTool,
  createListDisputesTool,
  createGetDisputeTool,
  createGetReputationSummaryTool,
  createGetTokenBalanceTool,
  createGetJobSpecTool,
  createRegisterAgentTool,
  createCreateTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
} from "./tools.js";
import {
  createClaimTaskTool,
  createCompleteTaskTool,
  createRegisterSkillTool,
  createPurchaseSkillTool,
  createRateSkillTool,
  createCreateProposalTool,
  createVoteProposalTool,
  createInitiateDisputeTool,
  createResolveDisputeTool,
  createStakeReputationTool,
  createDelegateReputationTool,
} from "./mutation-tools.js";

// Re-export serialized types
export type {
  SerializedAgent,
  SerializedDisputeDetail,
  SerializedDisputeSummary,
  SerializedGovernanceProposalDetail,
  SerializedGovernanceProposalSummary,
  SerializedProtocolConfig,
  SerializedReputationSummary,
  SerializedSkill,
  SerializedTask,
} from "./types.js";

// Re-export individual tool factories for advanced usage
export {
  createListTasksTool,
  createInspectMarketplaceTool,
  createGetTaskTool,
  createListSkillsTool,
  createGetSkillTool,
  createListGovernanceProposalsTool,
  createGetGovernanceProposalTool,
  createListDisputesTool,
  createGetDisputeTool,
  createGetReputationSummaryTool,
  createGetTokenBalanceTool,
  createGetJobSpecTool,
  createRegisterAgentTool,
  createCreateTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
} from "./tools.js";
export {
  createClaimTaskTool,
  createCompleteTaskTool,
  createRegisterSkillTool,
  createPurchaseSkillTool,
  createRateSkillTool,
  createCreateProposalTool,
  createVoteProposalTool,
  createInitiateDisputeTool,
  createResolveDisputeTool,
  createStakeReputationTool,
  createDelegateReputationTool,
} from "./mutation-tools.js";

/**
 * Create all built-in AgenC protocol tools.
 *
 * The factory creates a single `TaskOperations` instance shared by
 * all tools. If no program is provided in the context, a read-only
 * program is created from the connection.
 *
 * @param context - Tool context with connection and optional program
 * @returns Array of Tool instances
 *
 * @example
 * ```typescript
 * const tools = createAgencTools({ connection, logger });
 * registry.registerAll(tools);
 * ```
 */
export function createAgencTools(context: ToolContext): Tool[] {
  const program =
    context.program ??
    (() => {
      if (context.wallet) {
        const provider = new AnchorProvider(
          context.connection,
          context.wallet,
          { commitment: "confirmed" },
        );
        return context.programId
          ? createProgram(provider, context.programId)
          : createProgram(provider);
      }
      return context.programId
        ? createReadOnlyProgram(context.connection, context.programId)
        : createReadOnlyProgram(context.connection);
    })();

  // Dummy agentId — built-in tools only use query methods that don't reference agentId
  const dummyAgentId = new Uint8Array(32);

  const ops = new TaskOperations({
    program,
    agentId: dummyAgentId,
    logger: context.logger,
  });

  return [
    createInspectMarketplaceTool(program, context.logger),
    createListTasksTool(ops, context.logger, { program }),
    createGetTaskTool(ops, context.logger, { program }),
    createGetJobSpecTool(context.logger, { program }),
    createListSkillsTool(program, context.logger),
    createGetSkillTool(program, context.logger),
    createListGovernanceProposalsTool(program, context.logger),
    createGetGovernanceProposalTool(program, context.logger),
    createListDisputesTool(program, context.logger),
    createGetDisputeTool(program, context.logger),
    createGetReputationSummaryTool(program, context.logger),
    createGetTokenBalanceTool(program, context.logger),
    createRegisterAgentTool(program, context.logger),
    createCreateTaskTool(program, context.logger),
    createClaimTaskTool(program, context.logger),
    createCompleteTaskTool(program, context.logger),
    createRegisterSkillTool(program, context.logger),
    createPurchaseSkillTool(program, context.logger),
    createRateSkillTool(program, context.logger),
    createCreateProposalTool(program, context.logger),
    createVoteProposalTool(program, context.logger),
    createInitiateDisputeTool(program, context.logger),
    createResolveDisputeTool(program, context.logger),
    createStakeReputationTool(program, context.logger),
    createDelegateReputationTool(program, context.logger),
    createGetAgentTool(program, context.logger),
    createGetProtocolConfigTool(program, context.logger),
  ];
}
