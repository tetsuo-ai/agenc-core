import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMemoryBackend, createEmbeddingProvider } = vi.hoisted(() => ({
  createMemoryBackend: vi.fn(),
  createEmbeddingProvider: vi.fn(),
}));

vi.mock("../gateway/memory-backend-factory.js", () => ({
  createMemoryBackend,
}));

vi.mock("../memory/embeddings.js", () => ({
  createEmbeddingProvider,
}));

import { createChannelHostServices } from "./channel-host-services.js";

function makeBackend(label: string) {
  const store = new Map<string, unknown>();
  return {
    label,
    addEntry: vi.fn(),
    getThread: vi.fn().mockResolvedValue([]),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key)),
    listKeys: vi.fn(async (prefix = "") =>
      Array.from(store.keys()).filter((key) => key.startsWith(prefix)),
    ),
  };
}

describe("createChannelHostServices", () => {
  beforeEach(() => {
    createMemoryBackend.mockReset();
    createEmbeddingProvider.mockReset();
    createEmbeddingProvider.mockResolvedValue({
      name: "noop",
      dimension: 1536,
      embed: vi.fn(),
    });
    createMemoryBackend.mockImplementation(async ({ worldId }: { worldId?: string }) =>
      makeBackend(worldId ?? "global"),
    );
  });

  it("returns a world resolver and runtime defaults", async () => {
    const services = createChannelHostServices({
      config: {
        llm: {
          provider: "grok",
          apiKey: "test-key",
          model: "grok-4.20-beta-0309-reasoning",
          baseUrl: "https://api.x.ai/v1",
        },
        memory: { backend: "sqlite" },
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(services?.concordia_memory).toBeDefined();
    expect(services?.concordia_runtime?.llm).toEqual({
      provider: "grok",
      apiKey: "test-key",
      model: "grok-4.20-beta-0309-reasoning",
      baseUrl: "https://api.x.ai/v1",
    });
    expect(services?.concordia_runtime?.defaults).toEqual({
      provider: "grok",
      apiKey: "test-key",
      model: "grok-4-1-fast-non-reasoning",
      baseUrl: "https://api.x.ai/v1",
    });

    const world = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
    });
    expect(world?.memoryBackend).toBeDefined();
    expect(world?.identityManager).toBeDefined();
    expect(world?.socialMemory).toBeDefined();
    expect(world?.graph).toBeDefined();
    expect(world?.sharedMemory).toBeDefined();
    expect(world?.lifecycle).toBeDefined();
  });

  it("caches the same world context and isolates different worlds", async () => {
    const services = createChannelHostServices({
      config: {
        memory: { backend: "sqlite" },
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const worldOneA = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
    });
    const worldOneB = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
    });
    const worldTwo = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-2",
      workspaceId: "workspace-1",
    });

    expect(worldOneA).toBe(worldOneB);
    expect(worldOneA?.memoryBackend).not.toBe(worldTwo?.memoryBackend);
  });


  it("isolates same-world runs by effective storage key", async () => {
    const services = createChannelHostServices({
      config: {
        memory: { backend: "sqlite" },
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const simOne = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
      simulationId: "sim-1",
      effectiveStorageKey: "world:world-1::sim:sim-1",
      logStorageKey: "log:world-1::sim:sim-1",
      scopedWorkspaceId: "workspace-1::sim:sim-1",
    });
    const simTwo = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
      simulationId: "sim-2",
      effectiveStorageKey: "world:world-1::sim:sim-2",
      logStorageKey: "log:world-1::sim:sim-2",
      scopedWorkspaceId: "workspace-1::sim:sim-2",
    });

    expect(simOne?.memoryBackend).not.toBe(simTwo?.memoryBackend);
    expect(createMemoryBackend).toHaveBeenCalledWith(
      expect.objectContaining({ worldId: "world:world-1::sim:sim-1" }),
    );
    expect(createMemoryBackend).toHaveBeenCalledWith(
      expect.objectContaining({ worldId: "world:world-1::sim:sim-2" }),
    );
  });

  it("accepts typed checkpoint metadata for lineage resume contexts", async () => {
    const services = createChannelHostServices({
      config: {
        memory: { backend: "sqlite" },
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const resumed = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
      simulationId: "sim-2",
      lineageId: "lineage-1",
      parentSimulationId: "sim-1",
      effectiveStorageKey: "world:world-1::lineage:lineage-1",
      logStorageKey: "log:world-1::sim:sim-2",
      scopedWorkspaceId: "workspace-1::lineage:lineage-1",
      continuityMode: "lineage_resume",
      checkpointMetadata: {
        checkpointId: "sim-1:step:5",
        checkpointPath: "/tmp/checkpoints/sim-1_step_5.json",
        checkpointSchemaVersion: 3,
        checkpointSimulationId: "sim-1",
        checkpointLineageId: "lineage-1",
        resumedFromStep: 5,
        sceneCursor: {
          scene_index: 1,
          scene_round: 2,
          current_scene_name: "market",
        },
        runtimeCursor: {
          current_step: 5,
          start_step: 6,
          max_steps: 12,
          last_step_outcome: "resolved",
          engine_type: "simultaneous",
        },
        replayCursor: {
          replay_cursor: 42,
          replay_event_count: 42,
          last_event_id: "42",
        },
        worldStateRefs: {
          source: "inline_checkpoint",
          gm_state_key: "gm_state",
          entity_state_keys: ["alice", "bob"],
        },
        subsystemRestore: {
          resumed: ["gm_state", "entity_states", "scene_cursor"],
          reset: ["control_port", "event_port"],
        },
        checkpointStatus: {
          checkpoint_id: "sim-1:step:5",
          checkpoint_path: "/tmp/checkpoints/sim-1_step_5.json",
          schema_version: 3,
          world_id: "world-1",
          workspace_id: "workspace-1",
          simulation_id: "sim-1",
          lineage_id: "lineage-1",
          parent_simulation_id: null,
          step: 5,
          timestamp: 123,
          max_steps: 12,
          scene_cursor: {
            scene_index: 1,
            scene_round: 2,
            current_scene_name: "market",
          },
          runtime_cursor: {
            current_step: 5,
            start_step: 6,
            max_steps: 12,
            last_step_outcome: "resolved",
            engine_type: "simultaneous",
          },
          replay_cursor: {
            replay_cursor: 42,
            replay_event_count: 42,
            last_event_id: "42",
          },
          world_state_refs: {
            source: "inline_checkpoint",
            gm_state_key: "gm_state",
            entity_state_keys: ["alice", "bob"],
          },
          subsystem_state: {
            resumed: ["gm_state", "entity_states", "scene_cursor"],
            reset: ["control_port", "event_port"],
          },
        },
      },
    });

    expect(resumed?.memoryBackend).toBeDefined();
    expect(createMemoryBackend).toHaveBeenCalledWith(
      expect.objectContaining({ worldId: "world:world-1::lineage:lineage-1" }),
    );
  });

  it("separates per-simulation log contexts even when lineage storage is shared", async () => {
    const services = createChannelHostServices({
      config: {
        memory: { backend: "sqlite" },
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const resumedA = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
      simulationId: "sim-2",
      lineageId: "lineage-1",
      parentSimulationId: "sim-1",
      effectiveStorageKey: "world:world-1::lineage:lineage-1",
      logStorageKey: "log:world-1::sim:sim-2",
      scopedWorkspaceId: "workspace-1::lineage:lineage-1",
    });
    const resumedB = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
      simulationId: "sim-3",
      lineageId: "lineage-1",
      parentSimulationId: "sim-2",
      effectiveStorageKey: "world:world-1::lineage:lineage-1",
      logStorageKey: "log:world-1::sim:sim-3",
      scopedWorkspaceId: "workspace-1::lineage:lineage-1",
    });

    expect(resumedA).not.toBe(resumedB);
    expect(resumedA?.memoryBackend).not.toBeUndefined();
    expect(resumedB?.memoryBackend).not.toBeUndefined();
    expect(resumedA?.dailyLogManager).not.toBe(resumedB?.dailyLogManager);
  });

});
