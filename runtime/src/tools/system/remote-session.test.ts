import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { silentLogger } from "../../utils/logger.js";
import { runDurableHandleContractSuite } from "./handle-contract.test-utils.js";
import {
  createRemoteSessionTools,
  SystemRemoteSessionManager,
} from "./remote-session.js";

describe("system.remoteSession tools", () => {
  const cleanup: SystemRemoteSessionManager[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    while (cleanup.length > 0) {
      const manager = cleanup.pop()!;
      await manager.resetForTesting();
    }
  });

  function createManager(
    overrides?: Partial<ConstructorParameters<typeof SystemRemoteSessionManager>[0]>,
  ): SystemRemoteSessionManager {
    const rootDir = mkdtempSync(
      join(tmpdir(), "agenc-system-remote-session-test-"),
    );
    const manager = new SystemRemoteSessionManager({
      rootDir,
      logger: silentLogger,
      callbackBaseUrl: "http://127.0.0.1:3200",
      defaultPollTimeoutMs: 250,
      ...overrides,
    });
    cleanup.push(manager);
    return manager;
  }

  runDurableHandleContractSuite(() => {
    const manager = createManager();
    return {
      family: "system-remote-session",
      handleIdField: "sessionHandleId",
      runningState: "running",
      terminalState: "cancelled",
      resourceEnvelope: {
        cpu: 1,
        memoryMb: 128,
        wallClockMs: 60_000,
        network: "enabled",
        enforcement: "best_effort",
      },
      buildStartArgs: ({ label, idempotencyKey }) => ({
        serverName: "remote-session-server",
        remoteSessionId: "session-42",
        mode: "callback",
        label,
        idempotencyKey,
        messageUrl: "https://example.com/sessions/session-42/messages",
        resourceEnvelope: {
          cpu: 1,
          memoryMb: 128,
          wallClockMs: 60_000,
          network: "enabled",
        },
      }),
      buildStatusArgs: ({ label, idempotencyKey }) => ({
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      buildMissingStatusArgs: () => ({
        label: "missing-remote-session-handle",
      }),
      buildStopArgs: ({ handleId, label, idempotencyKey }) => ({
        ...(handleId ? { sessionHandleId: handleId } : {}),
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      start: async (args) =>
        JSON.parse((await manager.start(args)).content) as Record<string, unknown>,
      status: async (args) =>
        JSON.parse((await manager.status(args)).content) as Record<string, unknown>,
      stop: async (args) =>
        JSON.parse((await manager.stop(args)).content) as Record<string, unknown>,
    };
  });

  it("creates the six structured remote session tools", () => {
    const tools = createRemoteSessionTools({
      rootDir: "/tmp/ignored",
      logger: silentLogger,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.remoteSessionStart",
      "system.remoteSessionStatus",
      "system.remoteSessionResume",
      "system.remoteSessionSend",
      "system.remoteSessionStop",
      "system.remoteSessionEvents",
    ]);
  });

  it("accepts authenticated webhook callbacks and rejects replayed duplicates", async () => {
    const manager = createManager();
    const started = JSON.parse(
      (
        await manager.start({
          serverName: "remote-session-server",
          remoteSessionId: "session-99",
          mode: "callback",
          label: "remote-session-callback",
        })
      ).content,
    ) as Record<string, unknown>;
    const callback = started.callback as {
      authToken: string;
      path: string;
    };

    expect(callback.path).toBe(
      `/webhooks/remote-session/${started.sessionHandleId}`,
    );
    expect(typeof callback.authToken).toBe("string");
    expect(callback.authToken.length).toBeGreaterThan(20);

    const accepted = await manager.handleWebhook({
      sessionHandleId: String(started.sessionHandleId),
      headers: {
        authorization: `Bearer ${callback.authToken}`,
        "x-agenc-event-id": "evt-session-1",
      },
      body: {
        state: "completed",
        summary: "Remote session finished successfully.",
        artifacts: [
          { kind: "report", locator: "/tmp/session-report.json", label: "result" },
        ],
      },
    });
    expect(accepted.status).toBe(202);

    const duplicate = await manager.handleWebhook({
      sessionHandleId: String(started.sessionHandleId),
      headers: {
        authorization: `Bearer ${callback.authToken}`,
        "x-agenc-event-id": "evt-session-1",
      },
      body: {
        state: "completed",
        summary: "Remote session finished successfully.",
      },
    });
    expect(duplicate.status).toBe(202);
    expect(duplicate.body).toMatchObject({ duplicate: true });

    const status = JSON.parse(
      (
        await manager.status({
          sessionHandleId: String(started.sessionHandleId),
        })
      ).content,
    ) as Record<string, unknown>;
    expect(status.state).toBe("completed");
    expect(status.progressSummary).toBe("Remote session finished successfully.");

    const events = JSON.parse(
      (
        await manager.events({
          sessionHandleId: String(started.sessionHandleId),
        })
      ).content,
    ) as Record<string, unknown>;
    expect(events.artifacts).toEqual([
      expect.objectContaining({
        kind: "report",
        locator: "/tmp/session-report.json",
      }),
    ]);
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: "Remote session finished successfully.",
        }),
      ]),
    );
  });

  it("refreshes poll-mode handles from the configured status endpoint", async () => {
    const manager = createManager();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          state: "completed",
          summary: "Remote session polling confirmed completion.",
          events: [
            {
              id: "evt-poll-1",
              summary: "Viewer acknowledged completion.",
              kind: "status",
            },
          ],
          artifacts: [
            { kind: "report", locator: "https://example.com/session/result.json" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const started = JSON.parse(
      (
        await manager.start({
          serverName: "remote-session-server",
          remoteSessionId: "session-poll-1",
          mode: "poll",
          statusUrl: "https://example.com/sessions/session-poll-1",
          stopUrl: "https://example.com/sessions/session-poll-1/stop",
          stopMethod: "POST",
          messageUrl: "https://example.com/sessions/session-poll-1/messages",
          label: "remote-session-poll",
        })
      ).content,
    ) as Record<string, unknown>;

    const status = JSON.parse(
      (
        await manager.status({
          sessionHandleId: String(started.sessionHandleId),
        })
      ).content,
    ) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/sessions/session-poll-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(status.state).toBe("completed");
    expect(status.progressSummary).toBe(
      "Remote session polling confirmed completion.",
    );
    expect(status.lastStatusCode).toBe(200);
    expect(status.artifactCount).toBe(1);
  });

  it("sends remote session messages through the configured message endpoint", async () => {
    const manager = createManager();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          state: "running",
          summary: "Remote session accepted the follow-up.",
          viewerOnly: false,
          events: [
            {
              id: "evt-send-ack",
              summary: "Coordinator acknowledged the follow-up.",
              kind: "message",
            },
          ],
        }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const started = JSON.parse(
      (
        await manager.start({
          serverName: "remote-session-server",
          remoteSessionId: "session-send-1",
          mode: "callback",
          messageUrl: "https://example.com/sessions/session-send-1/messages",
          messageMethod: "PATCH",
          label: "remote-session-send",
        })
      ).content,
    ) as Record<string, unknown>;

    const sent = JSON.parse(
      (
        await manager.send({
          sessionHandleId: String(started.sessionHandleId),
          content: "Please continue with worker reuse.",
          metadata: { source: "test" },
        })
      ).content,
    ) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/sessions/session-send-1/messages",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          content: "Please continue with worker reuse.",
          metadata: { source: "test" },
          remoteSessionId: "session-send-1",
          sessionHandleId: String(started.sessionHandleId),
          serverName: "remote-session-server",
        }),
      }),
    );
    expect(sent.state).toBe("running");
    expect(sent.progressSummary).toBe("Remote session accepted the follow-up.");

    const events = JSON.parse(
      (
        await manager.events({
          sessionHandleId: String(started.sessionHandleId),
        })
      ).content,
    ) as Record<string, unknown>;
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "outbound",
          summary: "Please continue with worker reuse.",
        }),
        expect.objectContaining({
          summary: "Coordinator acknowledged the follow-up.",
        }),
      ]),
    );
  });

  it("rejects outbound messages for viewer-only sessions", async () => {
    const manager = createManager();
    const started = JSON.parse(
      (
        await manager.start({
          serverName: "remote-session-server",
          remoteSessionId: "session-viewer-only",
          mode: "callback",
          viewerOnly: true,
          messageUrl: "https://example.com/sessions/session-viewer-only/messages",
          label: "remote-session-viewer-only",
        })
      ).content,
    ) as Record<string, unknown>;

    const result = await manager.send({
      sessionHandleId: String(started.sessionHandleId),
      content: "This should fail.",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content) as {
      error?: { kind?: string; code?: string };
    };
    expect(parsed.error?.kind).toBe("permission_denied");
    expect(parsed.error?.code).toBe("system_remote_session.viewer_only");
  });

  it("blocks disallowed session URLs with a structured permission error", async () => {
    const manager = createManager({
      blockedDomains: ["evil.example"],
    });

    const result = await manager.start({
      serverName: "remote-session-server",
      remoteSessionId: "session-blocked-1",
      mode: "poll",
      statusUrl: "https://evil.example/sessions/session-blocked-1",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content) as {
      error?: { kind?: string; code?: string };
    };
    expect(parsed.error?.kind).toBe("permission_denied");
    expect(parsed.error?.code).toBe("system_remote_session.url_blocked");
  });
});
