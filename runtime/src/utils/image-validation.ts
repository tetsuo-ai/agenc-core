/**
 * Structural validation for the image formats that model providers accept
 * inline: PNG, JPEG, GIF and WebP.
 *
 * A provider decodes every image it receives. Bytes that only look like an
 * image (a PNG signature with nothing after it, a JPEG cut off mid-scan, a
 * file with an image extension that holds something else) are rejected with
 * an HTTP 400, and because tool results are replayed on every later request,
 * one such image fails every turn that follows. This module decides, without
 * any native image library, whether bytes form a complete image container:
 * the headers parse, the declared chunk and segment lengths stay inside the
 * data, the image has a non-zero size, and the stream reaches its end marker.
 * It does not decode pixels, so an intact container can still carry corrupt
 * compressed data. The image resizer therefore also decodes any bytes it
 * hands on unchanged; the query projection, which cannot afford a decode on
 * every request, uses this check as a filter and leaves the rest to the turn
 * loop's recovery from a provider refusal.
 *
 * @module
 */

import * as zlib from "node:zlib";

export type InlineImageFormat = "png" | "jpeg" | "gif" | "webp";

export type ImageInspection =
  | {
      readonly ok: true;
      readonly format: InlineImageFormat;
      readonly mediaType: `image/${InlineImageFormat}`;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly ok: false;
      /** Format named by the signature, when the data has a known one. */
      readonly format?: InlineImageFormat;
      /** Lower-case clause that explains the defect, for user-facing text. */
      readonly reason: string;
    };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const FORMAT_LABELS: Readonly<Record<InlineImageFormat, string>> = {
  png: "PNG",
  jpeg: "JPEG",
  gif: "GIF",
  webp: "WebP",
};

/** Display name of a format: PNG, JPEG, GIF or WebP. */
export function imageFormatLabel(format: InlineImageFormat): string {
  return FORMAT_LABELS[format];
}

/** Display name for a media type such as `image/png`, or the type itself. */
export function imageMediaTypeLabel(mediaType: string): string {
  const subtype = mediaType.trim().toLowerCase().replace(/^image\//u, "");
  const format = subtype === "jpg" ? "jpeg" : subtype;
  return Object.hasOwn(FORMAT_LABELS, format)
    ? FORMAT_LABELS[format as InlineImageFormat]
    : mediaType;
}

/** Detect the container format from its signature bytes. */
export function detectInlineImageFormat(
  bytes: Uint8Array,
): InlineImageFormat | undefined {
  if (
    bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 6 &&
    ascii(bytes, 0, 3) === "GIF" &&
    (ascii(bytes, 3, 6) === "87a" || ascii(bytes, 3, 6) === "89a")
  ) {
    return "gif";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

/**
 * Validate that `bytes` hold one complete PNG, JPEG, GIF or WebP image.
 * The format comes from the signature, never from a file name or a declared
 * media type.
 */
export function inspectImageBytes(bytes: Uint8Array): ImageInspection {
  if (bytes.length === 0) return invalid(undefined, "the data is empty");
  const format = detectInlineImageFormat(bytes);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (format) {
    case "png":
      return inspectPng(view);
    case "jpeg":
      return inspectJpeg(view);
    case "gif":
      return inspectGif(view);
    case "webp":
      return inspectWebp(view);
    default:
      return invalid(
        undefined,
        "the data does not start with a PNG, JPEG, GIF or WebP signature",
      );
  }
}

/**
 * Whether a PNG carries bytes a still-image decoder never reads: APNG
 * animation chunks (acTL, fcTL, fdAT) anywhere before its end chunk, in any
 * order, or data after that end chunk. Nothing decodes those bytes, so such a
 * PNG is handed on as its decoded default image, never as the original bytes.
 */
export function pngHasUndecodedParts(bytes: Uint8Array): boolean {
  if (detectInlineImageFormat(bytes) !== "png") return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= view.length) {
    const type = ascii(view, offset + 4, offset + 8);
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return true;
    const next = offset + 12 + view.readUInt32BE(offset);
    if (type === "IEND") return next < view.length;
    offset = next;
  }
  return false;
}

/**
 * Validate the image carried by a `data:<type>;base64,<body>` URL. Returns
 * `undefined` for any other URL: a remote image is fetched by the provider
 * and cannot be checked here.
 */
export function inspectImageDataUrl(url: string): ImageInspection | undefined {
  const trimmed = url.trim();
  if (!/^data:/iu.test(trimmed)) return undefined;
  const comma = trimmed.indexOf(",");
  const header = comma < 0 ? trimmed : trimmed.slice(0, comma);
  if (comma < 0 || !/;base64$/iu.test(header)) {
    return invalid(undefined, "the data URL does not carry base64 data");
  }
  const body = trimmed.slice(comma + 1).replace(/\s+/gu, "");
  if (!isWellFormedBase64(body)) {
    return invalid(undefined, "the data URL does not carry valid base64 data");
  }
  return inspectImageBytes(Buffer.from(body, "base64"));
}

/** The media type a data URL declares, such as `image/png`, if any. */
export function dataUrlMediaType(url: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/iu.exec(url.trim());
  return match?.[1]?.trim().toLowerCase() || undefined;
}

/** Decoded byte length of a base64 data URL body, without decoding it. */
export function dataUrlDecodedByteLength(url: string): number | undefined {
  const trimmed = url.trim();
  const comma = trimmed.indexOf(",");
  if (!/^data:/iu.test(trimmed) || comma < 0) return undefined;
  if (!/;base64$/iu.test(trimmed.slice(0, comma))) return undefined;
  const body = trimmed.slice(comma + 1).replace(/\s+/gu, "");
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

function isWellFormedBase64(body: string): boolean {
  if (body.length === 0) return false;
  // Single-level character class: nested quantifiers overflow the regex
  // stack on multi-megabyte payloads.
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(body)) return false;
  if (body.length % 4 === 1) return false;
  return !body.includes("=") || body.length % 4 === 0;
}

function invalid(
  format: InlineImageFormat | undefined,
  reason: string,
): ImageInspection {
  return format === undefined ? { ok: false, reason } : { ok: false, format, reason };
}

function valid(
  format: InlineImageFormat,
  width: number,
  height: number,
): ImageInspection {
  if (!(width > 0) || !(height > 0)) {
    return invalid(format, "the image has a width or height of zero");
  }
  return { ok: true, format, mediaType: `image/${format}`, width, height };
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let index = start; index < end && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index]!);
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────
// PNG
// ─────────────────────────────────────────────────────────────────────

const PNG_IHDR_END = 8 + 8 + 13 + 4;
const PNG_MAX_CHUNK_LENGTH = 0x7fffffff;

function inspectPng(bytes: Buffer): ImageInspection {
  if (bytes.length < PNG_IHDR_END) {
    return invalid(
      "png",
      "the data ends before its header (IHDR) chunk is complete",
    );
  }
  if (bytes.readUInt32BE(8) !== 13 || ascii(bytes, 12, 16) !== "IHDR") {
    return invalid("png", "the data does not begin with a header (IHDR) chunk");
  }
  if (!pngChunkCrcMatches(bytes, 8, 13)) {
    return invalid("png", "the header (IHDR) chunk is corrupt");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const validDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth));
  if (
    !validDepth ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    (bytes[28] !== 0 && bytes[28] !== 1)
  ) {
    return invalid("png", "the header (IHDR) chunk has invalid image parameters");
  }

  let offset = PNG_IHDR_END;
  let sawPalette = false;
  let sawImageData = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return invalid("png", "the data ends inside a chunk header");
    }
    const length = bytes.readUInt32BE(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    if (length > PNG_MAX_CHUNK_LENGTH || !/^[A-Za-z]{4}$/u.test(type)) {
      return invalid("png", "the data contains a malformed chunk");
    }
    if (offset + 12 + length > bytes.length) {
      return invalid("png", `the data ends inside its ${type} chunk`);
    }
    // Decoders reject a damaged critical chunk (upper-case first letter);
    // ancillary chunks with a bad checksum are only skipped.
    if (/^[A-Z]/u.test(type) && !pngChunkCrcMatches(bytes, offset, length)) {
      return invalid("png", `its ${type} chunk is corrupt`);
    }
    if (type === "PLTE") sawPalette = true;
    if (type === "IDAT") {
      if (colorType === 3 && !sawPalette) {
        return invalid("png", "the palette image has no palette (PLTE) chunk");
      }
      sawImageData = true;
    }
    if (type === "IEND") {
      return sawImageData
        ? valid("png", width, height)
        : invalid("png", "the data has no image data (IDAT) chunk");
    }
    offset += 12 + length;
  }
  return invalid(
    "png",
    sawImageData
      ? "the data ends before its end (IEND) chunk"
      : "the data ends before any image data (IDAT) chunk",
  );
}

function pngChunkCrcMatches(
  bytes: Buffer,
  chunkOffset: number,
  length: number,
): boolean {
  const typeAndData = bytes.subarray(chunkOffset + 4, chunkOffset + 8 + length);
  return crc32(typeAndData) === bytes.readUInt32BE(chunkOffset + 8 + length);
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  const native = (zlib as { crc32?: (data: Uint8Array) => number }).crc32;
  if (typeof native === "function") return native(bytes) >>> 0;
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      crcTable[value] = crc >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─────────────────────────────────────────────────────────────────────
// JPEG
// ─────────────────────────────────────────────────────────────────────

function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function inspectJpeg(bytes: Buffer): ImageInspection {
  let offset = 2;
  let frame: { readonly width: number; readonly height: number } | undefined;
  for (;;) {
    if (offset >= bytes.length) {
      return invalid("jpeg", "the data ends before its image data");
    }
    if (bytes[offset] !== 0xff) {
      return invalid("jpeg", "the data contains a malformed marker");
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) {
      return invalid("jpeg", "the data ends before its image data");
    }
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd9) {
      return invalid("jpeg", "the data ends before its image data");
    }
    if (offset + 2 > bytes.length) {
      return invalid("jpeg", "the data ends inside a marker segment");
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2) {
      return invalid("jpeg", "the data contains a malformed marker segment");
    }
    if (offset + segmentLength > bytes.length) {
      return invalid("jpeg", "the data ends inside a marker segment");
    }
    if (isStartOfFrame(marker)) {
      if (segmentLength < 8) {
        return invalid("jpeg", "the frame header is malformed");
      }
      frame = {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    if (marker === 0xda) {
      if (frame === undefined) {
        return invalid("jpeg", "the image data comes before any frame header");
      }
      const scanStart = offset + segmentLength;
      // Entropy-coded data stuffs every 0xFF byte, so FF D9 after the scan
      // header can only be the end-of-image marker.
      const end = bytes.lastIndexOf(JPEG_END_OF_IMAGE);
      if (end < scanStart) {
        return invalid("jpeg", "the data ends before its end-of-image marker");
      }
      return valid("jpeg", frame.width, frame.height);
    }
    offset += segmentLength;
  }
}

const JPEG_END_OF_IMAGE = Buffer.from([0xff, 0xd9]);

// ─────────────────────────────────────────────────────────────────────
// GIF
// ─────────────────────────────────────────────────────────────────────

function inspectGif(bytes: Buffer): ImageInspection {
  if (bytes.length < 13) {
    return invalid("gif", "the data ends before its screen descriptor");
  }
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const packed = bytes[10]!;
  let offset = 13;
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
  if (offset > bytes.length) {
    return invalid("gif", "the data ends inside its color table");
  }
  let frames = 0;
  while (offset < bytes.length) {
    const block = bytes[offset]!;
    if (block === 0x3b) {
      return frames > 0
        ? valid("gif", width, height)
        : invalid("gif", "the data contains no image");
    }
    if (block === 0x21) {
      if (offset + 2 > bytes.length) {
        return invalid("gif", "the data ends inside an extension block");
      }
      const next = skipGifSubBlocks(bytes, offset + 2);
      if (next === undefined) {
        return invalid("gif", "the data ends inside an extension block");
      }
      offset = next;
      continue;
    }
    if (block === 0x2c) {
      if (offset + 10 > bytes.length) {
        return invalid("gif", "the data ends inside an image descriptor");
      }
      const imagePacked = bytes[offset + 9]!;
      offset += 10;
      if (imagePacked & 0x80) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
      // One byte of LZW minimum code size precedes the image data.
      if (offset + 1 > bytes.length) {
        return invalid("gif", "the data ends inside an image");
      }
      const next = skipGifSubBlocks(bytes, offset + 1);
      if (next === undefined) {
        return invalid("gif", "the data ends inside an image");
      }
      frames += 1;
      offset = next;
      continue;
    }
    return invalid("gif", "the data contains a malformed block");
  }
  // A GIF whose last frame is complete but whose trailer byte is missing is
  // still displayed by decoders.
  return frames > 0
    ? valid("gif", width, height)
    : invalid("gif", "the data ends before its first image");
}

function skipGifSubBlocks(bytes: Buffer, start: number): number | undefined {
  let offset = start;
  for (;;) {
    if (offset >= bytes.length) return undefined;
    const size = bytes[offset]!;
    offset += 1;
    if (size === 0) return offset;
    offset += size;
    if (offset > bytes.length) return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────
// WebP
// ─────────────────────────────────────────────────────────────────────

interface RiffChunk {
  readonly fourcc: string;
  readonly size: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

type WebpFrame =
  | { readonly width: number; readonly height: number }
  | { readonly error: string };

/** VP8X flag for an animated image: its frames live in ANMF chunks. */
const WEBP_ANIMATION_FLAG = 0x02;

/**
 * A WebP image is one of three layouts: a lone VP8 (lossy) or VP8L
 * (lossless) bitstream, an extended VP8X still with one such bitstream, or
 * an extended animation whose every ANMF frame carries one. An empty frame
 * or a missing bitstream is not an image, whatever chunks surround it.
 */
function inspectWebp(bytes: Buffer): ImageInspection {
  const riffEnd = bytes.readUInt32LE(4) + 8;
  if (riffEnd > bytes.length) {
    return invalid("webp", "the data ends before the size its header declares");
  }
  const chunks = readRiffChunks(bytes, 12, riffEnd);
  if ("error" in chunks) return invalid("webp", chunks.error);
  const first = chunks.list[0];
  if (first === undefined) {
    return invalid("webp", "the data contains no image chunk");
  }
  if (first.fourcc === "VP8 " || first.fourcc === "VP8L") {
    const frame = inspectWebpBitstream(bytes, first);
    return "error" in frame
      ? invalid("webp", frame.error)
      : valid("webp", frame.width, frame.height);
  }
  if (first.fourcc !== "VP8X") {
    return invalid("webp", "the data does not start with a VP8, VP8L or VP8X chunk");
  }
  if (first.size < 10) return invalid("webp", "the VP8X chunk is malformed");
  const width = 1 + bytes.readUIntLE(first.dataStart + 4, 3);
  const height = 1 + bytes.readUIntLE(first.dataStart + 7, 3);
  if ((bytes[first.dataStart]! & WEBP_ANIMATION_FLAG) !== 0) {
    if (!chunks.list.some((chunk) => chunk.fourcc === "ANIM")) {
      return invalid("webp", "the animated image has no ANIM chunk");
    }
    const frames = chunks.list.filter((chunk) => chunk.fourcc === "ANMF");
    if (frames.length === 0) {
      return invalid("webp", "the animated image has no frames");
    }
    for (const frame of frames) {
      const defect = inspectAnimationFrame(bytes, frame);
      if (defect !== undefined) return invalid("webp", defect);
    }
    return valid("webp", width, height);
  }
  const image = chunks.list.find(
    (chunk) => chunk.fourcc === "VP8 " || chunk.fourcc === "VP8L",
  );
  if (image === undefined) {
    return invalid("webp", "the data contains no image (VP8 or VP8L) chunk");
  }
  const frame = inspectWebpBitstream(bytes, image);
  return "error" in frame
    ? invalid("webp", frame.error)
    : valid("webp", width, height);
}

function readRiffChunks(
  bytes: Buffer,
  start: number,
  end: number,
): { readonly list: RiffChunk[] } | { readonly error: string } {
  const list: RiffChunk[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const fourcc = ascii(bytes, offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > end) {
      return { error: `the data ends inside its ${fourcc.trim()} chunk` };
    }
    list.push({ fourcc, size, dataStart, dataEnd });
    offset = dataEnd + (size & 1);
  }
  return { list };
}

function inspectWebpBitstream(bytes: Buffer, chunk: RiffChunk): WebpFrame {
  const start = chunk.dataStart;
  if (chunk.fourcc === "VP8 ") {
    if (chunk.size < 10) return { error: "the VP8 chunk is malformed" };
    const tag = bytes[start]! | (bytes[start + 1]! << 8) | (bytes[start + 2]! << 16);
    const keyFrame = (tag & 1) === 0;
    const firstPartitionSize = (tag >>> 5) & 0x7ffff;
    if (
      !keyFrame ||
      bytes[start + 3] !== 0x9d ||
      bytes[start + 4] !== 0x01 ||
      bytes[start + 5] !== 0x2a
    ) {
      return { error: "the VP8 chunk is malformed" };
    }
    if (10 + firstPartitionSize > chunk.size) {
      return { error: "the VP8 chunk is cut off" };
    }
    return {
      width: bytes.readUInt16LE(start + 6) & 0x3fff,
      height: bytes.readUInt16LE(start + 8) & 0x3fff,
    };
  }
  if (chunk.size < 5 || bytes[start] !== 0x2f) {
    return { error: "the VP8L chunk is malformed" };
  }
  const bits = bytes.readUInt32LE(start + 1);
  if (bits >>> 29 !== 0) {
    return { error: "the VP8L chunk has an unknown version" };
  }
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/** An ANMF frame: a 16-byte frame header, then its own VP8 or VP8L chunk. */
function inspectAnimationFrame(
  bytes: Buffer,
  frame: RiffChunk,
): string | undefined {
  if (frame.size < 16) return "an animation frame (ANMF) is malformed";
  const inner = readRiffChunks(bytes, frame.dataStart + 16, frame.dataEnd);
  if ("error" in inner) return inner.error;
  const image = inner.list.find(
    (chunk) => chunk.fourcc === "VP8 " || chunk.fourcc === "VP8L",
  );
  if (image === undefined) return "an animation frame (ANMF) has no image data";
  const bitstream = inspectWebpBitstream(bytes, image);
  if ("error" in bitstream) return bitstream.error;
  return bitstream.width > 0 && bitstream.height > 0
    ? undefined
    : "an animation frame (ANMF) has a width or height of zero";
}
