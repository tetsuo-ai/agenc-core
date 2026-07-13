import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileReadTool } from "../../../src/tools/system/file-read.js";

// M-FILE-2 (core-todo.md): readImageFile base64-encoded the raw file with no
// downsample/dimension clamp, so a screenshot over ~3.7MB or a small-but-over-1568px
// PNG produced a payload the provider rejects with a 400 on the common "read this
// screenshot" path. Fixed by routing through maybeResizeAndDownsampleImageBuffer
// (mirroring BashTool). Provider limit is IMAGE_MAX_WIDTH/HEIGHT = 1568px.

const IMAGE_MAX_DIMENSION = 1568;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-file-read-img-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makePng(width: number, height: number): Promise<Buffer> {
  const sharpModule = await import("sharp");
  const sharp = (typeof sharpModule.default === "function"
    ? sharpModule.default
    : sharpModule) as (typeof sharpModule)["default"];
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 50, b: 50 },
    },
  })
    .png()
    .toBuffer();
}

async function imageWidth(buffer: Buffer): Promise<number> {
  const sharpModule = await import("sharp");
  const sharp = (typeof sharpModule.default === "function"
    ? sharpModule.default
    : sharpModule) as (typeof sharpModule)["default"];
  const meta = await sharp(buffer).metadata();
  return meta.width ?? 0;
}

function emittedImageBase64(result: {
  contentItems?: Array<{ type: string; image_url?: string }>;
}): string | undefined {
  const item = result.contentItems?.find((c) => c.type === "input_image");
  const url = item?.image_url;
  if (!url) return undefined;
  const comma = url.indexOf(",");
  return comma >= 0 ? url.slice(comma + 1) : undefined;
}

describe("FileRead image resize — M-FILE-2", () => {
  it("downsamples an over-1568px image before emitting it", async () => {
    const file = join(root, "huge.png");
    await writeFile(file, await makePng(2400, 1800));

    const tool = createFileReadTool({ allowedPaths: [root] });
    const result = (await tool.execute({ file_path: file })) as {
      isError?: boolean;
      contentItems?: Array<{ type: string; image_url?: string }>;
    };

    expect(result.isError).toBeUndefined();
    const base64 = emittedImageBase64(result);
    expect(base64).toBeTruthy();
    const width = await imageWidth(Buffer.from(base64!, "base64"));
    // Pre-fix: the raw 2400px image was emitted verbatim (would 400 the API).
    expect(width).toBeLessThanOrEqual(IMAGE_MAX_DIMENSION);
  });

  it("leaves a small in-limit image effectively unchanged", async () => {
    const file = join(root, "small.png");
    await writeFile(file, await makePng(64, 64));

    const tool = createFileReadTool({ allowedPaths: [root] });
    const result = (await tool.execute({ file_path: file })) as {
      isError?: boolean;
      contentItems?: Array<{ type: string; image_url?: string }>;
    };

    expect(result.isError).toBeUndefined();
    const base64 = emittedImageBase64(result);
    expect(base64).toBeTruthy();
    const width = await imageWidth(Buffer.from(base64!, "base64"));
    expect(width).toBe(64);
  });
});
