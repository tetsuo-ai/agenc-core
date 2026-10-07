import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";

/** sun_path must also contain the trailing NUL. Use the BSD limit elsewhere. */
export function assertAgenCUnixSocketPathLength(path, platform = process.platform) {
  const limit = platform === "linux" ? 107 : 103;
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes > limit) {
    throw new Error(
      `AgenC daemon Unix socket path is too long (${bytes} bytes; ${platform} limit ${limit}): ${path}`,
    );
  }
}

function canonicalHome(home) {
  let ancestor = resolve(home.normalize("NFC"));
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...missing).normalize("NFC");
    } catch (error) {
      if (error?.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

function ensurePrivateDirectory(directory, uid) {
  try {
    // /tmp already exists: never recursively follow a pre-created fallback.
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.uid !== uid) {
    throw new Error(
      `Refusing unsafe AgenC daemon socket directory ${directory}: expected a directory owned by uid ${uid}, not a symlink`,
    );
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error(
      `Refusing non-private AgenC daemon socket directory ${directory}: expected mode 0700`,
    );
  }
}

/** Reserved by the runtime sandbox even before a long-home daemon starts. */
export function agenCDaemonFallbackDirectory() {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : `/tmp/agenc-${uid}`;
}

/** Shared by the daemon, SDK and gate scripts. Short paths and pipes stay stable. */
export function agenCDaemonLocalEndpoint(daemonHome, platform = process.platform) {
  if (platform === "win32") {
    const identity = createHash("sha256")
      .update(win32.resolve(daemonHome).toLowerCase())
      .digest("hex");
    return `\\\\.\\pipe\\agenc-daemon-${identity}`;
  }
  const naturalPath = join(daemonHome, "daemon.sock");
  const limit = platform === "linux" ? 107 : 103;
  if (Buffer.byteLength(naturalPath, "utf8") <= limit) return naturalPath;

  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Cannot resolve a private AgenC daemon socket fallback without a user id");
  }
  // Intentionally independent of TMPDIR/XDG_RUNTIME_DIR: launch agents and
  // interactive clients may have different environments for the same home.
  const directory = agenCDaemonFallbackDirectory();
  const identity = createHash("sha256").update(canonicalHome(daemonHome)).digest("hex");
  const fallback = join(directory, `${identity}.sock`);
  try {
    assertAgenCUnixSocketPathLength(fallback, platform);
  } catch (cause) {
    throw new Error("AgenC daemon socket fallback cannot fit the platform path limit", { cause });
  }
  ensurePrivateDirectory(directory, uid);
  return fallback;
}
