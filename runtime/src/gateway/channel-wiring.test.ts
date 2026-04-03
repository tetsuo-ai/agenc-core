import { describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "./types.js";
import { wireExternalChannel, wireExternalChannels } from "./channel-wiring.js";
import type { ChannelContext, ChannelPlugin } from "./channel.js";
import type { GatewayMessage, OutboundMessage } from "./message.js";
import { silentLogger } from "../utils/logger.js";

function makeConfig(): GatewayConfig {
  return {
    gateway: { port: 8080 },
    agent: { name: "Fixture" },
    llm: { provider: "grok" },
    plugins: {
      trustedPackages: [
        {
          packageName: "@tetsuo-ai/plugin-kit-channel-fixture",
          allowedSubpaths: ["mock"],
        },
      ],
    },
    channels: {
      "fixture-chat": {
        type: "plugin",
        moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
        config: {
          token: "abc",
        },
      },
    },
  };
}

describe("wireExternalChannels", () => {
  it("loads trusted plugin-backed channel adapters into the unified registry", async () => {
    const registry = await wireExternalChannels(makeConfig(), {
      gateway: null,
      logger: silentLogger,
      chatExecutor: null,
      memoryBackend: null,
      defaultForegroundMaxToolRounds: 1,
      buildChannelHostServices() {
        return undefined;
      },
      async buildSystemPrompt() {
        return "system prompt";
      },
      async handleTextChannelApprovalCommand() {
        return false;
      },
      registerTextApprovalDispatcher() {
        return () => {};
      },
      createTextChannelSessionToolHandler() {
        throw new Error("should not be called during channel bootstrap");
      },
      buildToolRoutingDecision() {
        return undefined;
      },
      recordToolRoutingOutcome() {
        return;
      },
    });

    const plugin = registry.get("fixture-chat");
    expect(plugin?.name).toBe("fixture-chat");
    expect(plugin?.isHealthy()).toBe(true);

    await plugin?.stop();
  });

  it("ingests observation-only plugin messages without invoking the chat executor", async () => {
    class FixtureChannel implements ChannelPlugin {
      readonly name = "fixture-chat";
      context: ChannelContext | null = null;
      sent: OutboundMessage[] = [];

      async initialize(context: ChannelContext): Promise<void> {
        this.context = context;
      }

      async start(): Promise<void> {
        return;
      }

      async stop(): Promise<void> {
        return;
      }

      async send(message: OutboundMessage): Promise<void> {
        this.sent.push(message);
      }

      isHealthy(): boolean {
        return this.context !== null;
      }

      async emit(message: GatewayMessage): Promise<void> {
        await this.context?.onMessage(message);
      }
    }

    const channel = new FixtureChannel();
    let capturedHistory: Array<{ role: string; content: string }> | undefined;
    const execute = vi.fn().mockImplementation(async (input: {
      history?: Array<{ role: string; content: string }>;
    }) => {
      capturedHistory = input.history?.map((entry) => ({ ...entry }));
      return {
      content: "acknowledged",
      provider: "grok",
      model: "grok-4.20-beta-0309-reasoning",
      usedFallback: false,
      durationMs: 5,
      compacted: false,
      tokenUsage: undefined,
      callUsage: [],
      statefulSummary: undefined,
      plannerSummary: undefined,
      toolRoutingSummary: undefined,
      stopReason: "completed",
      stopReasonDetail: undefined,
      toolCalls: [],
      };
    });

    await wireExternalChannel(
      channel,
      "fixture-chat",
      makeConfig(),
      { token: "abc" },
      {
        gateway: null,
        logger: silentLogger,
        chatExecutor: { execute } as never,
        memoryBackend: null,
        defaultForegroundMaxToolRounds: 1,
        buildChannelHostServices() {
          return undefined;
        },
        async buildSystemPrompt() {
          return "system prompt";
        },
        async handleTextChannelApprovalCommand() {
          return false;
        },
        registerTextApprovalDispatcher() {
          return () => {};
        },
        createTextChannelSessionToolHandler() {
          return vi.fn() as never;
        },
        buildToolRoutingDecision() {
          return undefined;
        },
        recordToolRoutingOutcome() {
          return;
        },
      },
    );

    await channel.emit({
      id: "msg-1",
      channel: "fixture-chat",
      senderId: "alice",
      senderName: "Alice",
      sessionId: "fixture:alice",
      content: "[Observation] A vendor lowers his asking price.",
      scope: "dm",
      metadata: { ingest_only: true },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);

    await channel.emit({
      id: "msg-2",
      channel: "fixture-chat",
      senderId: "alice",
      senderName: "Alice",
      sessionId: "fixture:alice",
      content: "Respond exactly with ONLY your action text.",
      scope: "dm",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(capturedHistory).toEqual([
      {
        role: "user",
        content: "[Observation] A vendor lowers his asking price.",
      },
    ]);
    expect(channel.sent).toEqual([
      { sessionId: "fixture:alice", content: "acknowledged" },
    ]);
  });

  it("isolates Concordia history by world metadata and skips daemon memory persistence", async () => {
    class FixtureChannel implements ChannelPlugin {
      readonly name = "concordia";
      context: ChannelContext | null = null;
      sent: OutboundMessage[] = [];

      async initialize(context: ChannelContext): Promise<void> {
        this.context = context;
      }

      async start(): Promise<void> {
        return;
      }

      async stop(): Promise<void> {
        return;
      }

      async send(message: OutboundMessage): Promise<void> {
        this.sent.push(message);
      }

      isHealthy(): boolean {
        return this.context !== null;
      }

      async emit(message: GatewayMessage): Promise<void> {
        await this.context?.onMessage(message);
      }
    }

    const channel = new FixtureChannel();
    const capturedHistories: Array<Array<{ role: string; content: string }>> = [];
    const execute = vi.fn().mockImplementation(async (input: {
      history?: Array<{ role: string; content: string }>;
    }) => {
      capturedHistories.push(
        input.history?.map((entry) => ({ ...entry })) ?? [],
      );
      return {
        content: "ack",
        provider: "grok",
        model: "grok-4-1-fast-non-reasoning",
        usedFallback: false,
        durationMs: 5,
        compacted: false,
        tokenUsage: undefined,
        callUsage: [],
        statefulSummary: undefined,
        plannerSummary: undefined,
        toolRoutingSummary: undefined,
        stopReason: "completed",
        stopReasonDetail: undefined,
        toolCalls: [],
      };
    });
    const addEntry = vi.fn().mockResolvedValue(undefined);

    await wireExternalChannel(
      channel,
      "concordia",
      makeConfig(),
      { token: "abc" },
      {
        gateway: null,
        logger: silentLogger,
        chatExecutor: { execute } as never,
        memoryBackend: { addEntry } as never,
        defaultForegroundMaxToolRounds: 1,
        buildChannelHostServices() {
          return undefined;
        },
        async buildSystemPrompt() {
          return "system prompt";
        },
        async handleTextChannelApprovalCommand() {
          return false;
        },
        registerTextApprovalDispatcher() {
          return () => {};
        },
        createTextChannelSessionToolHandler() {
          return vi.fn() as never;
        },
        buildToolRoutingDecision() {
          return undefined;
        },
        recordToolRoutingOutcome() {
          return;
        },
      },
    );

    await channel.emit({
      id: "obs-world-1",
      channel: "concordia",
      senderId: "alex",
      senderName: "Alex",
      sessionId: "concordia:world-1:alex",
      content: "[Observation] World 1 only",
      scope: "dm",
      metadata: {
        ingest_only: true,
        history_role: "system",
        workspace_id: "concordia-sim",
        world_id: "world-1",
        agent_id: "alex",
      },
    });

    await channel.emit({
      id: "act-world-1",
      channel: "concordia",
      senderId: "alex",
      senderName: "Alex",
      sessionId: "concordia:world-1:alex",
      content: "Take your next action in world 1.",
      scope: "dm",
      metadata: {
        turn_contract: "concordia_simulation_turn",
        request_id: "req-world-1",
        workspace_id: "concordia-sim",
        world_id: "world-1",
        agent_id: "alex",
      },
    });

    await channel.emit({
      id: "act-world-2",
      channel: "concordia",
      senderId: "alex",
      senderName: "Alex",
      sessionId: "concordia:world-2:alex",
      content: "Take your next action in world 2.",
      scope: "dm",
      metadata: {
        turn_contract: "concordia_simulation_turn",
        request_id: "req-world-2",
        workspace_id: "concordia-sim",
        world_id: "world-2",
        agent_id: "alex",
      },
    });

    expect(capturedHistories).toEqual([
      [{ role: "system", content: "[Observation] World 1 only" }],
      [],
    ]);
    expect(channel.sent.map((message) => message.metadata?.request_id)).toEqual([
      "req-world-1",
      "req-world-2",
    ]);
    expect(addEntry).not.toHaveBeenCalled();
  });

  it("rejects actionable Concordia messages that lack request correlation", async () => {
    class FixtureChannel implements ChannelPlugin {
      readonly name = "concordia";
      context: ChannelContext | null = null;
      sent: OutboundMessage[] = [];

      async initialize(context: ChannelContext): Promise<void> {
        this.context = context;
      }

      async start(): Promise<void> {
        return;
      }

      async stop(): Promise<void> {
        return;
      }

      async send(message: OutboundMessage): Promise<void> {
        this.sent.push(message);
      }

      isHealthy(): boolean {
        return this.context !== null;
      }

      async emit(message: GatewayMessage): Promise<void> {
        await this.context?.onMessage(message);
      }
    }

    const channel = new FixtureChannel();

    await wireExternalChannel(
      channel,
      "concordia",
      makeConfig(),
      { token: "abc" },
      {
        gateway: null,
        logger: silentLogger,
        chatExecutor: { execute: vi.fn() } as never,
        memoryBackend: null,
        defaultForegroundMaxToolRounds: 1,
        buildChannelHostServices() {
          return undefined;
        },
        async buildSystemPrompt() {
          return "system prompt";
        },
        async handleTextChannelApprovalCommand() {
          return false;
        },
        registerTextApprovalDispatcher() {
          return () => {};
        },
        createTextChannelSessionToolHandler() {
          return vi.fn() as never;
        },
        buildToolRoutingDecision() {
          return undefined;
        },
        recordToolRoutingOutcome() {
          return;
        },
      },
    );

    await expect(
      channel.emit({
        id: "act-missing-request",
        channel: "concordia",
        senderId: "alex",
        senderName: "Alex",
        sessionId: "concordia:world-1:alex",
        content: "Take your next action.",
        scope: "dm",
        metadata: {
          turn_contract: "concordia_simulation_turn",
          workspace_id: "concordia-sim",
          world_id: "world-1",
          agent_id: "alex",
        },
      }),
    ).rejects.toThrow("Concordia turn missing request_id metadata");
  });
});
