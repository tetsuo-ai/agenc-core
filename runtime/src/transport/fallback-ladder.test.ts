import { afterEach, describe, expect, it } from "vitest";
import { resolveTransportMode } from "./fallback-ladder.js";

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
