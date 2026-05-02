import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFileReadTool, FILE_READ_TOOL_NAME } from "./file-read.js";
import {
  clearSessionReadState,
  getSessionReadSnapshot,
  hasSessionRead,
  SESSION_AGENC_HOME_ARG,
} from "./filesystem.js";
import {
  clearAllPlanSlugs,
  getPlanFilePath,
  setPlanSlug,
} from "../../planning/plan-files.js";

describe("FileRead tool", () => {
  let root = "";
  let savedPath: string | undefined;
  const sessionId = "sess-file-read-test";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-file-read-"));
    savedPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
    clearSessionReadState(sessionId);
    clearAllPlanSlugs();
  });

  test("reads a small text file and returns content with line numbers", async () => {
    const file = join(root, "hello.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({ file_path: file });

    expect(result.isError).toBeUndefined();
    // Trailing empty line from `\n` end-of-file is preserved by split.
    expect(result.content).toBe("1→alpha\n2→beta\n3→gamma\n4→");
    expect(tool.name).toBe(FILE_READ_TOOL_NAME);
  });

  test("rejects a file that exceeds the token budget", async () => {
    const file = join(root, "big.txt");
    // 4-char token estimate × cap of 100 → need ~401 chars to exceed.
    const big = "abcd".repeat(150);
    await writeFile(file, big, "utf8");
    const tool = createFileReadTool({
      allowedPaths: [root],
      maxTokens: 100,
    });

    const result = await tool.execute({ file_path: file });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeds maximum allowed tokens");
    // Plain-text envelope: no JSON wrapping.
    expect(() => JSON.parse(result.content)).toThrow();
  });

  test("uses dense token estimation for JSON files", async () => {
    const file = join(root, "data.json");
    await writeFile(file, "x".repeat(240), "utf8");
    const tool = createFileReadTool({
      allowedPaths: [root],
      maxTokens: 100,
    });

    const result = await tool.execute({ file_path: file });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("File content (120 tokens)");
  });

  test("rejects an unreadable path with plain-text error", async () => {
    const tool = createFileReadTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: join(root, "does-not-exist.txt"),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not exist");
    expect(() => JSON.parse(result.content)).toThrow();
  });

  test("records the read in session state when sessionId is provided", async () => {
    const file = join(root, "logged.txt");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: file,
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBeUndefined();

    expect(hasSessionRead(sessionId, file)).toBe(true);
    const snap = getSessionReadSnapshot(sessionId, file);
    expect(snap?.viewKind).toBe("full");
    expect(snap?.content).toBe("one\ntwo\nthree\n");
    // Full reads carry raw bytes for the changed-files attachment producer.
    expect(snap?.rawContent).toBe("one\ntwo\nthree\n");
  });

  test("offset/limit produces a partial view + sets viewKind=partial", async () => {
    const file = join(root, "many-lines.txt");
    await writeFile(file, "a\nb\nc\nd\ne\nf\n", "utf8");
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: file,
      offset: 2,
      limit: 2,
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("2→b\n3→c");

    // User-initiated partial reads satisfy the read-before-write gate.
    expect(hasSessionRead(sessionId, file)).toBe(true);
    const snap = getSessionReadSnapshot(sessionId, file);
    expect(snap?.viewKind).toBe("partial");
    expect(snap?.isPartialView).not.toBe(true);
    expect(snap?.readOffset).toBe(2);
    expect(snap?.readLimit).toBe(2);
    // Partial reads do not anchor the changed-files diff — there is no
    // full-file content to diff against — so rawContent stays unset.
    expect(snap?.rawContent).toBeUndefined();
  });

  test("reads the active session plan file outside the workspace root", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-plan-read-home-"));
    try {
      setPlanSlug({ agencHome, sessionId }, "ivory-bridge-aaed0227");
      const planPath = getPlanFilePath({ agencHome, sessionId });
      await writeFile(planPath, "# Plan\n\n- [ ] Verify tool allowlist\n", "utf8");
      const tool = createFileReadTool({ allowedPaths: [root] });

      const result = await tool.execute({
        file_path: planPath,
        __agencSessionId: sessionId,
        [SESSION_AGENC_HOME_ARG]: agencHome,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Verify tool allowlist");
      expect(hasSessionRead(sessionId, planPath)).toBe(true);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  test("image read returns contentItems with input_image", async () => {
    const file = join(root, "tiny.png");
    // Smallest valid PNG header bytes (1×1 transparent pixel).
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    await writeFile(file, png);
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({ file_path: file });
    expect(result.isError).toBeUndefined();
    expect(result.contentItems).toBeDefined();
    expect(result.contentItems?.length).toBe(2);
    const imageItem = result.contentItems?.find(
      (item) => item.type === "input_image",
    );
    expect(imageItem).toBeDefined();
    if (imageItem && imageItem.type === "input_image") {
      expect(imageItem.image_url.startsWith("data:image/png;base64,")).toBe(
        true,
      );
    }
    expect(result.metadata?.mediaType).toBe("image/png");
  });

  test("binary file (non-image, non-PDF) returns an error", async () => {
    const file = join(root, "bundle.zip");
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({ file_path: file });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cannot read binary files");
  });

  test("rejects paths outside allowedPaths", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-file-read-other-"));
    try {
      const file = join(otherRoot, "leaked.txt");
      await writeFile(file, "secret", "utf8");
      const tool = createFileReadTool({ allowedPaths: [root] });

      const result = await tool.execute({ file_path: file });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Access denied");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  async function installFakePoppler(
    pages: number,
    text = "PDF title\nPDF body",
  ): Promise<void> {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const pdfinfo = join(bin, "pdfinfo");
    const pdftotext = join(bin, "pdftotext");
    await writeFile(
      pdfinfo,
      `#!/bin/sh\nprintf 'Title: fake\\nPages: ${pages}\\n'\n`,
      "utf8",
    );
    await writeFile(
      pdftotext,
      `#!/bin/sh\ncat <<'EOF'\n${text}\nEOF\n`,
      "utf8",
    );
    await chmod(pdfinfo, 0o755);
    await chmod(pdftotext, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
  }

  test("PDF reads extract text through poppler and honor page ranges", async () => {
    const file = join(root, "doc.pdf");
    await writeFile(file, "%PDF-1.4\n", "utf8");
    await installFakePoppler(2, "First page\nSecond page");
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({ file_path: file, pages: "1-2" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Read PDF");
    expect(result.content).toContain("First page");
    expect(result.metadata?.mediaType).toBe("application/pdf");
    expect(result.metadata?.isPartial).toBe(true);
  });

  test("large PDFs require an explicit page range", async () => {
    const file = join(root, "large.pdf");
    await writeFile(file, "%PDF-1.4\n", "utf8");
    await installFakePoppler(12);
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({ file_path: file });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Provide the pages parameter");
  });

  test("text file with embedded null bytes is rejected as binary", async () => {
    const file = join(root, "weird.txt");
    await writeFile(file, Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]));
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({ file_path: file });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cannot read binary files");
  });
});
