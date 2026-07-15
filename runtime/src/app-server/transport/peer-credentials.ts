import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

export interface AgenCNativePeerCredentialBinding {
  getPeerUid(fd: number): number | null;
}

export interface AgenCNativePeerCredentialOptions {
  readonly allowRuntimeNativeBuild?: boolean;
  readonly cacheDir?: string;
  readonly compiler?: string;
  readonly execFileSync?: typeof execFileSync;
  readonly nativeAddonPath?: string;
  readonly requireRootOwnedNativeAddon?: boolean;
  readonly nativeBinding?: AgenCNativePeerCredentialBinding;
  readonly nodeIncludeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export interface AgenCNativePeerCredentialLoadResult {
  readonly binding: AgenCNativePeerCredentialBinding | null;
  readonly error?: string;
}

const NATIVE_PEER_CREDENTIAL_SOURCE = String.raw`
#define _GNU_SOURCE
#include <node_api.h>
#include <stdint.h>

#if defined(__linux__)
#include <sys/socket.h>
#include <unistd.h>
#endif

static napi_value agenc_null(napi_env env) {
  napi_value result;
  if (napi_get_null(env, &result) != napi_ok) return NULL;
  return result;
}

static napi_value agenc_get_peer_uid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok) {
    return NULL;
  }
  if (argc < 1) return agenc_null(env);

  int32_t fd = -1;
  if (napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0) {
    return agenc_null(env);
  }

#if defined(__linux__)
  struct ucred credentials;
  socklen_t length = sizeof(credentials);
  if (
    getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0 ||
    length != sizeof(credentials)
  ) {
    return agenc_null(env);
  }

  napi_value result;
  if (napi_create_int64(env, (int64_t)credentials.uid, &result) != napi_ok) {
    return NULL;
  }
  return result;
#else
  return agenc_null(env);
#endif
}

NAPI_MODULE_INIT() {
  napi_property_descriptor descriptors[] = {
    {
      "getPeerUid",
      NULL,
      agenc_get_peer_uid,
      NULL,
      NULL,
      NULL,
      napi_default,
      NULL,
    },
  };
  if (napi_define_properties(env, exports, 1, descriptors) != napi_ok) {
    return NULL;
  }
  return exports;
}
`;

const NATIVE_SOURCE_HASH = createHash("sha256")
  .update(NATIVE_PEER_CREDENTIAL_SOURCE)
  .digest("hex");

interface NativePeerCredentialCacheManifest {
  readonly arch: string;
  readonly artifactHash: string;
  readonly modules: string;
  readonly platform: NodeJS.Platform;
  readonly sourceHash: string;
}

export function loadAgenCNativePeerCredentialBinding(
  options: AgenCNativePeerCredentialOptions = {},
): AgenCNativePeerCredentialLoadResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return { binding: null };
  if (options.nativeBinding !== undefined) {
    return { binding: options.nativeBinding };
  }
  if (options.nativeAddonPath !== undefined) {
    try {
      return {
        binding: loadNativePeerCredentialBindingFromPath(
          options.nativeAddonPath,
          options.requireRootOwnedNativeAddon,
        ),
      };
    } catch (error) {
      return { binding: null, error: errorMessage(error) };
    }
  }
  if (options.allowRuntimeNativeBuild === false) {
    return {
      binding: null,
      error: "runtime native peer credential build disabled",
    };
  }

  try {
    return { binding: compileAndLoadAgenCNativePeerCredentialBinding(options) };
  } catch (error) {
    return { binding: null, error: errorMessage(error) };
  }
}

export function compileAndLoadAgenCNativePeerCredentialBinding(
  options: Pick<
    AgenCNativePeerCredentialOptions,
    "cacheDir" | "compiler" | "execFileSync" | "nodeIncludeDir" | "platform"
  > = {},
): AgenCNativePeerCredentialBinding {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new Error("AgenC peer credential native binding is Linux-only");
  }

  const dir = options.cacheDir ?? defaultNativeCacheDir(platform);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  securePrivateDirectory(dir);

  const addonPath = path.join(dir, "agenc-peer-credentials.node");
  const manifestPath = path.join(dir, "manifest.json");
  if (!isNativeCacheCurrent(addonPath, manifestPath, platform)) {
    rebuildNativePeerCredentialBinding({
      addonPath,
      cacheDir: dir,
      compiler: options.compiler ?? "cc",
      manifestPath,
      nodeIncludeDir: options.nodeIncludeDir,
      runExecFileSync: options.execFileSync ?? execFileSync,
    });
  }

  assertSafeCacheFile(addonPath);
  assertSafeCacheFile(manifestPath);
  return loadNativePeerCredentialBindingFromPath(addonPath);
}

function loadNativePeerCredentialBindingFromPath(
  addonPath: string,
  requireRootOwner = false,
): AgenCNativePeerCredentialBinding {
  assertTrustedNativeAddonFile(addonPath, requireRootOwner);
  const loaded = createRequire(import.meta.url)(
    addonPath,
  ) as AgenCNativePeerCredentialBinding;
  assertNativePeerCredentialBinding(loaded);
  return loaded;
}

interface NativePeerCredentialBuildOptions {
  readonly addonPath: string;
  readonly cacheDir: string;
  readonly compiler: string;
  readonly manifestPath: string;
  readonly nodeIncludeDir?: string;
  readonly runExecFileSync: typeof execFileSync;
}

function rebuildNativePeerCredentialBinding(
  options: NativePeerCredentialBuildOptions,
): void {
  const buildDir = mkdtempSync(path.join(options.cacheDir, ".build-"));
  chmodSync(buildDir, 0o700);
  const buildAddonPath = path.join(buildDir, "agenc-peer-credentials.node");
  const buildManifestPath = path.join(buildDir, "manifest.json");
  const sourcePath = path.join(buildDir, "agenc-peer-credentials.c");

  try {
    writeFileSync(sourcePath, NATIVE_PEER_CREDENTIAL_SOURCE, { mode: 0o600 });
    const includeDir = resolveNodeIncludeDir(options.nodeIncludeDir);
    options.runExecFileSync(
      options.compiler,
      [
        "-O2",
        "-D_FORTIFY_SOURCE=2",
        "-fstack-protector-strong",
        "-shared",
        "-fPIC",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-I",
        includeDir,
        "-Wl,-z,relro,-z,now,-z,noexecstack,--build-id=none",
        "-o",
        buildAddonPath,
        sourcePath,
      ],
      { stdio: "pipe" },
    );
    chmodSync(buildAddonPath, 0o600);
    const manifest = createNativeCacheManifest(buildAddonPath, "linux");
    writeFileSync(buildManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(buildAddonPath, options.addonPath);
    renameSync(buildManifestPath, options.manifestPath);
    chmodSync(options.addonPath, 0o600);
    chmodSync(options.manifestPath, 0o600);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

function isNativeCacheCurrent(
  addonPath: string,
  manifestPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (!existsSync(addonPath) || !existsSync(manifestPath)) return false;
  try {
    assertSafeCacheFile(addonPath);
    assertSafeCacheFile(manifestPath);
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as NativePeerCredentialCacheManifest;
    return (
      manifest.sourceHash === NATIVE_SOURCE_HASH &&
      manifest.platform === platform &&
      manifest.arch === process.arch &&
      manifest.modules === process.versions.modules &&
      manifest.artifactHash === fileSha256(addonPath)
    );
  } catch {
    return false;
  }
}

function createNativeCacheManifest(
  addonPath: string,
  platform: NodeJS.Platform,
): NativePeerCredentialCacheManifest {
  return {
    sourceHash: NATIVE_SOURCE_HASH,
    artifactHash: fileSha256(addonPath),
    platform,
    arch: process.arch,
    modules: process.versions.modules,
  };
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function securePrivateDirectory(dir: string): void {
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) {
    throw new Error(`AgenC peer credential cache path is not a directory: ${dir}`);
  }
  assertOwnedByCurrentUser(dir, stats.uid);
  chmodSync(dir, 0o700);
  const updated = statSync(dir);
  if ((updated.mode & 0o077) !== 0) {
    throw new Error(`AgenC peer credential cache directory is not private: ${dir}`);
  }
}

function assertSafeCacheFile(filePath: string): void {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `AgenC peer credential cache entry is not a regular file: ${filePath}`,
    );
  }
  assertOwnedByCurrentUser(filePath, stats.uid);
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(
      `AgenC peer credential cache file is writable by group or others: ${filePath}`,
    );
  }
}

function assertTrustedNativeAddonFile(
  filePath: string,
  requireRootOwner: boolean,
): void {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `AgenC peer credential addon is not a regular file: ${filePath}`,
    );
  }
  if (requireRootOwner) {
    assertRootOwnedImmutablePath(filePath, stats.uid, stats.mode);
    let parent = path.dirname(path.resolve(filePath));
    while (true) {
      const parentStats = lstatSync(parent);
      if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
        throw new Error(
          `AgenC peer credential addon parent is not a real directory: ${parent}`,
        );
      }
      assertRootOwnedImmutablePath(parent, parentStats.uid, parentStats.mode);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  } else {
    assertOwnedByCurrentOrRootUser(filePath, stats.uid);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(
      `AgenC peer credential addon is writable by group or others: ${filePath}`,
    );
  }
}

function assertRootOwnedImmutablePath(
  filePath: string,
  uid: number,
  mode: number,
): void {
  if (typeof process.getuid === "function" && uid !== 0) {
    throw new Error(
      `AgenC peer credential system addon path is not root-owned: ${filePath}`,
    );
  }
  if ((mode & 0o022) !== 0) {
    throw new Error(
      `AgenC peer credential system addon path is writable by group or others: ${filePath}`,
    );
  }
}

function assertOwnedByCurrentUser(filePath: string, uid: number): void {
  if (typeof process.getuid !== "function") return;
  const currentUid = process.getuid();
  if (uid !== currentUid) {
    throw new Error(
      `AgenC peer credential cache entry is not owned by the current user: ${filePath}`,
    );
  }
}

function assertOwnedByCurrentOrRootUser(filePath: string, uid: number): void {
  if (typeof process.getuid !== "function") return;
  const currentUid = process.getuid();
  if (uid !== currentUid && uid !== 0) {
    throw new Error(
      `AgenC peer credential addon is not owned by the current or root user: ${filePath}`,
    );
  }
}

function resolveNodeIncludeDir(explicit?: string): string {
  const candidates = [
    explicit,
    "/usr/include/node",
    path.resolve(path.dirname(process.execPath), "..", "include", "node"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "node_api.h"))) return candidate;
  }
  throw new Error("could not locate node_api.h for peer credential build");
}

function assertNativePeerCredentialBinding(
  value: AgenCNativePeerCredentialBinding,
): void {
  if (typeof value?.getPeerUid !== "function") {
    throw new Error(
      "AgenC peer credential binding did not expose getPeerUid",
    );
  }
}

function defaultNativeCacheDir(platform: NodeJS.Platform): string {
  const cacheRoot = defaultUserCacheRoot(platform);
  return path.join(
    cacheRoot,
    "agenc",
    "agenc-peer-credentials",
    `${platform}-${process.arch}-${process.versions.modules}-${NATIVE_SOURCE_HASH}`,
  );
}

function defaultUserCacheRoot(platform: NodeJS.Platform): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome && path.isAbsolute(xdgCacheHome)) return xdgCacheHome;

  const home = homedir();
  if (home) return path.join(home, ".cache");

  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(tmpdir(), `agenc-${uid}`, platform);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
