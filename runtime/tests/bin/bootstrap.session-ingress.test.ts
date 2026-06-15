import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessionStorageMocks = vi.hoisted(() => ({
  setInternalEventReader: vi.fn(),
  setInternalEventWriter: vi.fn(),
  setRemoteIngressUrl: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  getSessionIngressAuthHeaders: vi.fn(),
}));

vi.mock("./_deps/session-storage.js", () => ({
  loadTranscriptFile: vi.fn(async () => {
    const err = new Error("ENOENT");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  }),
  setInternalEventReader: sessionStorageMocks.setInternalEventReader,
  setInternalEventWriter: sessionStorageMocks.setInternalEventWriter,
  setRemoteIngressUrl: sessionStorageMocks.setRemoteIngressUrl,
}));

vi.mock("./_deps/session-ingress-auth.js", () => ({
  getSessionIngressAuthHeaders: authMocks.getSessionIngressAuthHeaders,
}));

import { bootstrapLocalRuntimeSession } from "./bootstrap.js";
import { fetchStartupInternalEvents } from "./startup-internal-events.js";
import { Session } from "../session/session.js";

type InternalEventReader = () => Promise<
  Array<{ payload: Record<string, unknown>; agent_id?: string }> | null
>;

type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>;

describe("bootstrapLocalRuntimeSession session-ingress startup wiring", () => {
  let home = "";
  let workspace = "";
  let fetchMock: ReturnType<typeof vi.fn>;
  let foregroundReader: InternalEventReader | undefined;
  let subagentReader: InternalEventReader | undefined;
  let internalWriter: InternalEventWriter | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    foregroundReader = undefined;
    subagentReader = undefined;
    internalWriter = undefined;

    sessionStorageMocks.setInternalEventReader.mockImplementation(
      (reader: InternalEventReader, subReader: InternalEventReader) => {
        foregroundReader = reader;
        subagentReader = subReader;
      },
    );
    sessionStorageMocks.setInternalEventWriter.mockImplementation(
      (writer: InternalEventWriter) => {
        internalWriter = writer;
      },
    );
    authMocks.getSessionIngressAuthHeaders.mockReturnValue({
      Authorization: "Bearer worker-jwt",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("registers remote ingress plus CCR v2 reader and writer hooks during startup", async () => {
    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "cse_session_123",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          SESSION_INGRESS_URL: "https://api.example.test",
          AGENC_USE_CCR_V2: "1",
          AGENC_WORKER_EPOCH: "42",
          AGENC_SESSION_ACCESS_TOKEN: "worker-jwt",
        },
      });
      shutdown = boot.shutdown;

      expect(sessionStorageMocks.setRemoteIngressUrl).toHaveBeenCalledWith(
        "https://api.example.test/v1/session_ingress/session/cse_session_123",
      );
      expect(sessionStorageMocks.setInternalEventReader).toHaveBeenCalledTimes(1);
      expect(sessionStorageMocks.setInternalEventWriter).toHaveBeenCalledTimes(1);
      expect(foregroundReader).toBeTypeOf("function");
      expect(subagentReader).toBeTypeOf("function");
      expect(internalWriter).toBeTypeOf("function");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
    }
  });

  it("uses the registered CCR v2 hooks against worker internal-event endpoints", async () => {
    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              payload: { uuid: "fg-1", type: "assistant" },
            },
          ],
          next_cursor: "cursor-2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              payload: { uuid: "fg-2", type: "user" },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              payload: { uuid: "sub-1", type: "assistant" },
              agent_id: "agent-1",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "cse_session_123",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          SESSION_INGRESS_URL: "https://api.example.test",
          AGENC_USE_CCR_V2: "1",
          AGENC_WORKER_EPOCH: "42",
          AGENC_SESSION_ACCESS_TOKEN: "worker-jwt",
        },
      });
      shutdown = boot.shutdown;

      await expect(foregroundReader?.()).resolves.toEqual([
        { payload: { uuid: "fg-1", type: "assistant" } },
        { payload: { uuid: "fg-2", type: "user" } },
      ]);
      await expect(subagentReader?.()).resolves.toEqual([
        {
          payload: { uuid: "sub-1", type: "assistant" },
          agent_id: "agent-1",
        },
      ]);

      await internalWriter?.(
        "transcript",
        {
          uuid: "msg-1",
          type: "assistant",
          message: "hello",
        },
        {
          isCompaction: true,
          agentId: "agent-1",
        },
      );

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          href: "https://api.example.test/v1/code/sessions/cse_session_123/worker/internal-events",
        }),
        expect.objectContaining({
          headers: {
            Authorization: "Bearer worker-jwt",
          },
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          href: "https://api.example.test/v1/code/sessions/cse_session_123/worker/internal-events?cursor=cursor-2",
        }),
        expect.any(Object),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          href: "https://api.example.test/v1/code/sessions/cse_session_123/worker/internal-events?subagents=true",
        }),
        expect.any(Object),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        4,
        "https://api.example.test/v1/code/sessions/cse_session_123/worker/internal-events",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer worker-jwt",
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          }),
        }),
      );

      const postBody = JSON.parse(
        fetchMock.mock.calls[3]?.[1]?.body as string,
      ) as {
        worker_epoch: number;
        events: Array<{
          payload: Record<string, unknown>;
          is_compaction?: boolean;
          agent_id?: string;
        }>;
      };
      expect(postBody.worker_epoch).toBe(42);
      expect(postBody.events).toEqual([
        {
          payload: {
            uuid: "msg-1",
            type: "assistant",
            message: "hello",
          },
          is_compaction: true,
          agent_id: "agent-1",
        },
      ]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
    }
  });

  it("returns null instead of throwing for malformed successful internal-event JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });

    await expect(
      fetchStartupInternalEvents({
        sessionBaseUrl: "https://api.example.test/v1/code/sessions/cse_session_123",
        headers: { Authorization: "Bearer worker-jwt" },
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null for malformed internal-event page envelopes", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { payload: { uuid: "not-an-array" } },
      }),
    });

    await expect(
      fetchStartupInternalEvents({
        sessionBaseUrl: "https://api.example.test/v1/code/sessions/cse_session_123",
        headers: { Authorization: "Bearer worker-jwt" },
      }),
    ).resolves.toBeNull();
  });

  it("returns null when internal-event pagination repeats a cursor", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ payload: { uuid: "first", type: "assistant" } }],
          next_cursor: "cursor-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ payload: { uuid: "second", type: "assistant" } }],
          next_cursor: "cursor-1",
        }),
      });

    await expect(
      fetchStartupInternalEvents({
        sessionBaseUrl: "https://api.example.test/v1/code/sessions/cse_session_123",
        headers: { Authorization: "Bearer worker-jwt" },
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not install a fake CCR v2 writer when the worker epoch is missing", async () => {
    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "cse_session_123",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          SESSION_INGRESS_URL: "https://api.example.test",
          AGENC_USE_CCR_V2: "1",
          AGENC_SESSION_ACCESS_TOKEN: "worker-jwt",
        },
      });
      shutdown = boot.shutdown;

      expect(sessionStorageMocks.setRemoteIngressUrl).toHaveBeenCalledTimes(1);
      expect(sessionStorageMocks.setInternalEventReader).toHaveBeenCalledTimes(1);
      expect(sessionStorageMocks.setInternalEventWriter).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
    }
  });
});
