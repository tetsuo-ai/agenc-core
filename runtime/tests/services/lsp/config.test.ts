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

  test("rejects unsupported lifecycle fields and non-canonical commands", () => {
    expect(
      parseLspServersConfig({
        bad: {
          command: " server ",
          extensionToLanguage: { ".ts": "typescript" },
        },
      }),
    ).toMatchObject({
      success: false,
      reason: expect.stringContaining("surrounding whitespace"),
    });

    expect(
      parseLspServersConfig({
        bad: {
          command: "server",
          extensionToLanguage: { ".ts": "typescript" },
          restartOnCrash: true,
        },
      }),
    ).toMatchObject({
      success: false,
      reason: expect.stringContaining("restartOnCrash is not supported"),
    });

    expect(
      parseLspServersConfig({
        bad: {
          command: "server",
          workspaceFolder: " /workspace/project ",
          extensionToLanguage: { ".ts": "typescript" },
        },
      }),
    ).toMatchObject({
      success: false,
      reason: expect.stringContaining("workspaceFolder must not include"),
    });
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

  test("surfaces config source failures", async () => {
    const restore = setLspServerConfigSourceForTesting(() => {
      throw new Error("cannot read lsp config");
    });
    try {
      await expect(getAllLspServers()).rejects.toThrow("cannot read lsp config");
    } finally {
      restore();
    }
  });
});
