/**
 * Wave 3-C: platform-matrix clipboard image paste.
 *
 * Reads an image from the OS clipboard, validates it via `jimp`, and
 * writes a normalized PNG into the OS temp directory. Supports three
 * platforms with a clean "unsupported" fallback:
 *
 *   Darwin  — AppleScript via `osascript`, writing the clipboard's
 *             «class PNGf» payload directly to a POSIX path. We could
 *             shell out to `pngpaste` when it is present but that adds
 *             a hard Homebrew/install dependency for a capability that
 *             macOS already exposes through the system scripting
 *             bridge. AppleScript ships with every macOS release, so
 *             preferring it keeps the paste path dependency-free.
 *   Linux   — `wl-paste --type image/png -n` (Wayland) first, falling
 *             back to `xclip -selection clipboard -t image/png -o`
 *             (X11). We do not try `xsel` for images because xsel does
 *             not support arbitrary MIME types; its image support is
 *             limited to the X11 primary selection protocol, which
 *             rarely holds images in practice.
 *   Win32   — PowerShell one-liner using `System.Windows.Forms`
 *             `Clipboard.GetImage()` and `Bitmap.Save()` as PNG.
 *
 * The extraction helper is kept pure (no filesystem side effects,
 * returns a platform tag) so unit tests can exercise routing without
 * spawning processes. Actual clipboard reads flow through
 * `child_process.execFile` with a 10 second timeout.
 *
 * Output contract:
 *   - Files are written to `os.tmpdir()` using the pattern
 *     `agenc-clip-<timestamp>.png`, matching the `agenc-clip` family
 *     of names already used by the terminal IO layer.
 *   - Images larger than 10 MB on disk or exceeding 4096 px on the
 *     longer edge are re-encoded via `jimp.scaleToFit({w:4096, h:4096})`
 *     and the re-encoded PNG is what the caller receives.
 *   - If any step fails (no image in clipboard, platform has no
 *     extractor, jimp rejects the file, timeout), the function returns
 *     `null` and cleans up any temp file it created.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Upper bound for the clipboard read subprocess. */
const CLIPBOARD_READ_TIMEOUT_MS = 10_000;

/** Maximum raw bytes permitted before we re-encode the image. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Maximum pixel extent on either edge before we downscale. */
const MAX_IMAGE_EDGE = 4096;

export interface PastedImage {
  /** Absolute filesystem path to the saved PNG in the OS temp dir. */
  path: string;
  /** Final PNG size in bytes after validation/resizing. */
  bytes: number;
  /** Final image dimensions after validation/resizing. */
  dimensions: { width: number; height: number };
  /**
   * True if any sanitization was applied during paste. For images the
   * binary payload itself is not C0/C1 scrubbed (that would corrupt
   * PNG chunks), but we keep the field so the caller-facing record
   * matches the text paste shape. It is currently always false and
   * reserved for future metadata-scrubbing work.
   */
  sanitized: boolean;
}

/** Known clipboard extractor tags. `'unsupported'` is a terminal state. */
export type ClipboardExtractor = "darwin" | "linux" | "win32" | "unsupported";

/**
 * Map a Node `process.platform` value to the clipboard extractor we
 * will invoke. Exposed as a pure helper so tests can exercise the
 * routing matrix without spawning a real subprocess.
 */
export function getPlatformClipboardExtractor(
  platform: NodeJS.Platform = process.platform,
): ClipboardExtractor {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "win32";
  return "unsupported";
}

/**
 * Build the absolute temp path that `agenc-clip-*.png` uses. Kept
 * private because callers should not need to know the naming
 * convention — only that the returned `PastedImage.path` is a real
 * file they can read.
 */
function newClipTempPath(): string {
  return path.join(os.tmpdir(), `agenc-clip-${Date.now()}.png`);
}

interface ExecOptions {
  /** Pass `ignore` to avoid inheriting the parent stdin TTY. */
  stdio?: "ignore" | "pipe";
  /** Return encoded as a Buffer (for image payload capture). */
  encoding?: "buffer" | null;
}

/**
 * Run a subprocess with a hard timeout, returning stdout as a Buffer
 * or null on any failure (non-zero exit, ENOENT, timeout). We swallow
 * errors deliberately: "no clipboard image" is the common outcome and
 * should not propagate as an exception into the TUI.
 */
async function runCapture(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: CLIPBOARD_READ_TIMEOUT_MS,
      encoding: opts.encoding ?? "buffer",
      maxBuffer: MAX_IMAGE_BYTES * 2,
    });
    if (stdout === null || stdout === undefined) return null;
    if (Buffer.isBuffer(stdout)) return stdout.length > 0 ? stdout : null;
    // With encoding=null, Node returns a Buffer. Fall back to Buffer.from
    // for defensive compatibility with mocked implementations that hand
    // back a string.
    const buf = Buffer.from(stdout as unknown as string);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Execute the Darwin AppleScript extractor. Writes the clipboard's
 * PNGf payload directly into the provided `targetPath`; the script
 * intentionally has no return value. Success is detected by probing
 * for the file afterwards.
 */
async function extractDarwinToFile(targetPath: string): Promise<boolean> {
  // Quote the target path for AppleScript string literal safety. macOS
  // tmp paths never contain quotes, but we escape defensively anyway.
  const escaped = targetPath.replace(/"/g, '\\"');
  const script = [
    `set theClipboard to the clipboard as «class PNGf»`,
    `set theFile to open for access POSIX file "${escaped}" with write permission`,
    `write theClipboard to theFile`,
    `close access theFile`,
  ];
  const args: string[] = [];
  for (const line of script) {
    args.push("-e", line);
  }
  try {
    await execFileAsync("osascript", args, {
      timeout: CLIPBOARD_READ_TIMEOUT_MS,
    });
  } catch {
    return false;
  }
  try {
    const stat = await fs.stat(targetPath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Execute the Linux extractor. Tries Wayland first, then X11. Returns
 * the raw PNG bytes or null if neither tool produced output.
 */
async function extractLinuxBuffer(): Promise<Buffer | null> {
  const wayland = await runCapture("wl-paste", ["--type", "image/png", "-n"]);
  if (wayland !== null) return wayland;
  const x11 = await runCapture("xclip", [
    "-selection",
    "clipboard",
    "-t",
    "image/png",
    "-o",
  ]);
  return x11;
}

/**
 * Execute the Windows extractor. PowerShell writes the clipboard
 * image directly into `targetPath` as PNG. If no image is on the
 * clipboard the script exits cleanly with no file written, which we
 * detect with a post-run stat check.
 */
async function extractWin32ToFile(targetPath: string): Promise<boolean> {
  const escaped = targetPath.replace(/'/g, "''");
  const command = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$img = [System.Windows.Forms.Clipboard]::GetImage();",
    `if ($img -ne $null) { $img.Save('${escaped}'); }`,
  ].join(" ");
  try {
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: CLIPBOARD_READ_TIMEOUT_MS },
    );
  } catch {
    return false;
  }
  try {
    const stat = await fs.stat(targetPath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

interface ValidatedImage {
  path: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Validate + normalize the PNG file at `filePath` using jimp. If the
 * file exceeds the size/dimension bounds, it is re-encoded in place
 * at a smaller scale. Returns null if jimp cannot decode the file.
 *
 * `jimp` is imported dynamically so this module is cheap to load in
 * environments (e.g., test harnesses for routing helpers) that never
 * invoke the clipboard path.
 */
async function validateWithJimp(
  filePath: string,
): Promise<ValidatedImage | null> {
  let statAfterWrite: { size: number };
  try {
    statAfterWrite = await fs.stat(filePath);
  } catch {
    return null;
  }

  // `jimp` exposes both an ESM and a commonjs build with subtly
  // different generated types. Typing the module against either one
  // creates cross-subpath incompatibilities depending on how
  // TypeScript resolves the `import("jimp")` form. We only use three
  // well-documented surfaces (`Jimp.read`, `bitmap.width/height`,
  // `scaleToFit`, `write`), so we widen to `any` locally and trust the
  // runtime + the dedicated tests on this module to catch regressions.
  let jimpModule: any;
  try {
    jimpModule = await import("jimp");
  } catch {
    return null;
  }
  const Jimp = jimpModule.Jimp ?? jimpModule.default?.Jimp;
  if (Jimp === undefined || typeof Jimp.read !== "function") return null;

  let image: any;
  try {
    image = await Jimp.read(filePath);
  } catch {
    return null;
  }

  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const tooLarge =
    statAfterWrite.size > MAX_IMAGE_BYTES ||
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE;

  if (tooLarge) {
    try {
      image.scaleToFit({ w: MAX_IMAGE_EDGE, h: MAX_IMAGE_EDGE });
      await image.write(filePath);
    } catch {
      return null;
    }
  }

  let finalStat: { size: number };
  try {
    finalStat = await fs.stat(filePath);
  } catch {
    return null;
  }

  return {
    path: filePath,
    bytes: finalStat.size,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

/**
 * Read the current clipboard image (if any) and return a normalized
 * descriptor. Returns `null` when the platform is unsupported, the
 * clipboard holds no image, or validation fails.
 */
export async function tryReadClipboardImage(): Promise<PastedImage | null> {
  const extractor = getPlatformClipboardExtractor();
  if (extractor === "unsupported") return null;

  const targetPath = newClipTempPath();

  let produced = false;
  if (extractor === "darwin") {
    produced = await extractDarwinToFile(targetPath);
  } else if (extractor === "linux") {
    const buf = await extractLinuxBuffer();
    if (buf !== null) {
      try {
        await fs.writeFile(targetPath, buf);
        produced = true;
      } catch {
        produced = false;
      }
    }
  } else if (extractor === "win32") {
    produced = await extractWin32ToFile(targetPath);
  }

  if (!produced) {
    await fs.unlink(targetPath).catch(() => undefined);
    return null;
  }

  const validated = await validateWithJimp(targetPath);
  if (validated === null) {
    await fs.unlink(targetPath).catch(() => undefined);
    return null;
  }

  return {
    path: validated.path,
    bytes: validated.bytes,
    dimensions: { width: validated.width, height: validated.height },
    sanitized: false,
  };
}
