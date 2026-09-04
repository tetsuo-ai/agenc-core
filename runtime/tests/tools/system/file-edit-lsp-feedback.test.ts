import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFileEditTool } from "../../tools/system/file-edit.js";
import { createFileWriteTool } from "../../tools/system/file-write.js";
import {
  _resetLspManagerForTesting,
  initializeLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
} from "../../services/lsp/manager.js";
import { normalizeLspServerConfig } from "../../services/lsp/config.js";
import { resetAllLSPDiagnosticState } from "../../services/lsp/LSPDiagnosticRegistry.js";
import type { LSPServerInstance } from "../../services/lsp/LSPServerInstance.js";
import {
  clearSessionReadState,
  recordSessionRead,
  SESSION_ID_ARG,
} from "./filesystem.js";

const SESSION_ID = "edit-lsp-feedback-test-session";

/**
 * A language server that answers every didSave with a scripted publication for
 * that file, the way tsserver answers with its diagnostics.
 */
function fakeServer(publish: (uri: string) => { message: string; severity: number; line: number }[] | undefined) {
  let state: LSPServerInstance["state"] = "stopped";
  let handler: ((params: unknown) => void) | undefined;
  const server = {
    name: "fake-ts",
    config: normalizeLspServerConfig("fake-ts", {
      command: "fake-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    }),
    get state() {
      return state;
    },
    start: async () => {
      state = "running";
    },
    stop: async () => {
      state = "stopped";
    },
    restart: async () => {},
    isHealthy: () => true,
    sendRequest: async () => ({}),
    sendNotification: async (method: string, params: { textDocument?: { uri?: string } }) => {
      if (method !== "textDocument/didSave") return;
      const uri = params.textDocument?.uri ?? "";
      const diagnostics = publish(uri);
      if (diagnostics === undefined) return;
      setTimeout(() => {
        handler?.({
          uri,
          diagnostics: diagnostics.map((entry) => ({
            message: entry.message,
            severity: entry.severity,
            range: { start: { line: entry.line, character: 2 }, end: { line: entry.line, character: 5 } },
            source: "ts",
            code: 2304,
          })),
        });
      }, 20);
    },
    onNotification: (method: string, callback: (params: unknown) => void) => {
      if (method === "textDocument/publishDiagnostics") handler = callback;
    },
    onRequest: () => {},
  } as unknown as LSPServerInstance;
  return server;
}

describe("same-turn language server feedback in the mutation tools", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-edit-lsp-"));
    _resetLspManagerForTesting();
    resetAllLSPDiagnosticState();
  });

  afterEach(async () => {
    await shutdownLspServerManager();
    _resetLspManagerForTesting();
    resetAllLSPDiagnosticState();
    clearSessionReadState(SESSION_ID, tmpdir());
    await rm(root, { recursive: true, force: true });
  });

  async function seedRead(file: string, content: string): Promise<void> {
    await writeFile(file, content);
    const stats = await stat(file);
    recordSessionRead(SESSION_ID, file, { content, timestamp: stats.mtimeMs, viewKind: "full" });
  }

  async function startFakeServer(publish: Parameters<typeof fakeServer>[0]): Promise<void> {
    const server = fakeServer(publish);
    initializeLspServerManager({
      workspaceRoot: root,
      configSource: () => ({ "fake-ts": server.config }),
      instanceFactory: () => server,
    });
    await waitForInitialization();
  }

  test("an Edit result carries the server's diagnostics for the edited file", async () => {
    await startFakeServer((uri) =>
      uri.endsWith("/a.ts") ? [{ message: "Cannot find name 'c'.", severity: 1, line: 1 }] : [],
    );
    const file = join(root, "a.ts");
    await seedRead(file, "export const a = 1\nexport const b = a + 1\n");
    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "a + 1",
      new_string: "a + c",
      [SESSION_ID_ARG]: SESSION_ID,
    });
    expect(result.isError).toBeUndefined();
    const content = String(result.content);
    expect(content).toContain("Language server diagnostics after this edit (1 error):");
    expect(content).toContain(":2:3 error ts 2304: Cannot find name 'c'.");
    await expect(readFile(file, "utf8")).resolves.toContain("a + c");
  });

  test("a clean publication is spelled out, and the file's diagnostics do not repeat as an attachment", async () => {
    await startFakeServer(() => []);
    const file = join(root, "clean.ts");
    await seedRead(file, "export const x = 1\n");
    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "1",
      new_string: "2",
      [SESSION_ID_ARG]: SESSION_ID,
    });
    expect(String(result.content)).toContain("Language server: no diagnostics for this file after the edit.");
  });

  test("a Write result carries diagnostics too", async () => {
    await startFakeServer((uri) =>
      uri === pathToFileURL(join(root, "w.ts")).href ? [{ message: "boom", severity: 2, line: 0 }] : [],
    );
    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: join(root, "w.ts"),
      content: "export const w = 1\n",
      [SESSION_ID_ARG]: SESSION_ID,
    });
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("Language server diagnostics after this edit (1 warning):");
    expect(String(result.content)).toContain("w.ts:1:3 warning ts 2304: boom");
  });

  test("a file no server covers returns the plain result without waiting", async () => {
    await startFakeServer(() => []);
    const file = join(root, "notes.md");
    await seedRead(file, "# notes\n");
    const tool = createFileEditTool({ allowedPaths: [root] });
    const started = Date.now();
    const result = await tool.execute({
      file_path: file,
      old_string: "notes",
      new_string: "Notes",
      [SESSION_ID_ARG]: SESSION_ID,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(String(result.content)).not.toContain("Language server");
  });

  test("a silent server costs at most the feedback window", async () => {
    process.env.AGENC_LSP_EDIT_FEEDBACK_MS = "150";
    try {
      await startFakeServer(() => undefined);
      const file = join(root, "slow.ts");
      await seedRead(file, "export const s = 1\n");
      const tool = createFileEditTool({ allowedPaths: [root] });
      const started = Date.now();
      const result = await tool.execute({
        file_path: file,
        old_string: "1",
        new_string: "2",
        [SESSION_ID_ARG]: SESSION_ID,
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(2000);
      expect(String(result.content)).not.toContain("Language server");
    } finally {
      delete process.env.AGENC_LSP_EDIT_FEEDBACK_MS;
    }
  });
});
