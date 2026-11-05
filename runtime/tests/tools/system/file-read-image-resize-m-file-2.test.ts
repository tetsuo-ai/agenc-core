import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileReadTool } from "../../../src/tools/system/file-read.js";

// M-FILE-2: readImageFile base64-encoded the raw file with no
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


it("normalizes a detailed screenshot once before creating the tool result", async () => {
  const sharp = (await import("sharp")).default;
  const pixels = Buffer.alloc(1920 * 1080 * 3);
  let seed = 17;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = ((Math.floor(i / 3) % 1920) / 8 + (seed >>> 28)) & 255;
  }
  const original = await sharp(pixels, { raw: { width: 1920, height: 1080, channels: 3 } }).png().toBuffer();
  const file = join(root, "screenshot.png");
  await writeFile(file, original);
  const tool = createFileReadTool({ allowedPaths: [root] });
  const result = await tool.execute({ file_path: file });
  const encoded = emittedImageBase64(result as { contentItems?: Array<{ type: string; image_url?: string }> });
  expect(encoded).toBeTruthy();
  const normalized = Buffer.from(encoded!, "base64");
  expect(normalized.length).toBeLessThan(300_000);
  expect((await sharp(normalized).metadata()).width).toBeLessThanOrEqual(1568);
});

it("preserves display orientation when normalizing an in-limit photo", async () => {
  const sharp = (await import("sharp")).default;
  const pixels = Buffer.alloc(960 * 600 * 3);
  let seed = 71;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const original = await sharp(pixels, { raw: { width: 960, height: 600, channels: 3 } })
    .withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
  const file = join(root, "rotated.jpg");
  await writeFile(file, original);
  const result = await createFileReadTool({ allowedPaths: [root] }).execute({ file_path: file });
  const encoded = emittedImageBase64(result as { contentItems?: Array<{ type: string; image_url?: string }> });
  expect(encoded).toBeTruthy();
  expect((await sharp(Buffer.from(encoded!, "base64")).metadata()).orientation).toBe(6);
});
