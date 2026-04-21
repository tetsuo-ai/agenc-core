import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  axiosGet: vi.fn(),
  axiosPatch: vi.fn(),
  axiosIsAxiosError: vi.fn(),
  getClaudeAIOAuthTokens: vi.fn(),
  getOrganizationUUID: vi.fn(),
  getOauthConfig: vi.fn(),
  getOAuthHeaders: vi.fn(),
  parseGitRemote: vi.fn(),
  parseGitHubRepository: vi.fn(),
  getDefaultBranch: vi.fn(),
  getMainLoopModel: vi.fn(),
  logForDebugging: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: mocks.axiosPost,
    get: mocks.axiosGet,
    patch: mocks.axiosPatch,
    isAxiosError: mocks.axiosIsAxiosError,
  },
}));

vi.mock("../utils/auth.js", () => ({
  getClaudeAIOAuthTokens: mocks.getClaudeAIOAuthTokens,
}));

vi.mock("../services/oauth/client.js", () => ({
  getOrganizationUUID: mocks.getOrganizationUUID,
}));

vi.mock("../constants/oauth.js", () => ({
  getOauthConfig: mocks.getOauthConfig,
}));

vi.mock("../utils/teleport/api.js", () => ({
  getOAuthHeaders: mocks.getOAuthHeaders,
}));

vi.mock("../utils/detectRepository.js", () => ({
  parseGitRemote: mocks.parseGitRemote,
  parseGitHubRepository: mocks.parseGitHubRepository,
}));

vi.mock("../utils/git.js", () => ({
  getDefaultBranch: mocks.getDefaultBranch,
}));

vi.mock("../utils/model/model.js", () => ({
  getMainLoopModel: mocks.getMainLoopModel,
}));

vi.mock("../utils/debug.js", () => ({
  logForDebugging: mocks.logForDebugging,
}));

import {
  archiveBridgeSession,
  createBridgeSession,
  getBridgeSession,
  updateBridgeSessionTitle,
} from "./createSession.js";
import {
  setCseShimGate,
  toCompatSessionId,
  toInfraSessionId,
} from "./sessionIdCompat.js";

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeEvents(): Parameters<typeof createBridgeSession>[0]["events"] {
  return [{ type: "event", data: { role: "user", content: "hello" } as never }];
}

describe("bridge session compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.axiosIsAxiosError.mockImplementation(
      (err: unknown) => !!(err && typeof err === "object" && "isAxiosError" in err),
    );
    mocks.getClaudeAIOAuthTokens.mockReturnValue({ accessToken: "token-123" });
    mocks.getOrganizationUUID.mockResolvedValue("org-123");
    mocks.getOauthConfig.mockReturnValue({
      BASE_API_URL: "https://api.example.test",
    });
    mocks.getOAuthHeaders.mockImplementation((token: string) => ({
      Authorization: `Bearer ${token}`,
    }));
    mocks.parseGitRemote.mockReturnValue({
      host: "github.com",
      owner: "acme",
      name: "widget",
    });
    mocks.parseGitHubRepository.mockReturnValue(null);
    mocks.getDefaultBranch.mockResolvedValue("main");
    mocks.getMainLoopModel.mockReturnValue("claude-test-model");
    setCseShimGate(() => true);
  });

  describe("sessionIdCompat", () => {
    it("retags cse_* IDs to session_* by default and back to infra form", () => {
      expect(toCompatSessionId("cse_abc123")).toBe("session_abc123");
      expect(toCompatSessionId("session_abc123")).toBe("session_abc123");
      expect(toInfraSessionId("session_abc123")).toBe("cse_abc123");
      expect(toInfraSessionId("cse_abc123")).toBe("cse_abc123");
    });

    it("keeps cse_* IDs untouched when the shim gate is disabled", () => {
      setCseShimGate(() => false);
      expect(toCompatSessionId("cse_abc123")).toBe("cse_abc123");
    });
  });

  describe("createBridgeSession", () => {
    it("returns null without an access token and never touches the sessions API", async () => {
      mocks.getClaudeAIOAuthTokens.mockReturnValue(undefined);

      const result = await createBridgeSession({
        environmentId: "env-1",
        events: makeEvents(),
        gitRepoUrl: null,
        branch: "feat-bridge",
        signal: makeSignal(),
      });

      expect(result).toBeNull();
      expect(mocks.axiosPost).not.toHaveBeenCalled();
    });

    it("posts the current bridge create-session contract and returns the created session ID", async () => {
      mocks.axiosPost.mockResolvedValueOnce({
        status: 201,
        data: { id: "session_created" },
      });
      const signal = makeSignal();
      const events = makeEvents();

      const result = await createBridgeSession({
        environmentId: "env-1",
        title: "Bridge Session",
        events,
        gitRepoUrl: "git@github.com:acme/widget.git",
        branch: "feat-bridge",
        signal,
        baseUrl: "https://override.example.test",
        permissionMode: "acceptEdits",
      });

      expect(result).toBe("session_created");
      expect(mocks.axiosPost).toHaveBeenCalledOnce();
      expect(mocks.axiosPost).toHaveBeenCalledWith(
        "https://override.example.test/v1/sessions",
        {
          title: "Bridge Session",
          events,
          session_context: {
            sources: [
              {
                type: "git_repository",
                url: "https://github.com/acme/widget",
                revision: "feat-bridge",
              },
            ],
            outcomes: [
              {
                type: "git_repository",
                git_info: {
                  type: "github",
                  repo: "acme/widget",
                  branches: ["claude/feat-bridge"],
                },
              },
            ],
            model: "claude-test-model",
          },
          environment_id: "env-1",
          source: "remote-control",
          permission_mode: "acceptEdits",
        },
        {
          headers: {
            Authorization: "Bearer token-123",
            "anthropic-beta": "ccr-byoc-2025-07-29",
            "x-organization-uuid": "org-123",
          },
          signal,
          validateStatus: expect.any(Function),
        },
      );
      const validateStatus = mocks.axiosPost.mock.calls[0]?.[2]?.validateStatus;
      expect(validateStatus?.(499)).toBe(true);
      expect(validateStatus?.(500)).toBe(false);
    });

    it("falls back to owner/repo parsing and the default branch when no full git remote parses", async () => {
      mocks.parseGitRemote.mockReturnValue(null);
      mocks.parseGitHubRepository.mockReturnValue("fallback/repo");
      mocks.axiosPost.mockResolvedValueOnce({
        status: 200,
        data: { id: "session_from_fallback" },
      });

      await createBridgeSession({
        environmentId: "env-2",
        events: makeEvents(),
        gitRepoUrl: "fallback/repo",
        branch: "",
        signal: makeSignal(),
      });

      expect(mocks.getDefaultBranch).toHaveBeenCalledOnce();
      expect(mocks.axiosPost.mock.calls[0]?.[1]).toMatchObject({
        session_context: {
          sources: [
            {
              type: "git_repository",
              url: "https://github.com/fallback/repo",
              revision: "main",
            },
          ],
          outcomes: [
            {
              type: "git_repository",
              git_info: {
                type: "github",
                repo: "fallback/repo",
                branches: ["claude/task"],
              },
            },
          ],
        },
      });
    });
  });

  describe("getBridgeSession", () => {
    it("fetches resumable session metadata with the org-scoped sessions headers", async () => {
      mocks.axiosGet.mockResolvedValueOnce({
        status: 200,
        data: { environment_id: "env-9", title: "Resume Me" },
      });

      const result = await getBridgeSession("session_resume");

      expect(result).toEqual({ environment_id: "env-9", title: "Resume Me" });
      expect(mocks.axiosGet).toHaveBeenCalledWith(
        "https://api.example.test/v1/sessions/session_resume",
        {
          headers: {
            Authorization: "Bearer token-123",
            "anthropic-beta": "ccr-byoc-2025-07-29",
            "x-organization-uuid": "org-123",
          },
          timeout: 10_000,
          validateStatus: expect.any(Function),
        },
      );
    });
  });

  describe("archiveBridgeSession", () => {
    it("posts the archive endpoint with the caller-provided timeout", async () => {
      mocks.axiosPost.mockResolvedValueOnce({ status: 200, data: {} });

      await archiveBridgeSession("session_archive", {
        timeoutMs: 4_321,
      });

      expect(mocks.axiosPost).toHaveBeenCalledWith(
        "https://api.example.test/v1/sessions/session_archive/archive",
        {},
        {
          headers: {
            Authorization: "Bearer token-123",
            "anthropic-beta": "ccr-byoc-2025-07-29",
            "x-organization-uuid": "org-123",
          },
          timeout: 4_321,
          validateStatus: expect.any(Function),
        },
      );
    });
  });

  describe("updateBridgeSessionTitle", () => {
    it("retags cse_* IDs to session_* for title sync and swallows patch failures", async () => {
      mocks.axiosPatch.mockRejectedValueOnce(new Error("timeout"));

      await expect(
        updateBridgeSessionTitle("cse_title", "Renamed Session"),
      ).resolves.toBeUndefined();

      expect(mocks.axiosPatch).toHaveBeenCalledWith(
        "https://api.example.test/v1/sessions/session_title",
        { title: "Renamed Session" },
        {
          headers: {
            Authorization: "Bearer token-123",
            "anthropic-beta": "ccr-byoc-2025-07-29",
            "x-organization-uuid": "org-123",
          },
          timeout: 10_000,
          validateStatus: expect.any(Function),
        },
      );
    });
  });
});
