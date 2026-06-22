import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ToolEvaluatorContext } from "../../permissions/evaluator.js";
import { applyPermissionUpdate } from "../../permissions/rules.js";
import { createEmptyToolPermissionContext } from "../../permissions/types.js";
import { createFileReadTool, FILE_READ_TOOL_NAME } from "./file-read.js";
import {
  clearSessionReadState,
  getSessionReadSnapshot,
  hasSessionRead,
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_AGENC_HOME_ARG,
  signSessionId,
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

  test("rejects agent namespace paths with a workspace-relative hint", async () => {
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: "/root/game.py",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("agent namespace");
    expect(String(result.content)).toContain('"game.py"');
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

  test("offset/limit can read a bounded slice from a file over the byte cap", async () => {
    const file = join(root, "large-slice.txt");
    const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`);
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
    const tool = createFileReadTool({
      allowedPaths: [root],
      maxTextBytes: 12,
    });

    const result = await tool.execute({
      file_path: file,
      offset: 10,
      limit: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("10→line-10");
  });

  test("offset without limit uses the default bounded window over the byte cap", async () => {
    const file = join(root, "large-offset-only.txt");
    const lines = Array.from({ length: 3000 }, () => "x");
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
    const tool = createFileReadTool({
      allowedPaths: [root],
      maxTextBytes: 5000,
    });

    const result = await tool.execute({
      file_path: file,
      offset: 10,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("10→x");
    expect(result.content).toContain("2009→x");
    expect(result.content).not.toContain("2010→x");
    expect(result.metadata?.numLines).toBe(2000);
  });

  test("rejects malformed offset and limit values", async () => {
    const file = join(root, "ranges.txt");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const tool = createFileReadTool({ allowedPaths: [root] });
    const invalidInputs: Array<Record<string, unknown>> = [
      { offset: 0 },
      { offset: -1 },
      { offset: 1.5 },
      { offset: "abc" },
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: "abc" },
    ];

    for (const invalidInput of invalidInputs) {
      const result = await tool.execute({ file_path: file, ...invalidInput });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/^(offset|limit) must be a positive integer$/);
    }
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

  test("reads notebook cells, outputs, and visualizations as a rendered view", async () => {
    const file = join(root, "demo.ipynb");
    await writeFile(
      file,
      JSON.stringify(
        {
          cells: [
            {
              id: "markdown-cell",
              cell_type: "markdown",
              source: ["# Title\n", "Notebook body\n"],
            },
            {
              id: "code-cell",
              cell_type: "code",
              execution_count: 3,
              source: ["print('hi')\n"],
              outputs: [
                {
                  output_type: "stream",
                  name: "stdout",
                  text: ["hi\n"],
                },
                {
                  output_type: "display_data",
                  data: {
                    "text/plain": ["<Figure size 640x480>\n"],
                    "image/png": "aW1hZ2UtYnl0ZXM=",
                  },
                  metadata: {},
                },
              ],
            },
          ],
          metadata: { language_info: { name: "python" } },
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        2,
      ),
      "utf8",
    );
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: file,
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1→Notebook:");
    expect(result.content).toContain("Cell 1 [markdown] id=markdown-cell");
    expect(result.content).toContain("Notebook body");
    expect(result.content).toContain(
      "Cell 2 [code] id=code-cell execution_count=3",
    );
    expect(result.content).toContain("print('hi')");
    expect(result.content).toContain("Output 1 [stream]:");
    expect(result.content).toContain("hi");
    expect(result.content).toContain("Image output 2 [image/png]");
    expect(result.content).not.toContain('"cells"');
    expect(result.metadata?.mediaType).toBe("application/x-ipynb+json");
    expect(result.metadata?.cellCount).toBe(2);

    const imageItem = result.contentItems?.find(
      (item) => item.type === "input_image",
    );
    expect(imageItem).toBeDefined();
    if (imageItem && imageItem.type === "input_image") {
      expect(imageItem.image_url).toBe(
        "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
      );
    }

    const snap = getSessionReadSnapshot(sessionId, file);
    expect(snap?.viewKind).toBe("full");
    expect(snap?.content).toContain("Cell 2 [code]");
    expect(snap?.rawContent).toContain('"cells"');
  });

  test("notebook image outputs use the image cap instead of the text-output cap", async () => {
    const file = join(root, "large-image.ipynb");
    const imageBase64 = Buffer.alloc(12 * 1024, 7).toString("base64");
    await writeFile(
      file,
      JSON.stringify({
        cells: [
          {
            id: "plot-cell",
            cell_type: "code",
            source: ["plot()\n"],
            outputs: [
              {
                output_type: "display_data",
                data: { "image/png": imageBase64 },
                metadata: {},
              },
            ],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const tool = createFileReadTool({
      allowedPaths: [root],
      maxImageBytes: 20 * 1024,
    });

    const result = await tool.execute({ file_path: file });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Image output 1 [image/png]");
    expect(result.content).not.toContain("Text outputs are too large");
    const imageItem = result.contentItems?.find(
      (item) => item.type === "input_image",
    );
    expect(imageItem).toBeDefined();
    if (imageItem && imageItem.type === "input_image") {
      expect(imageItem.image_url.startsWith("data:image/png;base64,")).toBe(
        true,
      );
      expect(imageItem.image_url).toContain(imageBase64);
    }
  });

  test("notebook image outputs accept array-valued MIME bundle data", async () => {
    const file = join(root, "array-image.ipynb");
    await writeFile(
      file,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: ["plot()\n"],
            outputs: [
              {
                output_type: "display_data",
                data: { "image/png": ["aW1h", "Z2Ut", "Ynl0ZXM="] },
                metadata: {},
              },
            ],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({ file_path: file });

    expect(result.isError).toBeUndefined();
    const imageItem = result.contentItems?.find(
      (item) => item.type === "input_image",
    );
    expect(imageItem).toBeDefined();
    if (imageItem && imageItem.type === "input_image") {
      expect(imageItem.image_url).toBe(
        "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
      );
    }
  });

  test("offset/limit slices notebook rendered lines and records a partial view", async () => {
    const file = join(root, "partial.ipynb");
    await writeFile(
      file,
      JSON.stringify({
        cells: [
          {
            id: "markdown-cell",
            cell_type: "markdown",
            source: ["# Title\n", "Notebook body\n"],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: file,
      offset: 5,
      limit: 3,
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("5→Cell 1 [markdown] id=markdown-cell");
    expect(result.content).toContain("6→Source:");
    expect(result.content).toContain("7→# Title");
    expect(result.content).not.toContain("Notebook body");
    const snap = getSessionReadSnapshot(sessionId, file);
    expect(snap?.viewKind).toBe("partial");
    expect(snap?.readOffset).toBe(5);
    expect(snap?.readLimit).toBe(3);
    expect(snap?.rawContent).toBeUndefined();
  });

  test("returns a plain error for invalid notebook JSON", async () => {
    const file = join(root, "invalid.ipynb");
    await writeFile(file, "{ not json", "utf8");
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({ file_path: file });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid notebook JSON");
    expect(() => JSON.parse(result.content)).toThrow();
  });

  test("applies the token budget to rendered notebook content", async () => {
    const file = join(root, "too-large.ipynb");
    await writeFile(
      file,
      JSON.stringify({
        cells: [
          {
            cell_type: "markdown",
            source: ["abcd".repeat(120)],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const tool = createFileReadTool({ allowedPaths: [root], maxTokens: 20 });

    const result = await tool.execute({ file_path: file });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Notebook content");
    expect(result.content).toContain("exceeds maximum allowed tokens");
  });

  test("rejects notebooks over the raw parse cap even with offset/limit", async () => {
    const file = join(root, "raw-too-large.ipynb");
    await writeFile(
      file,
      JSON.stringify({
        cells: [
          {
            cell_type: "markdown",
            source: ["x".repeat(512)],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const tool = createFileReadTool({
      allowedPaths: [root],
      maxNotebookBytes: 64,
    });

    for (const args of [{}, { offset: 5, limit: 1 }]) {
      const result = await tool.execute({ file_path: file, ...args });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Notebook size");
      expect(result.content).toContain("exceeds the notebook-read limit");
    }
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
        __agencSessionIdSig: signSessionId(sessionId),
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

  test("executes an outside read when the permission layer approves that directory", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-file-read-approved-"));
    try {
      const file = join(otherRoot, "approved.txt");
      await writeFile(file, "approved secret\n", "utf8");
      const permissionContext = applyPermissionUpdate(
        createEmptyToolPermissionContext(),
        {
          type: "addRules",
          destination: "session",
          behavior: "allow",
          rules: [{ toolName: "FileRead", ruleContent: `${otherRoot}/**` }],
        },
      );
      const evaluatorContext = {
        getAppState() {
          return {
            toolPermissionContext: permissionContext,
            denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
            autoModeActive: false,
          };
        },
        session: {},
      } as ToolEvaluatorContext;
      const tool = createFileReadTool({ allowedPaths: [root] });
      const permission = tool.checkPermissions?.(
        { file_path: file, cwd: root },
        evaluatorContext,
      );

      expect(permission?.behavior).toBe("allow");
      if (!permission || permission.behavior !== "allow") {
        throw new Error("expected permission allow");
      }
      const result = await tool.execute(permission.updatedInput ?? {});

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("1→approved secret");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("outside-path ask carries a transient root for approved execution", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-file-read-other-"));
    try {
      const file = join(otherRoot, "approved-once.txt");
      await writeFile(file, "approved once\n", "utf8");
      const permissionContext = createEmptyToolPermissionContext();
      const evaluatorContext = {
        getAppState() {
          return {
            toolPermissionContext: permissionContext,
            denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
            autoModeActive: false,
          };
        },
        session: {},
      } as ToolEvaluatorContext;
      const tool = createFileReadTool({ allowedPaths: [root] });
      const permission = tool.checkPermissions?.(
        { file_path: file, cwd: root },
        evaluatorContext,
      );

      expect(permission?.behavior).toBe("ask");
      if (!permission || permission.behavior !== "ask") {
        throw new Error("expected permission ask");
      }
      expect(permission.updatedInput?.[SESSION_ALLOWED_ROOTS_ARG]).toContain(
        otherRoot,
      );

      const result = await tool.execute(permission.updatedInput ?? {});

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("1→approved once");
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
    expect(result.content).toContain("1→First page");
    expect(result.content).toContain("2→Second page");
    expect(result.metadata?.mediaType).toBe("application/pdf");
    expect(result.metadata?.isPartial).toBe(true);
    expect(result.metadata?.startLine).toBe(1);
    expect(result.metadata?.numLines).toBe(2);
  });

  test("PDF offset/limit slices extracted text and records a partial view", async () => {
    const file = join(root, "doc-slice.pdf");
    await writeFile(file, "%PDF-1.4\n", "utf8");
    await installFakePoppler(2, "one\ntwo\nthree\nfour");
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: file,
      pages: "1-2",
      offset: 2,
      limit: 2,
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("2→two");
    expect(result.content).toContain("3→three");
    expect(result.content).not.toContain("1→one");
    expect(result.content).not.toContain("4→four");
    expect(result.metadata?.startLine).toBe(2);
    expect(result.metadata?.numLines).toBe(2);
    expect(result.metadata?.isPartial).toBe(true);
    const snap = getSessionReadSnapshot(sessionId, file);
    expect(snap?.viewKind).toBe("partial");
    expect(snap?.readOffset).toBe(2);
    expect(snap?.readLimit).toBe(2);
    expect(snap?.rawContent).toBeUndefined();
  });

  test("PDF page ranges reject malformed page specs", async () => {
    const file = join(root, "malformed-pages.pdf");
    await writeFile(file, "%PDF-1.4\n", "utf8");
    const tool = createFileReadTool({ allowedPaths: [root] });
    const badPages = [
      "",
      "0",
      "0-1",
      "2-1",
      "1abc",
      "1-2abc",
      "1-2-3",
      "1--2",
    ];

    for (const pages of badPages) {
      const result = await tool.execute({ file_path: file, pages });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/PDF page range|pages must be/);
    }
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
