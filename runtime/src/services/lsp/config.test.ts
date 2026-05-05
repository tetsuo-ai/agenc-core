import { describe, expect, test } from "vitest";

import {
  getAllLspServers,
  normalizeLspServerConfig,
  parseLspServersConfig,
  setLspServerConfigSourceForTesting,
} from "./config.js";

describe("lsp config", () => {
  test("normalizes extensions and optional fields", () => {
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      args: ["--stdio"],
      env: { NODE_ENV: "test" },
      extensionToLanguage: { ts: "typescript", ".tsx": "typescriptreact" },
      startupTimeout: 1000,
      maxRestarts: 2,
    });

    expect(config.command).toBe("typescript-language-server");
    expect(config.args).toEqual(["--stdio"]);
    expect(config.extensionToLanguage).toEqual({
      ".ts": "typescript",
      ".tsx": "typescriptreact",
    });
    expect(config.startupTimeout).toBe(1000);
    expect(config.maxRestarts).toBe(2);
  });

  test("rejects invalid server config with an actionable reason", () => {
    const result = parseLspServersConfig({
      broken: { command: "", extensionToLanguage: {} },
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.reason).toContain("broken");
  });

  test("uses injectable server sources", async () => {
    const restore = setLspServerConfigSourceForTesting(() => ({
      py: normalizeLspServerConfig("py", {
        command: "pyright-langserver",
        extensionToLanguage: { ".py": "python" },
      }),
    }));
    try {
      const result = await getAllLspServers();
      expect(Object.keys(result.servers)).toEqual(["py"]);
    } finally {
      restore();
    }
  });
});
