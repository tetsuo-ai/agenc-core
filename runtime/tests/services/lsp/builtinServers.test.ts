import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  BUILTIN_LSP_PROFILES,
  builtinLspServerConfigs,
  resolveCommandOnPath,
  typescriptServerFallback,
} from "./builtinServers.js";

describe("built-in language server profiles", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeBin(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "agenc-lsp-bin-"));
    dirs.push(dir);
    for (const name of names) {
      const path = join(dir, name);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    return dir;
  }

  test("resolves a bare command against PATH and nothing else", () => {
    const bin = fakeBin(["typescript-language-server"]);
    const workspaceBin = fakeBin(["gopls"]);
    mkdirSync(join(workspaceBin, "node_modules", ".bin"), { recursive: true });
    const env = { PATH: bin };
    expect(resolveCommandOnPath("typescript-language-server", env, "linux")).toBe(
      join(bin, "typescript-language-server"),
    );
    expect(resolveCommandOnPath("gopls", env, "linux")).toBeUndefined();
    expect(resolveCommandOnPath(join(workspaceBin, "gopls"), env, "linux")).toBeUndefined();
    expect(resolveCommandOnPath("./gopls", env, "linux")).toBeUndefined();
    expect(resolveCommandOnPath("gopls", { PATH: "" }, "linux")).toBeUndefined();
  });

  test("ignores a directory entry and a non-executable file with the command's name", () => {
    const bin = fakeBin([]);
    mkdirSync(join(bin, "gopls"));
    writeFileSync(join(bin, "rust-analyzer"), "not executable");
    chmodSync(join(bin, "rust-analyzer"), 0o644);
    expect(resolveCommandOnPath("gopls", { PATH: bin }, "linux")).toBeUndefined();
    expect(resolveCommandOnPath("rust-analyzer", { PATH: bin }, "linux")).toBeUndefined();
  });

  test("activates only the profiles whose binary exists, with the first known command winning", () => {
    const found = new Set(["pyright-langserver", "gopls"]);
    const servers = builtinLspServerConfigs({
      env: {},
      resolveCommand: (command) => (found.has(command) ? `/opt/bin/${command}` : undefined),
    });
    expect(Object.keys(servers).sort()).toEqual(["builtin-go", "builtin-python"]);
    expect(servers["builtin-python"]).toMatchObject({
      command: "/opt/bin/pyright-langserver",
      args: ["--stdio"],
      extensionToLanguage: { ".py": "python", ".pyi": "python" },
    });
    expect(servers["builtin-go"]?.args).toEqual([]);
  });

  test("a configured server that claims an extension replaces the matching profile", () => {
    const servers = builtinLspServerConfigs({
      env: {},
      resolveCommand: (command) => `/opt/bin/${command}`,
      configured: {
        mine: { command: "/opt/bin/my-ts", extensionToLanguage: { ".TS": "typescript" } },
      },
    });
    expect(servers["builtin-typescript"]).toBeUndefined();
    expect(Object.keys(servers).sort()).toEqual(["builtin-go", "builtin-python", "builtin-rust"]);
  });

  test("AGENC_DISABLE_BUILTIN_LSP turns every profile off", () => {
    expect(
      builtinLspServerConfigs({ env: { AGENC_DISABLE_BUILTIN_LSP: "1" }, resolveCommand: (c) => `/opt/bin/${c}` }),
    ).toEqual({});
  });

  test("every profile names at least one command and one extension", () => {
    for (const profile of BUILTIN_LSP_PROFILES) {
      expect(profile.commands.length).toBeGreaterThan(0);
      expect(Object.keys(profile.extensionToLanguage).length).toBeGreaterThan(0);
      for (const extension of Object.keys(profile.extensionToLanguage)) {
        expect(extension.startsWith(".")).toBe(true);
      }
    }
  });

  test("the TypeScript profile points at the TypeScript installed next to the server only when the workspace has none", () => {
    const prefix = mkdtempSync(join(tmpdir(), "agenc-lsp-prefix-"));
    dirs.push(prefix);
    const serverDir = join(prefix, "node_modules", "typescript-language-server", "lib");
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, "cli.mjs"), "#!/usr/bin/env node\n");
    const tsserver = join(prefix, "node_modules", "typescript", "lib", "tsserver.js");
    mkdirSync(join(prefix, "node_modules", "typescript", "lib"), { recursive: true });
    writeFileSync(tsserver, "// tsserver\n");
    const bin = join(prefix, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const link = join(bin, "typescript-language-server");
    symlinkSync(join(serverDir, "cli.mjs"), link);

    const bareWorkspace = mkdtempSync(join(tmpdir(), "agenc-lsp-ws-"));
    dirs.push(bareWorkspace);
    expect(typescriptServerFallback(link, bareWorkspace)).toEqual({ tsserver: { path: tsserver } });
    expect(typescriptServerFallback(link, undefined)).toEqual({ tsserver: { path: tsserver } });

    const typedWorkspace = mkdtempSync(join(tmpdir(), "agenc-lsp-ws-"));
    dirs.push(typedWorkspace);
    mkdirSync(join(typedWorkspace, "node_modules", "typescript", "lib"), { recursive: true });
    writeFileSync(join(typedWorkspace, "node_modules", "typescript", "lib", "tsserver.js"), "// project tsserver\n");
    expect(typescriptServerFallback(link, typedWorkspace)).toBeUndefined();

    const servers = builtinLspServerConfigs({
      env: {},
      workspaceRoot: bareWorkspace,
      resolveCommand: (command) => (command === "typescript-language-server" ? link : undefined),
    });
    expect(servers["builtin-typescript"]?.initializationOptions).toEqual({ tsserver: { path: tsserver } });
    expect(typescriptServerFallback("/nonexistent/typescript-language-server", bareWorkspace)).toBeUndefined();

    // TypeScript 7 (the Go port) ships lib/tsc.js but no tsserver.js: nothing to point at.
    const sevenPrefix = mkdtempSync(join(tmpdir(), "agenc-lsp-prefix7-"));
    dirs.push(sevenPrefix);
    const sevenServer = join(sevenPrefix, "node_modules", "typescript-language-server", "lib");
    mkdirSync(sevenServer, { recursive: true });
    writeFileSync(join(sevenServer, "cli.mjs"), "#!/usr/bin/env node\n");
    mkdirSync(join(sevenPrefix, "node_modules", "typescript", "lib"), { recursive: true });
    writeFileSync(join(sevenPrefix, "node_modules", "typescript", "lib", "tsc.js"), "// tsc only\n");
    expect(typescriptServerFallback(join(sevenServer, "cli.mjs"), bareWorkspace)).toBeUndefined();
  });
});
