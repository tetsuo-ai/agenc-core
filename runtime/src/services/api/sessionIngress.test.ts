import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  axiosPut: vi.fn(),
  axiosGet: vi.fn(),
  getOauthConfig: vi.fn(),
  getSessionIngressAuthHeaders: vi.fn(),
  logForDebugging: vi.fn(),
  logForDiagnosticsNoPII: vi.fn(),
  logError: vi.fn(),
  sleep: vi.fn(async () => {}),
}));

vi.mock("axios", () => ({
  default: {
    put: mocks.axiosPut,
    get: mocks.axiosGet,
  },
}));

vi.mock("../../constants/oauth.js", () => ({
  getOauthConfig: mocks.getOauthConfig,
}));

vi.mock("../../utils/sessionIngressAuth.js", () => ({
  getSessionIngressAuthHeaders: mocks.getSessionIngressAuthHeaders,
}));

vi.mock("../../utils/debug.js", () => ({
  logForDebugging: mocks.logForDebugging,
}));

vi.mock("../../utils/diagLogs.js", () => ({
  logForDiagnosticsNoPII: mocks.logForDiagnosticsNoPII,
}));

vi.mock("../../utils/log.js", () => ({
  logError: mocks.logError,
}));

vi.mock("../../utils/sleep.js", () => ({
  sleep: mocks.sleep,
}));

import {
  appendSessionLog,
  clearAllSessions,
  clearSession,
  getSessionLogs,
  getTeleportEvents,
} from "./sessionIngress.js";

describe("sessionIngress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllSessions();
    mocks.getOauthConfig.mockReturnValue({
      BASE_API_URL: "https://api.example.test",
    });
    mocks.getSessionIngressAuthHeaders.mockReturnValue({
      Cookie: "sessionKey=sk-ant-sid-test",
      "X-Organization-Uuid": "org-123",
    });
  });

  it("uses session-ingress auth headers for append and reuses last uuid after hydration", async () => {
    mocks.axiosGet.mockResolvedValueOnce({
      status: 200,
      data: {
        loglines: [{ uuid: "u-1" }, { uuid: "u-2" }],
      },
    });
    await expect(
      getSessionLogs(
        "session-1",
        "https://example.test/v1/session_ingress/session/session-1",
      ),
    ).resolves.toEqual([{ uuid: "u-1" }, { uuid: "u-2" }]);

    mocks.axiosPut.mockResolvedValueOnce({
      status: 200,
      headers: {},
      statusText: "OK",
    });
    await expect(
      appendSessionLog(
        "session-1",
        { uuid: "u-3", type: "assistant" } as never,
        "https://example.test/v1/session_ingress/session/session-1",
      ),
    ).resolves.toBe(true);

    expect(mocks.axiosPut).toHaveBeenCalledWith(
      "https://example.test/v1/session_ingress/session/session-1",
      expect.objectContaining({ uuid: "u-3" }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: "sessionKey=sk-ant-sid-test",
          "X-Organization-Uuid": "org-123",
          "Content-Type": "application/json",
          "Last-Uuid": "u-2",
        }),
      }),
    );
  });

  it("drops the cached last uuid when the session cache is cleared", async () => {
    mocks.axiosGet.mockResolvedValueOnce({
      status: 200,
      data: {
        loglines: [{ uuid: "u-1" }],
      },
    });
    await getSessionLogs(
      "session-2",
      "https://example.test/v1/session_ingress/session/session-2",
    );

    clearSession("session-2");

    mocks.axiosPut.mockResolvedValueOnce({
      status: 201,
      headers: {},
      statusText: "Created",
    });
    await appendSessionLog(
      "session-2",
      { uuid: "u-2", type: "assistant" } as never,
      "https://example.test/v1/session_ingress/session/session-2",
    );

    expect(mocks.axiosPut).toHaveBeenCalledWith(
      "https://example.test/v1/session_ingress/session/session-2",
      expect.anything(),
      expect.objectContaining({
        headers: expect.not.objectContaining({
          "Last-Uuid": expect.any(String),
        }),
      }),
    );
  });

  it("paginates teleport events and returns payload entries only", async () => {
    mocks.axiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: {
          data: [
            {
              event_id: "e-1",
              event_type: "transcript",
              is_compaction: false,
              payload: { uuid: "u-1", type: "user" },
              created_at: "2026-04-21T00:00:00.000Z",
            },
          ],
          next_cursor: "cursor-2",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          data: [
            {
              event_id: "e-2",
              event_type: "transcript",
              is_compaction: false,
              payload: null,
              created_at: "2026-04-21T00:00:01.000Z",
            },
            {
              event_id: "e-3",
              event_type: "transcript",
              is_compaction: false,
              payload: { uuid: "u-2", type: "assistant" },
              created_at: "2026-04-21T00:00:02.000Z",
            },
          ],
        },
      });

    await expect(
      getTeleportEvents("session-teleport", "oauth-token", "org-123"),
    ).resolves.toEqual([
      { uuid: "u-1", type: "user" },
      { uuid: "u-2", type: "assistant" },
    ]);

    expect(mocks.axiosGet).toHaveBeenNthCalledWith(
      1,
      "https://api.example.test/v1/code/sessions/session-teleport/teleport-events",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer oauth-token",
          "x-organization-uuid": "org-123",
        },
        params: { limit: 1000 },
      }),
    );
    expect(mocks.axiosGet).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/v1/code/sessions/session-teleport/teleport-events",
      expect.objectContaining({
        params: { limit: 1000, cursor: "cursor-2" },
      }),
    );
  });
});
