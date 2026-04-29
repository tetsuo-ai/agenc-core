/**
 * Feature wiring for the daemon: social module.
 *
 * Extracted from daemon.ts to reduce file size.
 *
 * @module
 */

import type { Logger } from "../utils/logger.js";
import type { GatewayConfig } from "./types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { ChannelPlugin } from "./channel.js";
import type { ChatExecutor } from "../llm/chat-executor.js";
import type { ToolHandler, LLMProvider } from "../llm/types.js";
import { loadWallet } from "./wallet-loader.js";

// ============================================================================
// Context bag for feature wiring
// ============================================================================

export interface FeatureWiringContext {
  readonly logger: Logger;
  // Connection
  connectionManager: import("../connection/manager.js").ConnectionManager | null;
  // Social
  agentDiscovery: import("../social/discovery.js").AgentDiscovery | null;
  agentMessaging: import("../social/messaging.js").AgentMessaging | null;
  agentMessagingUnsubscribe: (() => void) | null;
  agentFeed: import("../social/feed.js").AgentFeed | null;
  reputationScorer: import("../social/reputation.js").ReputationScorer | null;
  collaborationProtocol: import("../social/collaboration.js").CollaborationProtocol | null;
  // Shared runtime surfaces
  chatExecutor: ChatExecutor | null;
  memoryBackend: MemoryBackend | null;
  baseToolHandler: ToolHandler | null;
  approvalEngine: import("./approvals.js").ApprovalEngine | null;
  proactiveCommunicator: import("./proactive.js").ProactiveCommunicator | null;
  heartbeatScheduler: import("./heartbeat.js").HeartbeatScheduler | null;
  cronScheduler: import("./scheduler.js").CronScheduler | null;
  mcpManager: import("../mcp-client/manager.js").MCPManager | null;
  // External channels for ProactiveCommunicator
  externalChannels: Map<string, ChannelPlugin>;
  // Gateway config
  gatewayLogging: GatewayConfig["logging"];
  // Workspace
  resolveActiveHostWorkspacePath: (config: GatewayConfig) => string;
  // LLM providers
  llmProviders: LLMProvider[];
  // Social message handler
  handleIncomingSocialMessage?: (message: import("../social/messaging-types.js").AgentMessage) => void;
}

// ============================================================================
// wireSocial
// ============================================================================

export async function wireSocial(
  config: GatewayConfig,
  ctx: FeatureWiringContext,
): Promise<void> {
  if (!config.social?.enabled) return;
  if (!ctx.connectionManager) {
    ctx.logger.warn?.("Social module requires connection config — skipping");
    return;
  }

  const connection = ctx.connectionManager.getConnection();

  const walletResult = await loadWallet(config);
  if (!walletResult) {
    ctx.logger.warn?.(
      "Social module keypair unavailable — write operations disabled",
    );
  }
  const keypair = walletResult?.keypair ?? null;
  const agentId = walletResult?.agentId ?? null;

  // Create program instance
  let program: import("@coral-xyz/anchor").Program<
    import("../types/agenc_coordination.js").AgencCoordination
  >;
  try {
    if (walletResult) {
      const { AnchorProvider } = await import("@coral-xyz/anchor");
      const provider = new AnchorProvider(
        connection,
        walletResult.wallet as any,
        {},
      );
      const { createProgram } = await import("../idl.js");
      program = createProgram(provider);
    } else {
      const { createReadOnlyProgram } = await import("../idl.js");
      program = createReadOnlyProgram(connection);
    }
  } catch (err) {
    ctx.logger.warn?.("Social module program creation failed:", err);
    return;
  }

  // 1. AgentDiscovery (read-only, no wallet needed)
  if (config.social.discoveryEnabled !== false) {
    try {
      const { AgentDiscovery } = await import("../social/discovery.js");
      ctx.agentDiscovery = new AgentDiscovery({
        program,
        logger: ctx.logger,
        cache: {
          ttlMs: config.social.discoveryCacheTtlMs ?? 60_000,
          maxEntries: config.social.discoveryCacheMaxEntries ?? 200,
        },
      });
      ctx.logger.info("Agent discovery initialized");
    } catch (err) {
      ctx.logger.warn?.("Agent discovery initialization failed:", err);
    }
  }

  // 2. AgentMessaging (needs wallet)
  if (keypair && agentId && config.social.messagingEnabled !== false) {
    try {
      const { AgentMessaging } = await import("../social/messaging.js");
      ctx.agentMessaging = new AgentMessaging({
        program,
        agentId,
        wallet: keypair,
        logger: ctx.logger,
        memoryBackend: ctx.memoryBackend ?? undefined,
        config: {
          defaultMode: config.social.messagingMode ?? "auto",
          offChainPort: config.social.messagingPort ?? 0,
        },
      });
      await ctx.agentMessaging.hydrateRecentMessages();
      if (config.social.messagingPort) {
        await ctx.agentMessaging.startListener(config.social.messagingPort);
      }
      if (ctx.handleIncomingSocialMessage) {
        ctx.agentMessagingUnsubscribe = ctx.agentMessaging.onMessage(
          (message) => {
            ctx.handleIncomingSocialMessage!(message);
          },
        );
      }
      ctx.logger.info("Agent messaging initialized");
    } catch (err) {
      ctx.logger.warn?.("Agent messaging initialization failed:", err);
    }
  }

  // 3. AgentFeed (needs wallet)
  if (keypair && agentId && config.social.feedEnabled !== false) {
    try {
      const { AgentFeed } = await import("../social/feed.js");
      ctx.agentFeed = new AgentFeed({
        program,
        agentId,
        wallet: keypair,
        config: { logger: ctx.logger },
      });
      ctx.logger.info("Agent feed initialized");
    } catch (err) {
      ctx.logger.warn?.("Agent feed initialization failed:", err);
    }
  }

  // 4. ReputationScorer (read-only)
  if (config.social.reputationEnabled !== false) {
    try {
      const { ReputationScorer } = await import("../social/reputation.js");
      ctx.reputationScorer = new ReputationScorer({
        program,
        logger: ctx.logger,
      });
      ctx.logger.info("Reputation scorer initialized");
    } catch (err) {
      ctx.logger.warn?.("Reputation scorer initialization failed:", err);
    }
  }

  // 5. CollaborationProtocol (needs all sub-components + wallet)
  if (
    config.social.collaborationEnabled !== false &&
    keypair &&
    agentId &&
    ctx.agentDiscovery &&
    ctx.agentMessaging &&
    ctx.agentFeed
  ) {
    try {
      const { CollaborationProtocol } =
        await import("../social/collaboration.js");
      const { TeamContractEngine } = await import("../team/engine.js");
      const teamEngine = new TeamContractEngine();
      ctx.collaborationProtocol = new CollaborationProtocol({
        program,
        agentId,
        wallet: keypair,
        feed: ctx.agentFeed,
        messaging: ctx.agentMessaging,
        discovery: ctx.agentDiscovery,
        teamEngine,
        config: { logger: ctx.logger },
      });
      ctx.logger.info("Collaboration protocol initialized");
    } catch (err) {
      ctx.logger.warn?.(
        "Collaboration protocol initialization failed:",
        err,
      );
    }
  }

  const wiredCount = [
    ctx.agentDiscovery,
    ctx.agentMessaging,
    ctx.agentFeed,
    ctx.reputationScorer,
    ctx.collaborationProtocol,
  ].filter(Boolean).length;
  ctx.logger.info(`Social module wired with ${wiredCount}/5 components`);
}
