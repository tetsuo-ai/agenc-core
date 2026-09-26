import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { addLineNumbers, SPARSE_LINE_NUMBERS_ENV, sparseLineNumbersEnabled } from "./_deps/line-numbers.js";
import { clearFileReadListenersForTests, createFileReadTool as createUnboundFileReadTool } from "./file-read.js";
import { createFileEditTool } from "./file-edit.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { buildBootstrapToolRegistry } from "../../../src/bin/bootstrap-tool-registry.js";
import {
  getSelectedProviderEnvironment,
  runWithStartupProviderSelection,
} from "../../../src/utils/model/providers.js";

const createFileReadTool = (...args: Parameters<typeof createUnboundFileReadTool>) =>
  bindExplicitDangerBoundary(createUnboundFileReadTool(...args));

describe("sparse line numbers", () => {
  test("number the first line, every tenth line and the last line", () => {
    const content = Array.from({ length: 23 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = addLineNumbers({ content, startLine: 1, sparse: true }).split("\n");
    expect(lines[0]).toBe("1→line 1");
    expect(lines[1]).toBe("line 2");
    expect(lines[9]).toBe("10→line 10");
    expect(lines[19]).toBe("20→line 20");
    expect(lines[21]).toBe("line 22");
    expect(lines[22]).toBe("23→line 23");
    expect(lines.filter((line) => line.includes("→"))).toHaveLength(4);
  });

  test("count from the read offset", () => {
    expect(addLineNumbers({ content: "a\nb\nc\nd", startLine: 8, sparse: true }))
      .toBe("8→a\nb\n10→c\n11→d");
    expect(addLineNumbers({ content: "only", startLine: 5, sparse: true })).toBe("5→only");
  });

  test("keep every number when the switch is off", () => {
    expect(addLineNumbers({ content: "a\nb\nc", startLine: 1 })).toBe("1→a\n2→b\n3→c");
  });
});

describe("FileRead with sparse line numbers", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-sparse-lines-"));
    clearFileReadListenersForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearFileReadListenersForTests();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const SPARSE_TWELVE = ["1→row 1", "row 2", "row 3", "row 4", "row 5", "row 6", "row 7", "row 8", "row 9", "10→row 10", "row 11", "12→row 12"].join("\n");
  const writeTwelve = async (): Promise<string> => {
    const file = join(root, "twelve.txt");
    await writeFile(file, Array.from({ length: 12 }, (_, index) => `row ${index + 1}`).join("\n"), "utf8");
    return file;
  };

  test("returns sparse numbers only when the tool is built with them", async () => {
    const file = await writeTwelve();
    const full = await createFileReadTool({ allowedPaths: [root] }).execute({ file_path: file });
    expect(full.content).toContain("2→row 2");
    const sparse = await createFileReadTool({ allowedPaths: [root], sparseLineNumbers: true }).execute({ file_path: file });
    expect(sparse.content).toBe(SPARSE_TWELVE);
  });

  test("ignores the daemon's process environment", async () => {
    vi.stubEnv(SPARSE_LINE_NUMBERS_ENV, "1");
    const file = await writeTwelve();
    const full = await createFileReadTool({ allowedPaths: [root] }).execute({ file_path: file });
    expect(full.content).toContain("2→row 2");
    expect(sparseLineNumbersEnabled({})).toBe(false);
    expect(sparseLineNumbersEnabled({ [SPARSE_LINE_NUMBERS_ENV]: "1" })).toBe(true);
  });

  test("describes the sparse format to the model", async () => {
    const before = createFileReadTool({ allowedPaths: [root] }).description;
    expect(before).toContain("cat -n format");
    const readTool = createFileReadTool({ allowedPaths: [root], sparseLineNumbers: true });
    expect(readTool.description).toContain("every tenth line and the last line");
    expect(readTool.description).not.toContain("cat -n format");
    const editTool = bindExplicitDangerBoundary(createFileEditTool({ allowedPaths: [root], sparseLineNumbers: true }));
    expect(editTool.description).toContain("it is not part of the file");
    expect(editTool.description).not.toContain("line number + tab");
  });

  test("the session switch reaches a session's tools through the captured session environment", async () => {
    // runWithStartupProviderSelection captures the environment through the
    // daemon client allowlist, as a daemon-owned (Desktop) session does; the
    // bootstrap registry reads the switch from that environment.
    const file = await writeTwelve();
    const readWith = (environment: Record<string, string>) =>
      runWithStartupProviderSelection(
        { provider: "deepseek", model: "deepseek-flash", environment },
        async () => {
          const registry = buildBootstrapToolRegistry({
            workspaceRoot: root,
            agencHome: join(root, "home"),
            environment: getSelectedProviderEnvironment(),
            mcpManager: {
              getTools: () => [],
              effectiveServers: async () => new Map(),
              toolPluginProvenance: async () => null,
            } as never,
            csvAgentJobsRepositories: {
              async withRepository(): Promise<never> {
                throw new Error("CSV repositories are not used by this test");
              },
            },
            getSession: () => null,
            emitWarning: () => {},
          });
          const tool = registry.tools.find((candidate) => candidate.name === "FileRead")!;
          return (await bindExplicitDangerBoundary(tool).execute({ file_path: file })).content;
        },
      );
    expect(await readWith({ [SPARSE_LINE_NUMBERS_ENV]: "1" })).toBe(SPARSE_TWELVE);
    expect(await readWith({})).toContain("2→row 2");
  });
});
