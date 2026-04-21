import { afterEach, describe, expect, it } from "vitest";
import { getTransportForUrl, resolveTransportMode } from "./fallback-ladder.js";
import { SSETransport } from "./sse-post.js";
import { HybridTransport } from "./ws-post.js";
import { WebSocketTransport } from "./ws-duplex.js";

const ENV_KEYS = [
  "AGENC_TRANSPORT",
  "CLAUDE_CODE_USE_CCR_V2",
  "USE_CCR_V2",
  "CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2",
  "CLAUDE_CODE_POST_FOR_SESSION_INGRESS",
  "POST_FOR_SESSION_INGRESS",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("resolveTransportMode", () => {
  it("prefers explicit AGENC_TRANSPORT over feature flags", () => {
    expect(
      resolveTransportMode({
        AGENC_TRANSPORT: "ws",
        CLAUDE_CODE_USE_CCR_V2: "1",
      } as NodeJS.ProcessEnv),
    ).toBe("websocket");
  });

  it("accepts the retained alias set and rejects unsupported overrides", () => {
    expect(
      resolveTransportMode({
        AGENC_TRANSPORT: "post",
      } as NodeJS.ProcessEnv),
    ).toBe("hybrid");
    expect(
      resolveTransportMode({
        AGENC_TRANSPORT: "ccr",
      } as NodeJS.ProcessEnv),
    ).toBe("sse");

    expect(() =>
      resolveTransportMode({
        AGENC_TRANSPORT: "invalid",
      } as NodeJS.ProcessEnv),
    ).toThrow("Unsupported AGENC_TRANSPORT value: invalid");
  });

  it("follows the openclaude fallback order when no explicit override is set", () => {
    expect(
      resolveTransportMode({
        CLAUDE_CODE_USE_CCR_V2: "1",
      } as NodeJS.ProcessEnv),
    ).toBe("sse");
    expect(
      resolveTransportMode({
        CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: "1",
      } as NodeJS.ProcessEnv),
    ).toBe("hybrid");
    expect(
      resolveTransportMode({
        USE_CCR_V2: "1",
      } as NodeJS.ProcessEnv),
    ).toBe("sse");
    expect(
      resolveTransportMode({
        POST_FOR_SESSION_INGRESS: "1",
      } as NodeJS.ProcessEnv),
    ).toBe("hybrid");
    expect(resolveTransportMode({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("getTransportForUrl", () => {
  it("creates an SSE transport for CCR v2", () => {
    const transport = getTransportForUrl(
      new URL("wss://example.test/v2/session_ingress/session/session-1"),
      {},
      undefined,
      undefined,
      {
        CLAUDE_CODE_USE_CCR_V2: "1",
      } as NodeJS.ProcessEnv,
    );

    expect(transport).toBeInstanceOf(SSETransport);
  });

  it("creates a hybrid transport for POST session-ingress mode", () => {
    const transport = getTransportForUrl(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      {},
      undefined,
      undefined,
      {
        CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: "1",
      } as NodeJS.ProcessEnv,
    );

    expect(transport).toBeInstanceOf(HybridTransport);
  });

  it("falls back to websocket transport by default", () => {
    const transport = getTransportForUrl(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      {},
      undefined,
      undefined,
      {} as NodeJS.ProcessEnv,
    );

    expect(transport).toBeInstanceOf(WebSocketTransport);
  });

  it("rejects non-websocket URLs when no SSE override is active", () => {
    expect(() =>
      getTransportForUrl(
        new URL("https://example.test/v2/session_ingress/session/session-1"),
        {},
        undefined,
        undefined,
        {} as NodeJS.ProcessEnv,
      ),
    ).toThrow("Unsupported protocol: https:");
  });
});
