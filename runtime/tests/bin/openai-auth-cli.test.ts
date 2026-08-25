import { describe, expect, it, vi } from "vitest";
import {
  formatOpenAiAuthCliHelpText,
  parseOpenAiAuthCliArgs,
  runOpenAiAuthCli,
  type OpenAiAuthCliDeps,
  type OpenAiAuthCliIo,
} from "./openai-auth-cli.js";
import type { OpenAiOauthCredentialBlob } from "../utils/openAiOauthCredentials.js";

function createIo(): OpenAiAuthCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function readSingleJsonLine(io: ReturnType<typeof createIo>): unknown {
  const lines = io.stdoutText().trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
}

function modelDeps(options: {
  readonly readCredentials: () => OpenAiOauthCredentialBlob | undefined;
  readonly fetch?: typeof fetch;
  readonly refreshSubscription?: OpenAiAuthCliDeps["refreshSubscription"];
}): Partial<OpenAiAuthCliDeps> {
  return {
    readCredentials: options.readCredentials,
    fetch:
      options.fetch ??
      vi.fn<typeof fetch>(async () =>
        Promise.reject(new Error("unexpected fetch")),
      ),
    refreshSubscription:
      options.refreshSubscription ?? (async () => false),
  };
}

describe("OpenAI auth CLI", () => {
  it("parses model discovery, aliases, help, and invalid arguments", () => {
    expect(parseOpenAiAuthCliArgs(["openai-models", "--json"])).toEqual({
      kind: "models",
      json: true,
    });
    expect(parseOpenAiAuthCliArgs(["--json", "chatgpt-models"])).toEqual({
      kind: "models",
      json: true,
    });
    expect(parseOpenAiAuthCliArgs(["openai-auth-status"])).toEqual({
      kind: "status",
      json: false,
    });
    expect(parseOpenAiAuthCliArgs(["openai-models", "--help"])).toEqual({
      kind: "help",
      text: formatOpenAiAuthCliHelpText(),
    });
    expect(parseOpenAiAuthCliArgs(["openai-models", "extra"])).toEqual({
      kind: "error",
      message: "openai-models does not accept argument 'extra'",
    });
    expect(parseOpenAiAuthCliArgs(["models"])).toBeNull();
  });

  it.each([
    {
      name: "persisted ChatGPT mode",
      credential: {
        authMode: "chatgpt",
        accessToken: "access",
        accountId: "account",
      } satisfies OpenAiOauthCredentialBlob,
      expected: "chatgpt",
    },
    {
      name: "legacy API-key shape",
      credential: {
        apiKey: "platform-key",
      } satisfies OpenAiOauthCredentialBlob,
      expected: "apiKey",
    },
    {
      name: "legacy subscription shape",
      credential: {
        accessToken: "access",
        accountId: "account",
      } satisfies OpenAiOauthCredentialBlob,
      expected: "chatgpt",
    },
    {
      name: "API key contradicting persisted ChatGPT metadata",
      credential: {
        authMode: "chatgpt",
        apiKey: "platform-key",
        accessToken: "access",
        accountId: "account",
      } satisfies OpenAiOauthCredentialBlob,
      expected: "apiKey",
    },
    {
      name: "subscription contradicting persisted API-key metadata",
      credential: {
        authMode: "apiKey",
        accessToken: "access",
        accountId: "account",
      } satisfies OpenAiOauthCredentialBlob,
      expected: "chatgpt",
    },
  ])("reports authMode for $name", async ({ credential, expected }) => {
    const io = createIo();
    const code = await runOpenAiAuthCli(
      { kind: "status", json: true },
      io,
      { readCredentials: () => credential },
    );

    expect(code).toBe(0);
    expect(readSingleJsonLine(io)).toEqual({
      ok: true,
      signedIn: true,
      authMode: expected,
    });
    expect(io.stderrText()).toBe("");
  });

  it("does not report a malformed credential blob as signed in", async () => {
    const io = createIo();
    const code = await runOpenAiAuthCli(
      { kind: "status", json: true },
      io,
      { readCredentials: () => ({ authMode: "chatgpt" }) },
    );

    expect(code).toBe(0);
    expect(readSingleJsonLine(io)).toEqual({
      ok: true,
      signedIn: false,
    });
  });

  it("lists platform models with the stored OAuth API key", async () => {
    const refreshSubscription = vi.fn(async () => false);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/models");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer platform-secret");
      expect(headers.has("chatgpt-account-id")).toBe(false);
      return Response.json({
        data: [
          { id: "gpt-5" },
          { id: " gpt-5-mini " },
          { id: "gpt-5" },
          { ignored: true },
        ],
      });
    });
    const io = createIo();

    const code = await runOpenAiAuthCli(
      { kind: "models", json: true },
      io,
      modelDeps({
        readCredentials: () => ({ apiKey: " platform-secret " }),
        fetch: fetchImpl,
        refreshSubscription,
      }),
    );

    expect(code).toBe(0);
    expect(readSingleJsonLine(io)).toEqual({
      ok: true,
      models: ["gpt-5", "gpt-5-mini"],
      authMode: "apiKey",
    });
    expect(io.stdoutText()).not.toContain("platform-secret");
    expect(refreshSubscription).not.toHaveBeenCalled();
  });

  it("refreshes a subscription, re-reads secure storage, and lists ChatGPT models", async () => {
    const stale: OpenAiOauthCredentialBlob = {
      authMode: "chatgpt",
      accessToken: "stale-token",
      accountId: "account-id",
      refreshToken: "refresh-token",
    };
    const fresh: OpenAiOauthCredentialBlob = {
      ...stale,
      accessToken: "fresh-token",
      refreshToken: "rotated-refresh-token",
    };
    const reads = vi.fn()
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(fresh);
    const refreshSubscription = vi.fn(async () => true);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://chatgpt.com/backend-api/codex/models?client_version=0.149.0",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer fresh-token");
      expect(headers.get("chatgpt-account-id")).toBe("account-id");
      expect(headers.get("originator")).toBe("agenc");
      return Response.json({
        models: [{ slug: "gpt-5-codex" }, { slug: "gpt-5.1-codex" }],
      });
    });
    const io = createIo();

    const code = await runOpenAiAuthCli(
      { kind: "models", json: true },
      io,
      modelDeps({
        readCredentials: reads,
        fetch: fetchImpl,
        refreshSubscription,
      }),
    );

    expect(code).toBe(0);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(refreshSubscription).toHaveBeenCalledTimes(1);
    expect(readSingleJsonLine(io)).toEqual({
      ok: true,
      models: ["gpt-5-codex", "gpt-5.1-codex"],
      authMode: "chatgpt",
    });
    expect(io.stdoutText()).not.toContain("stale-token");
    expect(io.stdoutText()).not.toContain("fresh-token");
    expect(io.stdoutText()).not.toContain("account-id");
  });

  it("returns a sanitized JSON error for HTTP 401 without consuming its body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("server-secret-body", {
        status: 401,
        headers: { "x-debug-secret": "header-secret" },
      }),
    );
    const io = createIo();

    const code = await runOpenAiAuthCli(
      { kind: "models", json: true },
      io,
      modelDeps({
        readCredentials: () => ({ apiKey: "platform-secret" }),
        fetch: fetchImpl,
      }),
    );

    expect(code).toBe(1);
    expect(readSingleJsonLine(io)).toEqual({
      ok: false,
      error: "OpenAI model discovery failed (HTTP 401).",
      code: "http_401",
    });
    expect(io.stdoutText()).not.toMatch(
      /platform-secret|server-secret-body|header-secret/,
    );
    expect(io.stderrText()).toBe("");
  });

  it("sanitizes network and timeout errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new Error("network failure containing platform-secret");
    });
    const io = createIo();

    const code = await runOpenAiAuthCli(
      { kind: "models", json: true },
      io,
      modelDeps({
        readCredentials: () => ({ apiKey: "platform-secret" }),
        fetch: fetchImpl,
      }),
    );

    expect(code).toBe(1);
    expect(readSingleJsonLine(io)).toEqual({
      ok: false,
      error: "OpenAI model discovery request failed.",
      code: "network_error",
    });
    expect(io.stdoutText()).not.toContain("platform-secret");
    expect(io.stderrText()).toBe("");
  });

  it("returns not_signed_in without making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const refreshSubscription = vi.fn(async () => false);
    const io = createIo();

    const code = await runOpenAiAuthCli(
      { kind: "models", json: true },
      io,
      modelDeps({
        readCredentials: () => undefined,
        fetch: fetchImpl,
        refreshSubscription,
      }),
    );

    expect(code).toBe(1);
    expect(readSingleJsonLine(io)).toEqual({
      ok: false,
      error: "No OpenAI sign-in is stored.",
      code: "not_signed_in",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(refreshSubscription).not.toHaveBeenCalled();
  });

  it("rejects an incomplete stored blob without making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const io = createIo();

    const code = await runOpenAiAuthCli(
      { kind: "models", json: true },
      io,
      modelDeps({
        readCredentials: () => ({ authMode: "apiKey" }),
        fetch: fetchImpl,
      }),
    );

    expect(code).toBe(1);
    expect(readSingleJsonLine(io)).toEqual({
      ok: false,
      error: "The stored OpenAI API-key credential is incomplete.",
      code: "invalid_credential",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
