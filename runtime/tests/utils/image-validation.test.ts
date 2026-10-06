import { crc32 } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectImageBytes,
  inspectImageDataUrl,
} from "../../src/utils/image-validation.js";
import {
  maybeResizeAndDownsampleImageBuffer,
  UndecodableImageError,
} from "../../src/utils/imageResizer.js";

// The file behind the 2026-09-22 session failure (conv-mucyox5d): a PNG
// signature followed by the IHDR length and type, and nothing else. DeepSeek
// answered "You have uploaded an unsupported image" and every later prompt
// in that session failed the same way.
const FAKE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";
const fakePng = (): Buffer => Buffer.from(FAKE_PNG_BASE64, "base64");

// Review finding: a 38-byte WebP whose VP8X header is followed by an empty
// ANMF chunk passed the container check, while sharp rejects it as corrupt.
function emptyFrameWebp(): Buffer {
  const bytes = Buffer.alloc(38);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(30, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1");
  bytes.writeUInt32LE(10, 16);
  bytes.write("ANMF", 30, "latin1");
  bytes.writeUInt32LE(0, 34);
  return bytes;
}

/**
 * A PNG whose every chunk and checksum is intact but whose compressed pixel
 * data is garbage: only a real decode can tell.
 */
function corruptPixelsPng(png: Buffer): Buffer {
  const out = Buffer.from(png);
  let offset = 8;
  while (offset + 12 <= out.length) {
    const length = out.readUInt32BE(offset);
    if (out.toString("latin1", offset + 4, offset + 8) === "IDAT") {
      for (let index = 0; index < length; index += 1) {
        out[offset + 8 + index] = (index * 37 + 11) & 0xff;
      }
      out.writeUInt32BE(
        crc32(out.subarray(offset + 4, offset + 8 + length)) >>> 0,
        offset + 8 + length,
      );
      return out;
    }
    offset += 12 + length;
  }
  throw new Error("PNG has no IDAT chunk");
}

async function animated(format: "webp" | "gif"): Promise<Buffer> {
  const sharp = await sharpModule();
  const frame = (red: number) =>
    sharp({
      create: { width: 16, height: 12, channels: 3, background: { r: red, g: 10, b: 10 } },
    }).png().toBuffer();
  const frames = [await frame(10), await frame(200)];
  const joined = (sharp as unknown as (
    input: Buffer[],
    options: { join: { animated: boolean } },
  ) => ReturnType<typeof sharp>)(frames, { join: { animated: true } });
  return format === "webp"
    ? joined.webp({ loop: 0, delay: [100, 100] }).toBuffer()
    : joined.gif({ loop: 0, delay: [100, 100] }).toBuffer();
}

/**
 * The animation with the bitstream of its last frame overwritten after its
 * header: every chunk bound and frame header is intact, the first frame
 * decodes, and only decoding the last frame fails.
 */
function damageLastWebpFrame(webp: Buffer): Buffer {
  const out = Buffer.from(webp);
  const frame = out.lastIndexOf(Buffer.from("ANMF", "latin1"));
  // ANMF header (8), frame header (16), then the frame's VP8 chunk header (8).
  const data = frame + 8 + 16 + 8;
  const size = out.readUInt32LE(frame + 8 + 16 + 4);
  for (let index = data + 10; index < data + size; index += 1) {
    out[index] = (index * 37 + 11) & 0xff;
  }
  return out;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * An animated PNG (APNG) whose default image is intact and whose second
 * frame (fdAT) is garbage. The APNG frame chunks are ancillary, so a PNG
 * decoder that shows only the default image never reads them.
 */
function apngWithDamagedFrame(png: Buffer): Buffer {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const control = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(width, 4);
    data.writeUInt32BE(height, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return pngChunk("fcTL", data);
  };
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  const frameData = Buffer.alloc(40, 0xa5);
  frameData.writeUInt32BE(2, 0);
  const ihdrEnd = 8 + 25;
  const iendStart = png.length - 12;
  return Buffer.concat([
    png.subarray(0, ihdrEnd),
    pngChunk("acTL", animation),
    control(0),
    png.subarray(ihdrEnd, iendStart),
    control(1),
    pngChunk("fdAT", frameData),
    png.subarray(iendStart),
  ]);
}

/** A PNG whose animation chunks follow its image data, the order a strict APNG reader would reject. */
function apngChunksAfterImageData(png: Buffer): Buffer {
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  const frameData = Buffer.alloc(40, 0xa5);
  frameData.writeUInt32BE(2, 0);
  const iendStart = png.length - 12;
  return Buffer.concat([
    png.subarray(0, iendStart),
    pngChunk("acTL", animation),
    pngChunk("fdAT", frameData),
    png.subarray(iendStart),
  ]);
}

async function sharpModule() {
  const imported = await import("sharp");
  return (typeof imported.default === "function"
    ? imported.default
    : imported) as (typeof imported)["default"];
}

async function makeImage(
  format: "png" | "jpeg" | "gif" | "webp",
  width = 40,
  height = 30,
): Promise<Buffer> {
  const sharp = await sharpModule();
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 140, b: 90 } },
  })[format]()
    .toBuffer();
}

afterEach(() => {
  vi.doUnmock("../../src/tools/FileReadTool/imageProcessor.js");
  vi.resetModules();
});

describe("inspectImageBytes", () => {
  it("rejects the 16-byte fake.png that poisoned the DeepSeek session", () => {
    expect(fakePng().length).toBe(16);
    expect(inspectImageBytes(fakePng())).toEqual({
      ok: false,
      format: "png",
      reason: "the data ends before its header (IHDR) chunk is complete",
    });
  });

  it.each(["png", "jpeg", "gif", "webp"] as const)(
    "accepts a complete %s image and reports its size",
    async (format) => {
      expect(inspectImageBytes(await makeImage(format))).toEqual({
        ok: true,
        format,
        mediaType: `image/${format}`,
        width: 40,
        height: 30,
      });
    },
  );

  it.each(["png", "jpeg", "gif", "webp"] as const)(
    "rejects a %s image cut off inside its data",
    async (format) => {
      const image = await makeImage(format);
      const cut = inspectImageBytes(image.subarray(0, Math.floor(image.length * 0.7)));
      expect(cut).toMatchObject({ ok: false, format });
    },
  );

  it.each(["png", "jpeg", "webp"] as const)(
    "rejects a %s image missing only its last byte",
    async (format) => {
      const image = await makeImage(format);
      expect(inspectImageBytes(image.subarray(0, image.length - 1))).toMatchObject({
        ok: false,
        format,
      });
    },
  );

  it("rejects bytes with no image signature and names no format", () => {
    expect(inspectImageBytes(Buffer.from("not an image at all"))).toEqual({
      ok: false,
      reason: "the data does not start with a PNG, JPEG, GIF or WebP signature",
    });
    expect(inspectImageBytes(Buffer.alloc(0))).toEqual({
      ok: false,
      reason: "the data is empty",
    });
  });

  it("rejects a WebP without a real frame and accepts real animations", async () => {
    expect(inspectImageBytes(emptyFrameWebp())).toMatchObject({
      ok: false,
      format: "webp",
    });
    for (const format of ["webp", "gif"] as const) {
      expect(inspectImageBytes(await animated(format))).toEqual({
        ok: true,
        format,
        mediaType: `image/${format}`,
        width: 16,
        height: 12,
      });
    }
  });

  it("rejects a PNG whose header chunk is corrupt", async () => {
    const image = Buffer.from(await makeImage("png"));
    image[17] ^= 0xff; // width byte inside IHDR; the chunk CRC no longer matches
    expect(inspectImageBytes(image)).toEqual({
      ok: false,
      format: "png",
      reason: "the header (IHDR) chunk is corrupt",
    });
  });
});

describe("inspectImageDataUrl", () => {
  it("decodes and checks inline images", async () => {
    const png = await makeImage("png");
    expect(inspectImageDataUrl(`data:image/png;base64,${png.toString("base64")}`))
      .toMatchObject({ ok: true, format: "png" });
    expect(inspectImageDataUrl(`data:image/png;base64,${FAKE_PNG_BASE64}`))
      .toMatchObject({ ok: false, format: "png" });
    expect(inspectImageDataUrl("data:image/png;base64,***"))
      .toEqual({ ok: false, reason: "the data URL does not carry valid base64 data" });
  });

  it("leaves remote images to the provider", () => {
    expect(inspectImageDataUrl("https://example.test/cat.png")).toBeUndefined();
  });
});

describe("maybeResizeAndDownsampleImageBuffer", () => {
  it("rejects an animation whose decoded frames exceed the pixel budget before decoding", async () => {
    const decode = vi.fn(async () => Buffer.alloc(0));
    vi.resetModules();
    vi.doMock("../../src/tools/FileReadTool/imageProcessor.js", () => ({
      getImageProcessor: async () => () => ({
        metadata: async () => ({ width: 1500, height: 1500, pages: 100, format: "gif" }),
        raw: () => ({ toBuffer: decode }),
        toBuffer: decode,
      }),
    }));
    const resizer = await import("../../src/utils/imageResizer.js");
    const image = await makeImage("png", 2, 2);
    await expect(
      resizer.maybeResizeAndDownsampleImageBuffer(image, image.length, "gif"),
    ).rejects.toThrow(/decoded.*pixel.*budget/iu);
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses the fake PNG instead of passing its bytes through", async () => {
    // Sharp throws "Input buffer has corrupt header" for these bytes. The
    // fallback used to return them unchanged because they are under 5 MB.
    const result = maybeResizeAndDownsampleImageBuffer(fakePng(), 16, "png");
    await expect(result).rejects.toBeInstanceOf(UndecodableImageError);
    await expect(
      maybeResizeAndDownsampleImageBuffer(fakePng(), 16, "png"),
    ).rejects.toThrow(
      "Not a valid PNG image: the data ends before its header (IHDR) chunk is complete.",
    );
  });

  it("refuses a PNG whose header sharp can read but whose data is cut off", async () => {
    const image = await makeImage("png", 64, 64);
    const truncated = image.subarray(0, image.length - 20);
    const sharp = await sharpModule();
    // Sharp reads only the header here, so the in-limit path used to return
    // the truncated bytes as they were.
    await expect(sharp(truncated).metadata()).resolves.toMatchObject({ width: 64 });
    await expect(
      maybeResizeAndDownsampleImageBuffer(truncated, truncated.length, "png"),
    ).rejects.toBeInstanceOf(UndecodableImageError);
  });

  it("refuses bytes that only a full decode shows are broken", async () => {
    const sharp = await sharpModule();
    const corrupt = corruptPixelsPng(await makeImage("png", 32, 32));
    // Every chunk and checksum is intact and sharp reads the header, so both
    // the container check and the metadata read accept it.
    expect(inspectImageBytes(corrupt)).toMatchObject({ ok: true, format: "png" });
    await expect(sharp(corrupt).metadata()).resolves.toMatchObject({ width: 32 });
    await expect(
      maybeResizeAndDownsampleImageBuffer(corrupt, corrupt.length, "png"),
    ).rejects.toThrow("Not a valid PNG image: the image decoder could not read it");

    const webp = emptyFrameWebp();
    await expect(
      maybeResizeAndDownsampleImageBuffer(webp, webp.length, "webp"),
    ).rejects.toBeInstanceOf(UndecodableImageError);

    const animation = await animated("webp");
    await expect(
      maybeResizeAndDownsampleImageBuffer(animation, animation.length, "webp"),
    ).resolves.toMatchObject({ mediaType: "webp" });
  });

  it("refuses an animation whose later frame is damaged", async () => {
    // Review finding: sharp decodes only the first frame unless asked for
    // all of them, so a WebP whose second frame is garbage passed the full
    // decode and went out as the original bytes.
    const sharp = await sharpModule();
    const damaged = damageLastWebpFrame(await animated("webp"));
    expect(inspectImageBytes(damaged)).toMatchObject({ ok: true, format: "webp" });
    await expect(sharp(damaged).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    await expect(
      maybeResizeAndDownsampleImageBuffer(damaged, damaged.length, "webp"),
    ).rejects.toThrow("Not a valid WebP image: the image decoder could not read it");

    // A GIF decoder scans every frame before the first one, so a damaged
    // later GIF frame is refused too.
    const gif = await animated("gif");
    const descriptor = gif.lastIndexOf(0x2c);
    const damagedGif = Buffer.from(gif);
    damagedGif.fill(0x5a, descriptor + 11, damagedGif.length - 2);
    await expect(
      maybeResizeAndDownsampleImageBuffer(damagedGif, damagedGif.length, "gif"),
    ).rejects.toBeInstanceOf(UndecodableImageError);

    // An intact animation still passes unchanged, every frame included.
    const intact = await animated("webp");
    const resized = await maybeResizeAndDownsampleImageBuffer(intact, intact.length, "webp");
    expect(resized.buffer.equals(intact)).toBe(true);
  });

  it("hands on only the decoded image when a PNG carries bytes no decoder reads", async () => {
    const png = await makeImage("png", 20, 10);
    const late = apngChunksAfterImageData(png);
    expect(inspectImageBytes(late)).toMatchObject({ ok: true, format: "png" });
    const lateOut = await maybeResizeAndDownsampleImageBuffer(late, late.length, "png");
    expect(lateOut.buffer.includes(Buffer.from("fdAT", "latin1"))).toBe(false);
    expect(lateOut.buffer.includes(Buffer.from("acTL", "latin1"))).toBe(false);
    const trailing = Buffer.concat([png, Buffer.from("TRAILING-PAYLOAD", "latin1")]);
    const trailingOut = await maybeResizeAndDownsampleImageBuffer(trailing, trailing.length, "png");
    expect(trailingOut.buffer.includes(Buffer.from("TRAILING-PAYLOAD", "latin1"))).toBe(false);
    expect(inspectImageBytes(trailingOut.buffer)).toMatchObject({ ok: true, width: 20, height: 10 });
    // An ordinary PNG still passes through unchanged.
    const plain = await maybeResizeAndDownsampleImageBuffer(png, png.length, "png");
    expect(plain.buffer.equals(png)).toBe(true);
  });

  it("hands on only the decoded image of an animated PNG", async () => {
    // No PNG decoder here reads APNG frames, so none can vouch for them:
    // the default image is decoded and encoded again, and the frames that
    // could not be checked are left behind.
    const sharp = await sharpModule();
    const apng = apngWithDamagedFrame(await makeImage("png", 20, 10));
    expect(inspectImageBytes(apng)).toMatchObject({ ok: true, format: "png" });
    const resized = await maybeResizeAndDownsampleImageBuffer(apng, apng.length, "png");
    expect(resized.mediaType).toBe("png");
    expect(resized.buffer.includes(Buffer.from("fdAT", "latin1"))).toBe(false);
    expect(resized.buffer.includes(Buffer.from("acTL", "latin1"))).toBe(false);
    expect(inspectImageBytes(resized.buffer)).toMatchObject({ ok: true, width: 20, height: 10 });
    await expect(sharp(resized.buffer).metadata()).resolves.toMatchObject({ width: 20, height: 10 });
  });

  it("returns a valid in-limit image unchanged", async () => {
    const image = await makeImage("png", 64, 48);
    const resized = await maybeResizeAndDownsampleImageBuffer(image, image.length, "png");
    expect(resized.buffer.equals(image)).toBe(true);
    expect(resized.mediaType).toBe("png");
  });

  it("without an image decoder, passes nothing through", async () => {
    // Nothing can show the bytes are an image, so none are handed on.
    vi.resetModules();
    vi.doMock("../../src/tools/FileReadTool/imageProcessor.js", () => ({
      getImageProcessor: async () => {
        throw new Error("No image processor available (sharp is not installed)");
      },
    }));
    const resizer = await import("../../src/utils/imageResizer.js");
    const image = await makeImage("jpeg", 32, 32);
    await expect(
      resizer.maybeResizeAndDownsampleImageBuffer(image, image.length, "jpg"),
    ).rejects.toThrow(
      "No image decoder is available (sharp is not installed), so the image cannot be checked.",
    );
    await expect(
      resizer.maybeResizeAndDownsampleImageBuffer(fakePng(), 16, "png"),
    ).rejects.toBeInstanceOf(resizer.ImageDecoderUnavailableError);
  });
});
