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

/** A 960x600 gradient with fine noise and the given alpha per pixel. */
async function rgbaPng(alpha: (x: number) => number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const width = 960;
  const height = 600;
  const pixels = Buffer.alloc(width * height * 4);
  let seed = 17;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels[offset + channel] = (x / 8 + channel * 40 + (seed >>> 28)) & 255;
      }
      pixels[offset + 3] = alpha(x);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function readEmittedImage(file: string): Promise<{ mediaType: string; bytes: Buffer }> {
  const result = await createFileReadTool({ allowedPaths: [root] }).execute({ file_path: file });
  const url = (result as { contentItems?: Array<{ type: string; image_url?: string }> }).contentItems
    ?.find((item) => item.type === "input_image")?.image_url;
  expect(url).toBeTruthy();
  return { mediaType: url!.slice("data:".length, url!.indexOf(";")), bytes: Buffer.from(url!.slice(url!.indexOf(",") + 1), "base64") };
}

it("normalizes an opaque image that carries an alpha channel, as native macOS screenshots do", async () => {
  const sharp = (await import("sharp")).default;
  const original = await rgbaPng(() => 255);
  expect(original.length).toBeGreaterThan(64 * 1024);
  expect((await sharp(original).metadata()).hasAlpha).toBe(true);
  const file = join(root, "macos-screenshot.png");
  await writeFile(file, original);
  const emitted = await readEmittedImage(file);
  expect(emitted.mediaType).toBe("image/jpeg");
  expect(emitted.bytes.length).toBeLessThan(original.length / 4);
  const metadata = await sharp(emitted.bytes).metadata();
  expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([960, 600, false]);
});

it("keeps a transparent image above the size threshold as its lossless PNG", async () => {
  const sharp = (await import("sharp")).default;
  // The left half is fully transparent; JPEG would show its stored colors.
  const original = await rgbaPng((x) => (x < 480 ? 0 : 255));
  expect(original.length).toBeGreaterThan(64 * 1024);
  const file = join(root, "overlay.png");
  await writeFile(file, original);
  const emitted = await readEmittedImage(file);
  expect(emitted.mediaType).toBe("image/png");
  expect(emitted.bytes.equals(original)).toBe(true);
  const stats = await sharp(emitted.bytes).stats();
  expect([stats.isOpaque, stats.channels[3]?.min]).toEqual([false, 0]);
});

it.each(["webp", "gif"] as const)("does not flatten an animated %s above the size threshold to its first frame", async (format) => {
  const sharp = (await import("sharp")).default;
  const width = 320;
  const height = 240;
  const frames = 4;
  const pixels = Buffer.alloc(width * height * frames * 3);
  let seed = 9;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const strip = sharp(pixels, { raw: { width, height: height * frames, channels: 3, pageHeight: height } });
  const original = await (format === "webp" ? strip.webp({ quality: 90 }) : strip.gif()).toBuffer();
  expect(original.length).toBeGreaterThan(64 * 1024);
  expect((await sharp(original).metadata()).pages).toBe(frames);
  const file = join(root, `animation.${format}`);
  await writeFile(file, original);
  const emitted = await readEmittedImage(file);
  expect(emitted.mediaType).toBe(`image/${format}`);
  expect(emitted.bytes.equals(original)).toBe(true);
});
