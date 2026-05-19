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
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const DANGEROUS_ENV_PREFIXES = [
  "LD_",
  "DYLD_",
  "MallocStackLogging",
  "MallocLogFile",
] as const;

export type ProcessHardeningOperation =
  | "scrub_environment"
  | "set_core_limit"
  | "disable_process_dumping";

export type ProcessHardeningStepStatus =
  | "applied"
  | "failed"
  | "unsupported";

export interface ProcessHardeningStepResult {
  readonly operation: ProcessHardeningOperation;
  readonly status: ProcessHardeningStepStatus;
  readonly method: string;
  readonly detail?: string;
  readonly error?: string;
}

export interface ProcessHardeningResult {
  readonly platform: NodeJS.Platform;
  readonly scrubbedEnvKeys: readonly string[];
  readonly steps: readonly ProcessHardeningStepResult[];
}

export interface NativeHardeningBinding {
  readonly setCoreFileSizeLimitToZero: () => void;
  readonly disableProcessDumping: () => void;
  readonly getCoreFileSizeLimit?: () => number;
  readonly getLinuxDumpable?: () => number;
}

interface NativeHardeningBindingLoadResult {
  readonly binding: NativeHardeningBinding | null;
  readonly error?: string;
}

export type NativeHardeningMode = "auto" | "required" | "off";

export interface ProcessHardeningOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly nativeMode?: NativeHardeningMode;
  readonly nativeBinding?: NativeHardeningBinding;
  readonly nativeAddonPath?: string;
  readonly allowRuntimeNativeBuild?: boolean;
  readonly execFileSync?: typeof execFileSync;
  readonly cacheDir?: string;
  readonly compiler?: string;
  readonly nodeIncludeDir?: string;
}

export type BestEffortProcessHardeningOptions =
  Omit<ProcessHardeningOptions, "nativeMode">;

export class ProcessHardeningError extends Error {
  readonly result: ProcessHardeningResult;

  constructor(message: string, result: ProcessHardeningResult) {
    super(message);
    this.name = "ProcessHardeningError";
    this.result = result;
  }
}

const NATIVE_ADDON_SOURCE = String.raw`
#include <errno.h>
#include <node_api.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>

#if defined(__linux__)
#include <sys/prctl.h>
#endif

#if defined(__APPLE__)
#include <sys/ptrace.h>
#ifndef PT_DENY_ATTACH
#define PT_DENY_ATTACH 31
#endif
#endif

static napi_value throw_errno(napi_env env, const char *name, int err) {
  char message[256];
  snprintf(message, sizeof(message), "%s failed: %s", name, strerror(err));
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value throw_unsupported(napi_env env, const char *message) {
  napi_throw_error(env, "ENOTSUP", message);
  return NULL;
}

static napi_value set_core_file_size_limit_to_zero(napi_env env, napi_callback_info info) {
  (void)info;
  struct rlimit limit;
  limit.rlim_cur = 0;
  limit.rlim_max = 0;
  if (setrlimit(RLIMIT_CORE, &limit) != 0) {
    return throw_errno(env, "setrlimit(RLIMIT_CORE)", errno);
  }
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

static napi_value disable_process_dumping(napi_env env, napi_callback_info info) {
  (void)info;
#if defined(__linux__)
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    return throw_errno(env, "prctl(PR_SET_DUMPABLE, 0)", errno);
  }
#elif defined(__APPLE__)
  if (ptrace(PT_DENY_ATTACH, 0, NULL, 0) != 0) {
    return throw_errno(env, "ptrace(PT_DENY_ATTACH)", errno);
  }
#else
  return throw_unsupported(env, "process dumping hardening is not supported on this platform");
#endif
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

static napi_value get_core_file_size_limit(napi_env env, napi_callback_info info) {
  (void)info;
  struct rlimit limit;
  if (getrlimit(RLIMIT_CORE, &limit) != 0) {
    return throw_errno(env, "getrlimit(RLIMIT_CORE)", errno);
  }
  napi_value value;
  napi_create_double(env, (double)limit.rlim_cur, &value);
  return value;
}

static napi_value get_linux_dumpable(napi_env env, napi_callback_info info) {
  (void)info;
#if defined(__linux__)
  int dumpable = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  if (dumpable < 0) {
    return throw_errno(env, "prctl(PR_GET_DUMPABLE)", errno);
  }
  napi_value value;
  napi_create_int32(env, dumpable, &value);
  return value;
#else
  return throw_unsupported(env, "Linux dumpability is not supported on this platform");
#endif
}

NAPI_MODULE_INIT() {
  napi_property_descriptor descriptors[] = {
    {
      "setCoreFileSizeLimitToZero",
      0,
      set_core_file_size_limit_to_zero,
      0,
      0,
      0,
      napi_default,
      0,
    },
    {
      "disableProcessDumping",
      0,
      disable_process_dumping,
      0,
      0,
      0,
      napi_default,
      0,
    },
    {
      "getCoreFileSizeLimit",
      0,
      get_core_file_size_limit,
      0,
      0,
      0,
      napi_default,
      0,
    },
    {
      "getLinuxDumpable",
      0,
      get_linux_dumpable,
      0,
      0,
      0,
      napi_default,
      0,
    },
  };
  napi_define_properties(env, exports, 4, descriptors);
  return exports;
}
`;

const NATIVE_SOURCE_HASH = createHash("sha256")
  .update(NATIVE_ADDON_SOURCE)
  .digest("hex")
  .slice(0, 16);

interface NativeHardeningCacheManifest {
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly modules: string;
}

export function buildHardenedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  scrubDangerousEnvironment(next);
  return next;
}

export function scrubDangerousEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (isDangerousEnvKey(key)) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed.sort();
}

function isDangerousEnvKey(key: string): boolean {
  return DANGEROUS_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Run this before loading user code, provider clients, or long-lived agent state.
 * The default mode fails closed; diagnostics that need observation without a
 * throw should call applyBestEffortPreMainProcessHardening instead.
 */
export function applyPreMainProcessHardening(
  options: ProcessHardeningOptions = {},
): ProcessHardeningResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const nativeMode = options.nativeMode ?? "required";
  const steps: ProcessHardeningStepResult[] = [];
  const scrubbedEnvKeys = scrubDangerousEnvironment(env);
  steps.push({
    operation: "scrub_environment",
    status: "applied",
    method: "process.env",
    detail: `removed ${scrubbedEnvKeys.length} environment variable(s)`,
  });

  if (isUnixPlatform(platform)) {
    const native = loadNativeHardeningBinding(options, nativeMode);
    if (native.binding) {
      steps.push(runNativeStep(
        "set_core_limit",
        "native.setrlimit",
        native.binding.setCoreFileSizeLimitToZero,
      ));
      steps.push(runNativeStep(
        "disable_process_dumping",
        platform === "darwin" ? "native.ptrace" : "native.prctl",
        native.binding.disableProcessDumping,
      ));
    } else {
      steps.push(applyCoreLimitWithPrlimit(
        platform,
        options.execFileSync ?? execFileSync,
      ));
      steps.push({
        operation: "disable_process_dumping",
        status: native.error ? "failed" : "unsupported",
        method: "native",
        detail: native.error ? undefined : "native binding unavailable",
        error: native.error,
      });
    }
  } else {
    steps.push({
      operation: "set_core_limit",
      status: "unsupported",
      method: "native",
      detail: `platform ${platform} does not expose Unix core limits`,
    });
    steps.push({
      operation: "disable_process_dumping",
      status: "unsupported",
      method: "native",
      detail: `platform ${platform} does not expose Unix ptrace controls`,
    });
  }

  const result = { platform, scrubbedEnvKeys, steps };
  if (nativeMode === "required" && steps.some((step) => step.status !== "applied")) {
    throw new ProcessHardeningError("process hardening did not fully apply", result);
  }
  return result;
}

export function applyBestEffortPreMainProcessHardening(
  options: BestEffortProcessHardeningOptions = {},
): ProcessHardeningResult {
  return applyPreMainProcessHardening({
    ...options,
    nativeMode: "auto",
  });
}

function runNativeStep(
  operation: ProcessHardeningOperation,
  method: string,
  fn: () => void,
): ProcessHardeningStepResult {
  try {
    fn();
    return { operation, status: "applied", method };
  } catch (error) {
    return {
      operation,
      status: "failed",
      method,
      error: errorMessage(error),
    };
  }
}

function applyCoreLimitWithPrlimit(
  platform: NodeJS.Platform,
  runExecFileSync: typeof execFileSync,
): ProcessHardeningStepResult {
  if (platform !== "linux") {
    return {
      operation: "set_core_limit",
      status: "unsupported",
      method: "prlimit",
      detail: "prlimit fallback is Linux-only",
    };
  }
  try {
    runExecFileSync("prlimit", [
      "--pid",
      String(process.pid),
      "--core=0:0",
    ], { stdio: "pipe" });
    return {
      operation: "set_core_limit",
      status: "applied",
      method: "child_process.execFileSync(prlimit)",
    };
  } catch (error) {
    return {
      operation: "set_core_limit",
      status: "failed",
      method: "child_process.execFileSync(prlimit)",
      error: errorMessage(error),
    };
  }
}

function loadNativeHardeningBinding(
  options: ProcessHardeningOptions,
  nativeMode: NativeHardeningMode,
): NativeHardeningBindingLoadResult {
  if (nativeMode === "off") return { binding: null };
  if (options.nativeBinding) return { binding: options.nativeBinding };
  if (options.nativeAddonPath) {
    try {
      return {
        binding: loadNativeHardeningBindingFromPath(options.nativeAddonPath),
      };
    } catch (error) {
      return { binding: null, error: errorMessage(error) };
    }
  }
  if (!options.allowRuntimeNativeBuild) {
    return {
      binding: null,
      error: "runtime native hardening build disabled; provide a trusted native binding or native addon path",
    };
  }
  try {
    return { binding: compileAndLoadNativeHardeningBinding(options) };
  } catch (error) {
    return { binding: null, error: errorMessage(error) };
  }
}

function loadNativeHardeningBindingFromPath(addonPath: string): NativeHardeningBinding {
  assertTrustedNativeAddonFile(addonPath);
  const loaded = createRequire(import.meta.url)(addonPath) as NativeHardeningBinding;
  assertNativeBinding(loaded);
  return loaded;
}

export function compileAndLoadNativeHardeningBinding(
  options: Pick<
    ProcessHardeningOptions,
    "cacheDir" | "compiler" | "execFileSync" | "nodeIncludeDir" | "platform"
  > = {},
): NativeHardeningBinding {
  const platform = options.platform ?? process.platform;
  const dir = options.cacheDir ?? defaultNativeCacheDir(platform);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  securePrivateDirectory(dir);
  const addonPath = path.join(dir, "agenc-process-hardening.node");
  const manifestPath = path.join(dir, "manifest.json");
  const needsBuild = !isNativeCacheCurrent(addonPath, manifestPath, platform);

  if (needsBuild) {
    rebuildNativeHardeningBinding({
      addonPath,
      cacheDir: dir,
      compiler: options.compiler ?? "cc",
      manifestPath,
      nodeIncludeDir: options.nodeIncludeDir,
      platform,
      runExecFileSync: options.execFileSync ?? execFileSync,
    });
  }

  assertSafeCacheFile(addonPath);
  assertSafeCacheFile(manifestPath);
  const loaded = createRequire(import.meta.url)(addonPath) as NativeHardeningBinding;
  assertNativeBinding(loaded);
  return loaded;
}

interface NativeHardeningBuildOptions {
  readonly addonPath: string;
  readonly cacheDir: string;
  readonly compiler: string;
  readonly manifestPath: string;
  readonly nodeIncludeDir?: string;
  readonly platform: NodeJS.Platform;
  readonly runExecFileSync: typeof execFileSync;
}

function rebuildNativeHardeningBinding(options: NativeHardeningBuildOptions): void {
  const buildDir = mkdtempSync(path.join(options.cacheDir, ".build-"));
  chmodSync(buildDir, 0o700);
  const buildAddonPath = path.join(buildDir, "agenc-process-hardening.node");
  const buildManifestPath = path.join(buildDir, "manifest.json");
  const sourcePath = path.join(buildDir, "agenc-process-hardening.c");

  try {
    writeFileSync(sourcePath, NATIVE_ADDON_SOURCE, { mode: 0o600 });
    const includeDir = resolveNodeIncludeDir(options.nodeIncludeDir);
    options.runExecFileSync(options.compiler, nativeHardeningCompilerArgs({
      addonPath: buildAddonPath,
      includeDir,
      platform: options.platform,
      sourcePath,
    }), { stdio: "pipe" });
    chmodSync(buildAddonPath, 0o600);
    const manifest = createNativeCacheManifest(buildAddonPath, options.platform);
    writeFileSync(
      buildManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(buildAddonPath, options.addonPath);
    renameSync(buildManifestPath, options.manifestPath);
    chmodSync(options.addonPath, 0o600);
    chmodSync(options.manifestPath, 0o600);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

function nativeHardeningCompilerArgs(options: {
  readonly addonPath: string;
  readonly includeDir: string;
  readonly platform: NodeJS.Platform;
  readonly sourcePath: string;
}): string[] {
  const common = [
    "-fPIC",
    "-I",
    options.includeDir,
    "-o",
    options.addonPath,
    options.sourcePath,
  ];
  if (options.platform === "darwin") {
    return [
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      ...common,
    ];
  }
  return [
    "-shared",
    ...common,
  ];
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
    const manifest = JSON.parse(readFileSync(
      manifestPath,
      "utf8",
    )) as NativeHardeningCacheManifest;
    return manifest.sourceHash === NATIVE_SOURCE_HASH &&
      manifest.platform === platform &&
      manifest.arch === process.arch &&
      manifest.modules === process.versions.modules &&
      manifest.artifactHash === fileSha256(addonPath);
  } catch {
    return false;
  }
}

function createNativeCacheManifest(
  addonPath: string,
  platform: NodeJS.Platform,
): NativeHardeningCacheManifest {
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
    throw new Error(`native hardening cache path is not a directory: ${dir}`);
  }
  assertOwnedByCurrentUser(dir, stats.uid);
  chmodSync(dir, 0o700);
  const updated = statSync(dir);
  if ((updated.mode & 0o077) !== 0) {
    throw new Error(`native hardening cache directory is not private: ${dir}`);
  }
}

function assertSafeCacheFile(filePath: string): void {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`native hardening cache entry is not a regular file: ${filePath}`);
  }
  assertOwnedByCurrentUser(filePath, stats.uid);
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`native hardening cache file is writable by group or others: ${filePath}`);
  }
}

function assertTrustedNativeAddonFile(filePath: string): void {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`native hardening addon is not a regular file: ${filePath}`);
  }
  assertOwnedByCurrentOrRootUser(filePath, stats.uid);
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`native hardening addon is writable by group or others: ${filePath}`);
  }
}

function assertOwnedByCurrentUser(filePath: string, uid: number): void {
  if (typeof process.getuid !== "function") return;
  const currentUid = process.getuid();
  if (uid !== currentUid) {
    throw new Error(`native hardening cache entry is not owned by the current user: ${filePath}`);
  }
}

function assertOwnedByCurrentOrRootUser(filePath: string, uid: number): void {
  if (typeof process.getuid !== "function") return;
  const currentUid = process.getuid();
  if (uid !== currentUid && uid !== 0) {
    throw new Error(`native hardening addon is not owned by the current or root user: ${filePath}`);
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
  throw new Error("could not locate node_api.h for native hardening build");
}

function assertNativeBinding(value: NativeHardeningBinding): void {
  if (
    typeof value?.setCoreFileSizeLimitToZero !== "function" ||
    typeof value?.disableProcessDumping !== "function"
  ) {
    throw new Error("native hardening binding did not expose required functions");
  }
}

function defaultNativeCacheDir(platform: NodeJS.Platform): string {
  const cacheRoot = defaultUserCacheRoot(platform);
  return path.join(
    cacheRoot,
    "agenc",
    "agenc-process-hardening",
    `${platform}-${process.arch}-${process.versions.modules}-${NATIVE_SOURCE_HASH}`,
  );
}

function defaultUserCacheRoot(platform: NodeJS.Platform): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome && path.isAbsolute(xdgCacheHome)) return xdgCacheHome;

  const home = homedir();
  if (home) {
    if (platform === "darwin") return path.join(home, "Library", "Caches");
    return path.join(home, ".cache");
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(tmpdir(), `agenc-${uid}`);
}

function isUnixPlatform(platform: NodeJS.Platform): boolean {
  return [
    "aix",
    "android",
    "darwin",
    "freebsd",
    "linux",
    "openbsd",
    "sunos",
  ].includes(platform);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
