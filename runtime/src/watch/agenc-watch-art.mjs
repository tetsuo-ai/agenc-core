/**
 * Terminal ANSI art renderer for the TUI side panel.
 *
 * Port of the reference Python script at `/home/tetsuo/git/ansi-art`
 * (the 70-char "standard" ramp + luminance → char lookup + 24-bit
 * foreground color per cell). Loads the source image once via jimp,
 * caches the decoded RGB buffer, re-rasterizes on terminal resize.
 */

import { readFileSync } from "node:fs";
import { Jimp, ResizeStrategy } from "jimp";

// Same ramp as ansi_art.py "standard" — darkest → brightest.
const STANDARD_RAMP =
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const RAMPS = {
  standard: STANDARD_RAMP,
  blocks: " \u2591\u2592\u2593\u2588",
  simple: " .:-=+*#%@",
  binary: " @",
};

// Terminal cells are roughly twice as tall as they are wide; the
// renderer compresses vertical sampling to compensate. Matches the
// Python script's default `--char-aspect 0.5`.
const DEFAULT_CHAR_ASPECT = 0.5;

const ANSI_RESET = "\x1b[0m";
function fg24(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function pickChar(ramp, luminance01, invert) {
  let lum = invert ? 1 - luminance01 : luminance01;
  if (lum < 0) lum = 0;
  if (lum > 1) lum = 1;
  const idx = Math.min(ramp.length - 1, Math.floor(lum * (ramp.length - 1)));
  return ramp[idx];
}

function luminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function validateRamp(ramp) {
  if (typeof ramp !== "string" || ramp.length < 2) return STANDARD_RAMP;
  return ramp;
}

/**
 * Build an art renderer for a single source image. The returned
 * renderer caches the decoded image; call `.render({cols, rows, …})`
 * repeatedly on resize without re-decoding.
 *
 * Returns `null` when the image cannot be read (file missing /
 * corrupt). Callers should treat null as "disable the art panel" and
 * not fall into a render loop.
 */
export async function createAnsiArtRenderer({ imagePath, ramp, invert } = {}) {
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    return null;
  }
  let decoded;
  try {
    const buf = readFileSync(imagePath);
    decoded = await Jimp.read(buf);
  } catch {
    return null;
  }
  const sourceWidth = decoded.bitmap.width;
  const sourceHeight = decoded.bitmap.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const rampString = validateRamp(
    typeof ramp === "string" ? RAMPS[ramp] ?? ramp : undefined,
  );
  const invertFlag = invert === true;

  // Cache the last rasterization keyed by (cols, rows, charAspect) so
  // the frame renderer can call render() every tick without repeating
  // the resize/quantize work unless the terminal actually resized.
  let cacheKey = null;
  let cacheRows = null;

  async function render({ cols, rows, charAspect = DEFAULT_CHAR_ASPECT } = {}) {
    const targetCols = Math.max(1, Math.floor(Number(cols)));
    const targetRows = Math.max(1, Math.floor(Number(rows)));
    const targetAspect = Number.isFinite(Number(charAspect))
      ? Math.max(0.1, Number(charAspect))
      : DEFAULT_CHAR_ASPECT;
    const key = `${targetCols}:${targetRows}:${targetAspect}`;
    if (key === cacheKey && cacheRows !== null) return cacheRows;

    // Match ansi_art.py resize: fit width to cols, derive height from
    // source aspect * char-aspect, then clamp to targetRows so the
    // right-panel overlay never scrolls past the available terminal
    // lines.
    const ratio = sourceHeight / sourceWidth;
    const naturalRows = Math.max(
      1,
      Math.round(ratio * targetCols * targetAspect),
    );
    const renderRows = Math.min(targetRows, naturalRows);

    const clone = decoded.clone();
    clone.resize({
      w: targetCols,
      h: renderRows,
      mode: ResizeStrategy.BILINEAR,
    });
    const { width: imgW, height: imgH, data } = clone.bitmap;
    const out = [];
    for (let y = 0; y < imgH; y += 1) {
      let row = "";
      let lastColor = "";
      for (let x = 0; x < imgW; x += 1) {
        const offset = (y * imgW + x) * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const lum = luminance(r, g, b);
        const ch = pickChar(rampString, lum, invertFlag);
        const color = fg24(r, g, b);
        if (color !== lastColor) {
          row += color;
          lastColor = color;
        }
        row += ch;
      }
      out.push(row + ANSI_RESET);
    }
    // Pad vertically with empty rows so callers can blit one row per
    // terminal line without length-mismatch bookkeeping.
    while (out.length < targetRows) {
      out.push("");
    }
    cacheKey = key;
    cacheRows = out;
    return out;
  }

  function invalidate() {
    cacheKey = null;
    cacheRows = null;
  }

  return {
    render,
    invalidate,
    sourceWidth,
    sourceHeight,
    rampLength: rampString.length,
  };
}
