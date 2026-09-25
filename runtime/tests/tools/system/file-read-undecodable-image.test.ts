import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelFacingTools } from "../../../src/bin/model-facing-tools.js";
import { runAdmittedToolCall } from "../../../src/budget/admitted-tool-call.js";
import { buildToolRegistry, type ToolRegistry } from "../../../src/tool-registry.js";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import type { Tool } from "../../../src/tools/types.js";
import { bindAdmittedToolHarness } from "../../helpers/admitted-tool-harness.js";

// 2026-09-22, Linux release-candidate test, session conv-mucyox5d: FileRead
// of a 16-byte fake.png (PNG signature plus the IHDR length and type) came
// back as an image. DeepSeek answered HTTP 400 "You have uploaded an
// unsupported image", and the tool result, replayed on every later request,
// failed every prompt after it within two seconds.
const FAKE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUg==", "base64");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-file-read-undecodable-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makePng(width: number, height: number): Promise<Buffer> {
  const sharpModule = await import("sharp");
  const sharp = (typeof sharpModule.default === "function"
    ? sharpModule.default
    : sharpModule) as (typeof sharpModule)["default"];
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();
}

type ReadResult = {
  readonly isError?: boolean;
  readonly content: string;
  readonly contentItems?: ReadonlyArray<{ readonly type: string }>;
};

async function read(file: string): Promise<ReadResult> {
  const tool = createFileReadTool({ allowedPaths: [root] });
  return (await tool.execute({ file_path: file })) as ReadResult;
}

describe("FileRead never returns bytes that are not an image as an image", () => {
  it("returns a clear failed read for the 16-byte fake.png", async () => {
    const file = join(root, "fake.png");
    await writeFile(file, FAKE_PNG);

    const result = await read(file);

    expect(result.isError).toBe(true);
    expect(result.contentItems).toBeUndefined();
    expect(result.content).toBe(
      `${file} is not a valid PNG image, so it was not attached: ` +
        "the data ends before its header (IHDR) chunk is complete. " +
        "The file is 16B. Use a shell command such as xxd to inspect its bytes.",
    );
  });

  it("returns a clear failed read for a PNG cut off inside its image data", async () => {
    const image = await makePng(64, 64);
    const file = join(root, "partial.png");
    await writeFile(file, image.subarray(0, image.length - 20));

    const result = await read(file);

    expect(result.isError).toBe(true);
    expect(result.contentItems).toBeUndefined();
    expect(result.content).toContain("is not a valid PNG image, so it was not attached");
  });

  it("returns a clear failed read for text saved with an image extension", async () => {
    const file = join(root, "notes.jpg");
    await writeFile(file, "these are notes, not a photo\n");

    const result = await read(file);

    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining(
        "does not contain a PNG, JPEG, GIF or WebP image, so it was not attached",
      ),
    });
    expect(result.contentItems).toBeUndefined();
  });

  it("returns a clear failed read for a WebP with an empty animation frame", async () => {
    // Review finding: VP8X plus an empty ANMF chunk passed the container
    // check, sharp could not read it, and the fallback returned the bytes.
    const webp = Buffer.alloc(38);
    webp.write("RIFF", 0, "latin1");
    webp.writeUInt32LE(30, 4);
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8X", 12, "latin1");
    webp.writeUInt32LE(10, 16);
    webp.write("ANMF", 30, "latin1");
    webp.writeUInt32LE(0, 34);
    const file = join(root, "frame.webp");
    await writeFile(file, webp);

    const result = await read(file);

    expect(result.isError).toBe(true);
    expect(result.contentItems).toBeUndefined();
    expect(result.content).toContain("is not a valid WebP image, so it was not attached");
  });

  it("returns a clear failed read for an animated WebP with a damaged later frame", async () => {
    // Review finding: only the first frame was decoded, so a damaged second
    // frame went out as an image.
    const sharpModule = await import("sharp");
    const sharp = (typeof sharpModule.default === "function"
      ? sharpModule.default
      : sharpModule) as (typeof sharpModule)["default"];
    const frame = (red: number) =>
      sharp({
        create: { width: 16, height: 12, channels: 3, background: { r: red, g: 10, b: 10 } },
      }).png().toBuffer();
    const webp = await (sharp as unknown as (
      input: Buffer[],
      options: { join: { animated: boolean } },
    ) => ReturnType<typeof sharp>)([await frame(10), await frame(200)], {
      join: { animated: true },
    }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    const last = webp.lastIndexOf(Buffer.from("ANMF", "latin1"));
    const data = last + 8 + 16 + 8;
    const size = webp.readUInt32LE(last + 8 + 16 + 4);
    for (let index = data + 10; index < data + size; index += 1) {
      webp[index] = (index * 37 + 11) & 0xff;
    }
    const file = join(root, "animation.webp");
    await writeFile(file, webp);

    const result = await read(file);

    expect(result.isError).toBe(true);
    expect(result.contentItems).toBeUndefined();
    expect(result.content).toContain("is not a valid WebP image, so it was not attached");
  });

  it("still returns a valid image as an image", async () => {
    const file = join(root, "real.png");
    await writeFile(file, await makePng(32, 24));

    const result = await read(file);

    expect(result.isError).toBeUndefined();
    expect(result.contentItems?.map((item) => item.type)).toEqual([
      "input_text",
      "input_image",
    ]);
  });
});

describe("a failed image read settles as a read-only tool", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = buildToolRegistry({
      workspaceRoot: root,
      agencHome: root,
      modelFacingTools: createModelFacingTools({
        workspaceRoot: root,
        agencHome: root,
        env: {},
        getSession: () => null,
      }),
    });
  });

  function registeredTool(name: string): Tool {
    const tool = registry.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Missing production tool: ${name}`);
    return tool;
  }

  it("files no unknown effect, so a later mutation still runs", async () => {
    const { session, events, acquire } = bindAdmittedToolHarness({
      workspaceRoot: root,
      label: "undecodable-image",
    });
    const fakePath = join(root, "fake.png");
    await writeFile(fakePath, FAKE_PNG);
    const liveRegistry = buildToolRegistry({
      workspaceRoot: root,
      agencHome: root,
      getSession: () => session,
      modelFacingTools: [],
    });

    const readResult = await liveRegistry.dispatchCodeModeNestedTool?.({
      id: "nested-fake-png",
      name: "FileRead",
      input: { file_path: fakePath },
    });

    expect(readResult).toMatchObject({
      isError: true,
      content: expect.stringContaining("is not a valid PNG image, so it was not attached"),
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(registeredTool("FileRead")).toMatchObject({
      isReadOnly: true,
      recoveryCategory: "idempotent",
    });

    const write = registeredTool("Write");
    const afterPath = join(root, "after.txt");
    const writeArgs = { file_path: afterPath, content: "written after the failed read" };
    const written = await runAdmittedToolCall({
      session,
      turnId: "turn-undecodable-image",
      callId: "write-after-failed-read",
      tool: write,
      args: writeArgs,
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return write.execute(writeArgs);
      },
    });

    expect(written.isError).not.toBe(true);
    expect(await readFile(afterPath, "utf8")).toBe("written after the failed read");
    expect(events.some((event) => event.msg.type === "effect_unknown_outcome")).toBe(false);
  });
});
