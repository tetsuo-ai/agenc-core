import { afterEach, expect, test, vi } from "vitest";

const reads = vi.hoisted(() => ({ paths: [] as string[], bytes: new WeakMap<object, Buffer>() }));
vi.mock("../../src/mcp-client/display-attachments.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/mcp-client/display-attachments.js")>();
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  return {
    ...original,
    validateDisplayBlock: async (block: Record<string, unknown>, roots: readonly string[]) => {
      const path = fileURLToPath(String(block.uri));
      if (!roots.some(root => path.startsWith(`${root}/`))) throw new original.DisplayValidationError("outside allowed root");
      reads.paths.push(path);
      const bytes = await readFile(path);
      // Like the real validator's safeTitle: titles are cut at 120 characters.
      const title = String(block.name).slice(0, 120);
      const attachment = { id: "file-id", kind: "file" as const, title, mimeType: "text/plain", size: bytes.length, digest: "file-id" };
      reads.bytes.set(attachment, bytes);
      return { attachment, caption: `[Shown to the user: file "${title}", ${bytes.length} bytes]` };
    },
    peekDisplayArtifactBytes: (attachment: object) => reads.bytes.get(attachment),
  };
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createToolBridge } from "../../src/mcp-client/tools.js";

const directories: string[] = [];
afterEach(async () => {
  reads.paths.length = 0;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function showFile(contents: string, name = "report.txt") {
  const root = await mkdtemp(join(tmpdir(), "mcp-file-redaction-"));
  directories.push(root);
  const originalPath = join(root, "report.txt");
  await writeFile(originalPath, contents);
  await writeFile(join(root, "[REDACTED].txt"), "wrong file");
  const originalRaw = { content: [{ type: "resource_link", annotations: { audience: ["user"] }, uri: pathToFileURL(originalPath).href, name, mimeType: "text/plain" }] };
  const sensitiveHeaders = { token: "report" };
  const bridge = await createToolBridge({
    listTools: async () => ({ tools: [{ name: "show" }] }),
    callTool: async () => originalRaw,
    close: async () => {},
  }, "plugin:demo:show", logger, { environment: {}, serverConfig: { sensitiveHeaders, displayDataRoot: root } });
  const result = await bridge.tools[0]!.execute({});
  await bridge.dispose();
  return { result, originalPath };
}

test("reads the original URI despite a colliding redacted file path", async () => {
  const { result, originalPath } = await showFile("actual file bytes");
  expect(reads.paths).toEqual([originalPath]);
  expect(result.metadata?.displayAttachments).toMatchObject([{ kind: "file", size: Buffer.byteLength("actual file bytes"), title: "[REDACTED].txt" }]);
  expect(JSON.stringify(result)).not.toContain("report");
});

test("checks the bytes read from the original URI for saved secrets", async () => {
  const { result, originalPath } = await showFile("inside: report");
  expect(reads.paths).toEqual([originalPath]);
  expect(result.metadata?.displayAttachments).toBeUndefined();
  expect(result.content).toContain("contained a saved secret");
});

test("redacts a long file title before the validator truncates it", async () => {
  // Cut at 120 characters, the unredacted name would end in "repo".
  const { result } = await showFile("actual file bytes", `${"x".repeat(116)}report.txt`);
  expect(JSON.stringify(result)).not.toContain("repo");
  expect(result.metadata?.displayAttachments).toMatchObject([{ kind: "file" }]);
});
