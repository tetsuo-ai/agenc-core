import { createServer } from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({}),
}));

vi.mock("../../src/utils/sandbox/sandbox-runtime.js", () => ({
  SandboxManager: {
    isSandboxingEnabled: () => false,
  },
}));

import { execHttpHook } from "../../src/utils/hooks/execHttpHook.js";

const originalHttpProxy = process.env.HTTP_PROXY;
const originalNoProxy = process.env.NO_PROXY;
const originalHookToken = process.env.HOOK_TOKEN;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("HTTP_PROXY", originalHttpProxy);
  restore("NO_PROXY", originalNoProxy);
  restore("HOOK_TOKEN", originalHookToken);
});

describe("HTTP hook session authority", () => {
  test("uses each immutable environment after ambient proxy and secret mutation", async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:2";
    delete process.env.NO_PROXY;
    process.env.HOOK_TOKEN = "ambient-token";

    const observedTokens: string[] = [];
    const server = createServer((request, response) => {
      const value = request.headers["x-hook-token"];
      if (typeof value === "string") observedTokens.push(value);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });

    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const hook = {
        type: "http" as const,
        url: `http://127.0.0.1:${address.port}/hook`,
        headers: { "x-hook-token": "$HOOK_TOKEN" },
        allowedEnvVars: ["HOOK_TOKEN"],
      };
      const environmentA = Object.freeze({
        HTTP_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "127.0.0.1",
        HOOK_TOKEN: "session-a-token",
      });
      const environmentB = Object.freeze({
        NO_PROXY: "127.0.0.1",
        HOOK_TOKEN: "session-b-token",
      });

      await expect(
        execHttpHook(hook, "Stop", "{}", environmentA),
      ).resolves.toMatchObject({ ok: true, statusCode: 200 });
      await expect(
        execHttpHook(hook, "Stop", "{}", environmentB),
      ).resolves.toMatchObject({ ok: true, statusCode: 200 });

      expect(observedTokens).toEqual([
        "session-a-token",
        "session-b-token",
      ]);
      expect(observedTokens).not.toContain("ambient-token");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
