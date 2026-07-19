/**
 * `agenc update` — self-update the runtime from the public release manifest.
 *
 *   agenc update                     install the latest released runtime
 *   agenc update --check             report whether an update exists; no writes
 *   agenc update --pin <x.y.z>       install a specific release instead of latest
 *
 * Speaks the exact install contract shared by scripts/install/install.sh and
 * the npm launcher's runtime-manager (packages/agenc/lib/runtime-manager.mjs):
 * download the platform tarball named in agenc-runtime-manifest-v2.json, verify
 * its sha256, extract under <AGENC_HOME>/runtime/<version>/, record the sha in
 * the .agenc-runtime-ok marker, then repoint the generated shell wrapper at
 * the new runtime. Old runtime trees stay in place so a running daemon keeps
 * working until it is restarted.
 *
 * npm-launcher installs pin their runtime through the manifest bundled into
 * @tetsuo-ai/agenc, so there is no wrapper to rewrite — update detects that
 * and prints the `npm install -g` path instead of downloading anything.
 *
 * Trust boundary: the manifest, artifact, and Sigstore bundle are remote
 * release data. Official artifacts are verified before extraction with an
 * exact checksum-pinned GitHub CLI, bound to the AgenC source repository,
 * release workflow, source tag, source commit, and hosted-runner policy. The
 * runtime tarball itself is never executed; only wrappers carrying the
 * installer generation signature are ever rewritten.
 */

import {
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { gt as semverGt, lt as semverLt } from "../utils/semver.js";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveAgencHome } from "../config/env.js";
import { VERSION } from "../version.js";
import { validateRuntimeArchive } from "../utils/runtime-archive.js";
import {
  MAX_RUNTIME_ARTIFACT_BYTES,
  MAX_RUNTIME_ATTESTATION_BYTES,
  MAX_RUNTIME_MANIFEST_BYTES,
  OFFICIAL_RELEASE_WORKFLOW,
  OFFICIAL_RELEASE_REPOSITORY,
  OFFICIAL_SOURCE_REPOSITORY,
  PINNED_GITHUB_CLI_ARTIFACTS,
  PINNED_GITHUB_CLI_VERSION,
  canonicalRuntimeAttestationVerificationArgs,
  canonicalLocalFileUrlToPath,
  validateRuntimeReleaseManifest,
  type RuntimeManifestTrustMode,
  type RuntimeReleaseManifest,
} from "../utils/runtime-release-contract.js";
import {
  GENERATED_WRAPPER_MAX_BYTES,
  parseGeneratedWrapperContent,
  renderGeneratedWrapperContent,
  type GeneratedWrapper,
  type WrapperKind,
} from "../utils/generated-wrapper.js";
import {
  existingAgenCHomeIdentity,
  resolveActivationLockRegistry,
  wrapperActivationLockPath,
} from "../utils/activation-lock-identity.js";
import {
  acquireLocalSqliteLock,
  acquireLocalSqliteLocks,
  assertLocalPrivateDirectory,
  assertLocalPrivateFile,
} from "../utils/sqlite-lock.js";

export const DEFAULT_RELEASE_REPO = OFFICIAL_RELEASE_REPOSITORY;
export const MINIMUM_MODERN_UPDATE_VERSION = "0.7.1";
const RUNTIME_MARKER = ".agenc-runtime-ok";
const OFFICIAL_PROVENANCE_RECEIPT = ".agenc-official-provenance-v1.json";
const DEFAULT_UPDATE_FETCH_TIMEOUT_MS = 120_000;
const WINDOWS_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;

/**
 * Create an empty, private work directory without retaining a caller-supplied
 * alias. The parent and its complete chain are validated before any mutation;
 * a trusted sticky system temporary directory is accepted as a parent but not
 * as a private work leaf. This makes later failure cleanup safe by construction.
 */
export async function createPrivateUpdateWorkDirectory(options: {
  readonly parent: string;
  readonly prefix: string;
  readonly label: string;
  readonly timeoutMs: number;
  readonly deadline?: number;
}): Promise<string> {
  if (!/^[a-z0-9-]+$/i.test(options.prefix)) {
    throw new TypeError("private work directory prefix is invalid");
  }
  const resolvedParent = realpathSync.native(resolve(options.parent));
  const parent = await assertLocalPrivateDirectory(resolvedParent, {
    label: `${options.label} parent`,
    timeoutMs: options.timeoutMs,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    allowTrustedStickyLeaf: true,
  });
  if (parent !== resolvedParent) {
    throw new Error(`private work parent changed identity: ${resolvedParent}`);
  }
  const parentMetadata = lstatSync(parent, { bigint: true });
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error(`private work parent is not a real directory: ${parent}`);
  }
  const candidate = join(
    parent,
    `${options.prefix}${process.pid}-${randomUUID()}`,
  );
  mkdirSync(candidate, { mode: 0o700 });
  const before = lstatSync(candidate, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`private work directory is not a real directory: ${candidate}`);
  }
  if (
    process.platform !== "win32" &&
    (before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o077n) !== 0n)
  ) {
    throw new Error(`private work directory permissions are unsafe: ${candidate}`);
  }
  try {
    const canonical = await assertLocalPrivateDirectory(candidate, {
      label: options.label,
      timeoutMs: options.timeoutMs,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    });
    if (canonical !== candidate) {
      throw new Error(`private work directory changed identity: ${candidate}`);
    }
    const after = lstatSync(candidate, { bigint: true });
    if (
      !after.isDirectory() || after.isSymbolicLink() ||
      after.dev !== before.dev || after.ino !== before.ino
    ) {
      throw new Error(`private work directory changed during validation: ${candidate}`);
    }
    return canonical;
  } catch (error) {
    try { rmSync(candidate, { recursive: true, force: true }); } catch { /* preserve validation error */ }
    throw error;
  }
}

export type AgenCUpdateCliCommand =
  | {
      readonly kind: "update";
      readonly check: boolean;
      readonly json: boolean;
      readonly pinVersion?: string;
      readonly manifestUrl?: string;
      readonly repo?: string;
      readonly wrapper?: string;
    }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function formatAgenCUpdateCliHelpText(): string {
  return [
    "agenc update — update the AgenC runtime to the latest public release",
    "",
    "Usage:",
    "  agenc update                    Download, verify, and install the latest runtime",
    "  agenc update --check            Report whether an update is available (no writes)",
    "  agenc update --pin <x.y.z>      Install a specific release instead of latest",
    "",
    "Options:",
    "  --check               Check only; never downloads or writes",
    "  --json                Machine-readable result on stdout",
    "  --pin <x.y.z>         Pin a release version",
    "  --repo <owner/name>   Release repository (default: " +
      DEFAULT_RELEASE_REPO +
      ")",
    "  --manifest-url <url>  Manifest override (supports file:// for testing)",
    "  --wrapper <path>      Explicit wrapper script to repoint",
    "  -h, --help            Show this help text",
    "",
    "The new runtime installs side by side under <AGENC_HOME>/runtime/<version>/",
    "with sha256 verification, then the `agenc` wrapper generated by install.sh",
    "is repointed. A running daemon keeps the old version until restarted:",
    "  agenc daemon restart",
    "",
    "npm-launcher installs (`npm install -g @tetsuo-ai/agenc`) update with:",
    "  npm install -g @tetsuo-ai/agenc@latest",
    "",
    "Examples:",
    "  agenc update --check",
    "  agenc update",
  ].join("\n");
}

function takeFlagValue(
  rest: readonly string[],
  index: number,
  flag: string,
): { value: string } | { error: string } {
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("-")) {
    return { error: `${flag} needs a value` };
  }
  return { value };
}

export function parseAgenCUpdateCliArgs(
  argv: readonly string[],
): AgenCUpdateCliCommand | null {
  if (argv[0] !== "update") return null;
  const rest = argv.slice(1);
  let check = false;
  let json = false;
  let pinVersion: string | undefined;
  let manifestUrl: string | undefined;
  let repo: string | undefined;
  let wrapper: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "-h" || arg === "--help") {
      return { kind: "help", text: formatAgenCUpdateCliHelpText() };
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--pin" || arg === "--manifest-url" || arg === "--repo" || arg === "--wrapper") {
      const taken = takeFlagValue(rest, i, arg);
      if ("error" in taken) return { kind: "error", message: taken.error };
      if (arg === "--pin") pinVersion = taken.value;
      else if (arg === "--manifest-url") manifestUrl = taken.value;
      else if (arg === "--repo") repo = taken.value;
      else wrapper = taken.value;
      i += 1;
      continue;
    }
    return {
      kind: "error",
      message: `unknown update option '${arg}' (see 'agenc help update')`,
    };
  }
  if (pinVersion !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pinVersion)) {
    return { kind: "error", message: `--pin expects a semver version, got '${pinVersion}'` };
  }
  return {
    kind: "update",
    check,
    json,
    ...(pinVersion !== undefined ? { pinVersion } : {}),
    ...(manifestUrl !== undefined ? { manifestUrl } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(wrapper !== undefined ? { wrapper } : {}),
  };
}

// --- manifest -----------------------------------------------------------------

export interface RuntimeManifestArtifact {
  readonly platform: string;
  readonly arch: string;
  readonly runtimeVersion: string;
  readonly nodeMajor: number;
  readonly nodeModuleAbi: string;
  readonly nodeApiVersion: string;
  readonly libcFamily?: string;
  readonly minimumGlibcVersion?: string;
  readonly minimumGlibcxxVersion?: string;
  readonly minimumCxxAbiVersion?: string;
  readonly minimumMacosVersion?: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly attestationUrl?: string;
  readonly attestationSha256?: string;
  readonly attestationBytes?: number;
  readonly bins?: { readonly agenc?: string };
}

export interface UpdateRuntimeCompatibility {
  readonly platform: string;
  readonly arch: string;
  readonly nodeMajor: number;
  readonly nodeModuleAbi: string;
  readonly libcFamily?: string;
  readonly glibcVersion?: string;
  readonly glibcxxVersion?: string;
  readonly cxxAbiVersion?: string;
  readonly macosVersion?: string;
}

function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function maximumLibrarySymbolVersion(path: string, namespace: string): string | undefined {
  const raw = readFileSync(path).toString("latin1");
  const pattern = new RegExp(`\\b${namespace}_(\\d+\\.\\d+(?:\\.\\d+)?)\\b`, "g");
  let maximum: string | undefined;
  for (const match of raw.matchAll(pattern)) {
    const version = match[1];
    if (maximum === undefined || compareDottedVersions(version, maximum) > 0) {
      maximum = version;
    }
  }
  return maximum;
}

export function currentUpdateRuntimeCompatibility(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  nodeModuleAbi: string = process.versions.modules,
): UpdateRuntimeCompatibility {
  const os = platform === "win32" ? "win" : platform;
  const base = {
    platform: os,
    arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    nodeModuleAbi,
  };
  if (os === "darwin") {
    const result = spawnSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
    });
    return {
      ...base,
      ...(result.status === 0 ? { macosVersion: result.stdout.trim() } : {}),
    };
  }
  if (os !== "linux") return base;
  const report = process.report?.getReport() as unknown as
    | {
        readonly header?: { readonly glibcVersionRuntime?: string };
        readonly sharedObjects?: readonly string[];
      }
    | undefined;
  const glibcVersion = report?.header?.glibcVersionRuntime;
  const library = report?.sharedObjects?.find((path: string) =>
    basename(path).startsWith("libstdc++.so.6"),
  );
  if (typeof glibcVersion !== "string") return { ...base, libcFamily: "unknown" };
  return {
    ...base,
    libcFamily: "glibc",
    glibcVersion,
    ...(library !== undefined
      ? {
          glibcxxVersion: maximumLibrarySymbolVersion(library, "GLIBCXX"),
          cxxAbiVersion: maximumLibrarySymbolVersion(library, "CXXABI"),
        }
      : {}),
  };
}

function assertUpdateArtifactCompatible(
  artifact: RuntimeManifestArtifact,
  runtime: UpdateRuntimeCompatibility,
): void {
  if (artifact.nodeMajor !== runtime.nodeMajor) {
    throw new Error(
      `runtime requires Node ${artifact.nodeMajor}.x; current Node is ${runtime.nodeMajor}.x`,
    );
  }
  const dotted = /^\d+\.\d+(?:\.\d+)?$/;
  if (runtime.platform === "darwin") {
    if (!dotted.test(artifact.minimumMacosVersion ?? "") ||
        !dotted.test(runtime.macosVersion ?? "")) {
      throw new Error("could not validate macOS compatibility");
    }
    if (compareDottedVersions(runtime.macosVersion!, artifact.minimumMacosVersion!) < 0) {
      throw new Error(
        `runtime requires macOS ${artifact.minimumMacosVersion} or newer; ` +
          `host provides ${runtime.macosVersion}`,
      );
    }
    return;
  }
  if (runtime.platform !== "linux") return;
  if (artifact.libcFamily !== "glibc" || runtime.libcFamily !== "glibc") {
    throw new Error("Linux runtime requires glibc; musl/unknown libc is unsupported");
  }
  const requirements = [
    [artifact.minimumGlibcVersion, runtime.glibcVersion, "glibc"],
    [artifact.minimumGlibcxxVersion, runtime.glibcxxVersion, "GLIBCXX"],
    [artifact.minimumCxxAbiVersion, runtime.cxxAbiVersion, "CXXABI"],
  ] as const;
  for (const [minimum, current, label] of requirements) {
    if (!dotted.test(minimum ?? "") || !dotted.test(current ?? "")) {
      throw new Error(`could not validate ${label} compatibility`);
    }
    if (compareDottedVersions(current!, minimum!) < 0) {
      throw new Error(
        `Linux runtime requires ${label} ${minimum} or newer; host provides ${current}`,
      );
    }
  }
}

function updateArtifactKey(artifact: RuntimeManifestArtifact): string {
  if (!/^(linux|darwin|win)$/.test(artifact.platform) ||
      !/^(x64|arm64)$/.test(artifact.arch) ||
      !/^\d+$/.test(artifact.nodeModuleAbi)) {
    throw new Error("manifest artifact has invalid platform/arch/ABI identity");
  }
  const libc = artifact.platform === "linux" ? artifact.libcFamily : "native";
  if (artifact.platform === "linux" && libc !== "glibc") {
    throw new Error("manifest Linux artifact has invalid libc identity");
  }
  return `${artifact.platform}-${artifact.arch}-${libc}-node-abi-${artifact.nodeModuleAbi}`;
}

function updateInstallKey(artifact: RuntimeManifestArtifact): string {
  return `${updateArtifactKey(artifact)}-sha256-${artifact.sha256}`;
}

export interface RuntimeManifest {
  readonly manifestVersion: 2;
  readonly runtimeVersion: string;
  readonly releaseRepository: string;
  readonly releaseTag: string;
  readonly build?: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly RuntimeManifestArtifact[];
}

export interface ResolvedUpdateManifestRequest {
  readonly url: string;
  readonly trustMode: RuntimeManifestTrustMode;
  readonly expectedRuntimeVersion?: string;
  readonly expectedRepository?: string;
}

function parseManifestOverride(url: string): ResolvedUpdateManifestRequest {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid manifest URL");
  }
  if (parsed.protocol === "file:") {
    canonicalLocalFileUrlToPath(url, undefined, "local runtime manifest URL");
    return { url, trustMode: "explicitLocal" };
  }
  if (parsed.protocol !== "https:") {
    throw new Error("manifest URL must use HTTPS or an explicit file URL");
  }
  return { url: parsed.href, trustMode: "explicitHttps" };
}

export function resolveUpdateManifestRequest(options: {
  readonly pinVersion?: string;
  readonly manifestUrl?: string;
  readonly repo?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ResolvedUpdateManifestRequest {
  const env = options.env ?? process.env;
  if (
    options.pinVersion !== undefined &&
    semverLt(options.pinVersion, MINIMUM_MODERN_UPDATE_VERSION)
  ) {
    throw new Error(
      `agenc update supports pinned releases ${MINIMUM_MODERN_UPDATE_VERSION} or newer; ` +
      `${options.pinVersion} has no published modern v2 update contract`,
    );
  }
  if (options.manifestUrl !== undefined) {
    return {
      ...parseManifestOverride(options.manifestUrl),
      ...(options.pinVersion === undefined
        ? {}
        : { expectedRuntimeVersion: options.pinVersion }),
    };
  }
  const envUrl = env.AGENC_INSTALL_MANIFEST_URL?.trim();
  if (envUrl !== undefined && envUrl.length > 0) {
    return {
      ...parseManifestOverride(envUrl),
      ...(options.pinVersion === undefined
        ? {}
        : { expectedRuntimeVersion: options.pinVersion }),
    };
  }
  const repo = options.repo ?? env.AGENC_INSTALL_REPO?.trim() ?? DEFAULT_RELEASE_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("release repository must use owner/name syntax");
  }
  const filename = "agenc-runtime-manifest-v2.json";
  const url = options.pinVersion === undefined
    ? `https://github.com/${repo}/releases/latest/download/${filename}`
    : `https://github.com/${repo}/releases/download/agenc-v${options.pinVersion}/${filename}`;
  return {
    url,
    trustMode: repo === DEFAULT_RELEASE_REPO ? "official" : "explicitHttps",
    expectedRepository: repo,
    ...(options.pinVersion === undefined
      ? {}
      : { expectedRuntimeVersion: options.pinVersion }),
  };
}

export function resolveUpdateManifestUrl(options: {
  readonly pinVersion?: string;
  readonly manifestUrl?: string;
  readonly repo?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  return resolveUpdateManifestRequest(options).url;
}

export function updatePlatformSlug(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { os: string; arch: string } {
  return { os: platform === "win32" ? "win" : platform, arch };
}

interface FetchDeadline {
  readonly controller: AbortController;
  readonly deadline: number;
  readonly timeoutMs: number;
}

function createFetchDeadline(timeoutMs: number): FetchDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("update fetch timeoutMs must be a positive safe integer");
  }
  return {
    controller: new AbortController(),
    deadline: performance.now() + timeoutMs,
    timeoutMs,
  };
}

async function waitForFetchDeadline<T>(
  operation: PromiseLike<T>,
  guard: FetchDeadline,
  label: string,
): Promise<T> {
  const remaining = Math.ceil(guard.deadline - performance.now());
  if (remaining <= 0) {
    guard.controller.abort();
    throw new Error(`${label} timed out after ${guard.timeoutMs}ms`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${guard.timeoutMs}ms`));
      guard.controller.abort();
    }, remaining);
  });
  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchToFile(
  url: string,
  dest: string,
  expectedBytes: number,
  trustMode: RuntimeManifestTrustMode,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  limits: {
    readonly maximumBytes?: number;
    readonly label?: string;
  } = {},
): Promise<void> {
  const maximumBytes = limits.maximumBytes ?? MAX_RUNTIME_ARTIFACT_BYTES;
  const label = limits.label ?? "runtime artifact";
  if (
    !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 ||
    expectedBytes > maximumBytes
  ) {
    throw new Error(
      `${label} signed size must be between 1 and ${maximumBytes} bytes`,
    );
  }
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    if (trustMode !== "explicitLocal") {
      throw new Error("remote runtime manifests must not access local files");
    }
    const path = canonicalLocalFileUrlToPath(
      url,
      undefined,
      "local runtime artifact URL",
    );
    const metadata = lstatSync(path, { bigint: true });
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    ) {
      throw new Error("local runtime artifact must be a regular single-link file");
    }
    if (metadata.size !== BigInt(expectedBytes)) {
      throw new Error(
        `runtime byte count mismatch (expected ${expectedBytes}, got ${metadata.size})`,
      );
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_RDONLY |
          (fsConstants.O_NOFOLLOW ?? 0) |
          (fsConstants.O_NONBLOCK ?? 0),
      );
      const opened = fstatSync(descriptor, { bigint: true });
      if (
        !opened.isFile() || opened.nlink !== 1n ||
        opened.dev !== metadata.dev || opened.ino !== metadata.ino ||
        opened.size !== BigInt(expectedBytes)
      ) {
        throw new Error("local runtime artifact changed while it was opened");
      }
      await pipeline(
        createReadStream(path, { fd: descriptor, autoClose: false }),
        (source) => requireExactRuntimeBytes(source, expectedBytes),
        createWriteStream(dest, { flags: "wx", mode: 0o600 }),
      );
      const after = fstatSync(descriptor, { bigint: true });
      const pathAfter = lstatSync(path, { bigint: true });
      if (
        after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== BigInt(expectedBytes) ||
        pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
        pathAfter.nlink !== 1n
      ) {
        throw new Error("local runtime artifact identity changed while it was read");
      }
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* preserve the transfer error */ }
      }
    }
    return;
  }
  if (trustMode === "explicitLocal" || parsed.protocol !== "https:") {
    throw new Error("remote runtime manifests may only use HTTPS artifact URLs");
  }
  const guard = createFetchDeadline(timeoutMs);
  let response: Response | undefined;
  try {
    response = await fetchHttpsWithReviewedRedirects(
      url,
      fetchImpl,
      label,
      guard,
    );
    const res = response;
    if (!res.ok || res.body === null) {
      throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
    }
    const encoding = res.headers?.get?.("content-encoding");
    if (encoding !== null && encoding !== undefined && encoding !== "identity") {
      throw new Error(`${label} response must use identity encoding`);
    }
    let contentLength: number | undefined;
    contentLength = responseContentLength(res, label);
    if (contentLength !== undefined && contentLength !== expectedBytes) {
      throw new Error(
        `${label} Content-Length mismatch ` +
        `(expected ${expectedBytes}, got ${contentLength})`,
      );
    }
    const readable = typeof res.body.getReader === "function"
      ? Readable.fromWeb(
          res.body as unknown as import("node:stream/web").ReadableStream,
        )
      : res.body as unknown as AsyncIterable<Uint8Array>;
    await pipeline(
      readable,
      (source: AsyncIterable<unknown>) =>
        requireExactRuntimeBytes(source, expectedBytes, guard, label),
      createWriteStream(dest, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    if (response !== undefined) await cancelResponseBody(response, guard);
    throw error;
  } finally {
    guard.controller.abort();
  }
}

async function* requireExactRuntimeBytes(
  source: AsyncIterable<unknown>,
  expectedBytes: number,
  guard?: FetchDeadline,
  label = "runtime artifact",
): AsyncGenerator<Buffer> {
  let received = 0;
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = guard === undefined
        ? await iterator.next()
        : await waitForFetchDeadline(
            iterator.next(),
            guard,
            `${label} body`,
          );
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value as Uint8Array);
      received += chunk.length;
      if (received > expectedBytes) {
        throw new Error(
          `${label} byte count exceeds signed size ` +
          `(expected ${expectedBytes}, received at least ${received})`,
        );
      }
      yield chunk;
    }
  } finally {
    const returning = iterator.return?.();
    if (returning !== undefined) {
      if (guard === undefined) {
        // Local sources are regular bounded files, so their iterator cleanup
        // cannot wait on an attacker-controlled transport.
        await returning;
      } else {
        try {
          await waitForFetchDeadline(
            returning,
            guard,
            `${label} body cancellation`,
          );
        } catch {
          void Promise.resolve(returning).catch(() => undefined);
        }
      }
    }
  }
  if (received !== expectedBytes) {
    throw new Error(
      `${label} byte count mismatch (expected ${expectedBytes}, got ${received})`,
    );
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchHttpsWithReviewedRedirects(
  url: string,
  fetchImpl: typeof fetch,
  label: string,
  guard: FetchDeadline,
): Promise<Response> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error(`invalid ${label} URL`);
  }
  if (current.protocol !== "https:") {
    throw new Error(`refusing non-https ${label} URL: ${current.href}`);
  }
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await waitForFetchDeadline(
      fetchImpl(current, {
        redirect: "manual",
        headers: { "accept-encoding": "identity" },
        signal: guard.controller.signal,
      }),
      guard,
      `${label} response`,
    );
    if (!REDIRECT_STATUSES.has(response.status)) {
      let responseUrl: URL | undefined;
      try {
        responseUrl = typeof response.url === "string" && response.url.length > 0
          ? new URL(response.url)
          : undefined;
      } catch {
        await cancelResponseBody(response, guard);
        throw new Error(`${label} response URL is invalid`);
      }
      if (
        response.redirected ||
        (responseUrl !== undefined &&
          (responseUrl.protocol !== "https:" || responseUrl.href !== current.href))
      ) {
        await cancelResponseBody(response, guard);
        throw new Error(`${label} fetch performed an unreviewed redirect`);
      }
      return response;
    }
    const location = response.headers.get("location");
    if (location === null) {
      await cancelResponseBody(response, guard);
      throw new Error(`${label} redirect is missing Location`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      await cancelResponseBody(response, guard);
      throw new Error(`${label} redirect Location is invalid`);
    }
    if (next.protocol !== "https:") {
      await cancelResponseBody(response, guard);
      throw new Error(`refusing HTTPS downgrade while fetching ${label}`);
    }
    await cancelResponseBody(response, guard);
    current = next;
  }
  throw new Error(`too many redirects while fetching ${label}`);
}

async function readBoundedLocalManifest(url: string): Promise<string> {
  const path = canonicalLocalFileUrlToPath(
    url,
    undefined,
    "local runtime manifest URL",
  );
  await assertLocalPrivateFile(path, {
    label: "local runtime manifest validation",
    timeoutMs: 60_000,
  });
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > BigInt(MAX_RUNTIME_MANIFEST_BYTES)
    ) {
      throw new Error("local runtime manifest must be a bounded regular single-link file");
    }
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() || opened.nlink !== 1n ||
      opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs ||
      opened.size > BigInt(MAX_RUNTIME_MANIFEST_BYTES)
    ) {
      throw new Error("local runtime manifest changed while it was opened");
    }
    const bytes = Buffer.alloc(MAX_RUNTIME_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_RUNTIME_MANIFEST_BYTES) {
      throw new Error(`runtime manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      after.dev !== opened.dev || after.ino !== opened.ino ||
      after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
      after.size !== BigInt(length) ||
      pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
      pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs ||
      pathAfter.nlink !== 1n
    ) {
      throw new Error("local runtime manifest identity changed while it was read");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new Error("runtime manifest is not valid UTF-8");
    }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the validation error */ }
    }
  }
}

function responseContentLength(response: Response, label: string): number | undefined {
  const value = response.headers?.get?.("content-length");
  if (value === null || value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} Content-Length is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} Content-Length is invalid`);
  }
  return parsed;
}

async function cancelResponseBody(
  response: Response,
  guard: FetchDeadline,
): Promise<void> {
  let cancellation: Promise<void> | undefined;
  try {
    cancellation = response.body?.cancel();
  } catch {
    return;
  }
  if (cancellation === undefined) return;
  try {
    await waitForFetchDeadline(
      cancellation,
      guard,
      "runtime response cancellation",
    );
  } catch {
    // The transport is also aborted by the owning fetch boundary. Never let a
    // hostile cancel() implementation hold or replace the primary policy error.
    void Promise.resolve(cancellation).catch(() => undefined);
  }
}

async function readBoundedManifestResponse(
  response: Response,
  guard: FetchDeadline,
): Promise<string> {
  const encoding = response.headers?.get?.("content-encoding");
  if (encoding !== null && encoding !== undefined && encoding !== "identity") {
    await cancelResponseBody(response, guard);
    throw new Error("runtime manifest response must use identity encoding");
  }
  let declaredLength: number | undefined;
  try {
    declaredLength = responseContentLength(response, "runtime manifest");
  } catch (error) {
    await cancelResponseBody(response, guard);
    throw error;
  }
  if (declaredLength !== undefined && declaredLength > MAX_RUNTIME_MANIFEST_BYTES) {
    await cancelResponseBody(response, guard);
    throw new Error(`runtime manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
  }
  if (response.body === null) throw new Error("runtime manifest response has no body");
  const source = typeof response.body.getReader === "function"
    ? Readable.fromWeb(
        response.body as unknown as import("node:stream/web").ReadableStream,
      )
    : response.body as unknown as AsyncIterable<Uint8Array>;
  const chunks: Buffer[] = [];
  let received = 0;
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await waitForFetchDeadline(
        iterator.next(),
        guard,
        "runtime manifest body",
      );
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      received += chunk.length;
      if (received > MAX_RUNTIME_MANIFEST_BYTES) {
        throw new Error(`runtime manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    const returning = iterator.return?.();
    if (returning !== undefined) {
      try {
        await waitForFetchDeadline(
          returning,
          guard,
          "runtime manifest body cancellation",
        );
      } catch {
        void Promise.resolve(returning).catch(() => undefined);
      }
    }
    await cancelResponseBody(response, guard);
    throw error;
  }
  if (declaredLength !== undefined && received !== declaredLength) {
    throw new Error(
      `runtime manifest Content-Length mismatch (expected ${declaredLength}, got ${received})`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, received));
  } catch {
    throw new Error("runtime manifest is not valid UTF-8");
  }
}

export async function fetchRuntimeManifest(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  options: {
    readonly trustMode?: RuntimeManifestTrustMode;
    readonly expectedRuntimeVersion?: string;
    readonly expectedRepository?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<RuntimeManifest> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("invalid manifest URL");
  }
  const trustMode = options.trustMode ??
    (parsedUrl.protocol === "file:" ? "explicitLocal" : "explicitHttps");
  if (
    (trustMode === "explicitLocal" && parsedUrl.protocol !== "file:") ||
    (trustMode !== "explicitLocal" && parsedUrl.protocol !== "https:")
  ) {
    throw new Error("runtime manifest URL does not match its trust mode");
  }
  if (trustMode === "official") {
    const officialUrl = options.expectedRuntimeVersion === undefined
      ? `https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/latest/download/` +
        "agenc-runtime-manifest-v2.json"
      : `https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/download/` +
        `agenc-v${options.expectedRuntimeVersion}/agenc-runtime-manifest-v2.json`;
    if (parsedUrl.href !== officialUrl) {
      throw new Error("official runtime manifest URL is not canonical");
    }
  }
  let raw: string;
  if (trustMode === "explicitLocal") {
    raw = await readBoundedLocalManifest(url);
  } else {
    const guard = createFetchDeadline(
      options.timeoutMs ?? DEFAULT_UPDATE_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetchHttpsWithReviewedRedirects(
        url,
        fetchImpl,
        "manifest",
        guard,
      );
      if (!response.ok) {
        await cancelResponseBody(response, guard);
        throw new Error(
          `manifest fetch failed ${response.status} ${response.statusText}: ${url}`,
        );
      }
      raw = await readBoundedManifestResponse(response, guard);
    } finally {
      guard.controller.abort();
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("runtime manifest is not valid JSON", { cause: error });
  }
  const manifest = validateRuntimeReleaseManifest(
    parsed as RuntimeReleaseManifest,
    {
      trustMode,
      ...(options.expectedRuntimeVersion === undefined
        ? {}
        : { expectedRuntimeVersion: options.expectedRuntimeVersion }),
    },
  ) as unknown as RuntimeManifest;
  if (
    options.expectedRepository !== undefined &&
    manifest.releaseRepository !== options.expectedRepository
  ) {
    throw new Error(
      `runtime manifest releaseRepository ${manifest.releaseRepository} ` +
      `does not match requested ${options.expectedRepository}`,
    );
  }
  return manifest;
}

export function selectUpdateArtifact(
  manifest: RuntimeManifest,
  slug: { os: string; arch: string } = updatePlatformSlug(),
  nodeModuleAbi: string = process.versions.modules,
  runtime: UpdateRuntimeCompatibility = currentUpdateRuntimeCompatibility(
    slug.os === "win" ? "win32" : slug.os as NodeJS.Platform,
    slug.arch,
    nodeModuleAbi,
  ),
): RuntimeManifestArtifact {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.runtimeVersion)) {
    throw new Error("manifest has an invalid runtimeVersion");
  }
  if (manifest.releaseTag !== undefined && manifest.releaseTag !== `agenc-v${manifest.runtimeVersion}`) {
    throw new Error("manifest releaseTag does not match runtimeVersion");
  }
  const matches = manifest.artifacts.filter(
    (a) =>
      a.platform === slug.os &&
      a.arch === slug.arch &&
      a.nodeModuleAbi === nodeModuleAbi,
  );
  if (matches.length > 1) {
    throw new Error(
      `manifest contains multiple builds for ${slug.os}-${slug.arch}/abi${nodeModuleAbi}`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    const have = manifest.artifacts
      .map((a) => `${a.platform}-${a.arch}/abi${a.nodeModuleAbi}`)
      .join(", ");
    throw new Error(
      `no runtime build for ${slug.os}-${slug.arch}/abi${nodeModuleAbi} ` +
        `(Node ${process.version}; available: ${have || "none"})`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(match.sha256 ?? "")) {
    throw new Error("manifest artifact is missing a valid sha256");
  }
  if (
    match.runtimeVersion !== manifest.runtimeVersion ||
    !Number.isSafeInteger(match.nodeMajor) ||
    !/^\d+$/.test(match.nodeApiVersion ?? "") ||
    !Number.isSafeInteger(match.bytes) ||
    match.bytes <= 0 ||
    match.bytes > MAX_RUNTIME_ARTIFACT_BYTES ||
    match.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc"
  ) {
    throw new Error("manifest artifact identity is invalid");
  }
  if (typeof match.url !== "string" || match.url.length === 0) {
    throw new Error("manifest artifact is missing a url");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(match.url);
  } catch {
    throw new Error("manifest artifact has an invalid url");
  }
  if (!["https:", "file:"].includes(parsedUrl.protocol)) {
    throw new Error("manifest artifact URL must use HTTPS");
  }
  if (
    parsedUrl.protocol === "https:" &&
    manifest.releaseRepository !== undefined &&
    manifest.releaseTag !== undefined
  ) {
    const artifactName =
      `agenc-runtime-${manifest.runtimeVersion}-${match.platform}-${match.arch}` +
      `-node${match.nodeMajor}-abi${match.nodeModuleAbi}.tar.gz`;
    const expected =
      `https://github.com/${manifest.releaseRepository}/releases/download/` +
      `${manifest.releaseTag}/${artifactName}`;
    if (match.url !== expected) throw new Error("manifest artifact URL is not canonical");
  }
  assertUpdateArtifactCompatible(match, runtime);
  return match;
}

// --- wrapper discovery ----------------------------------------------------------

export type { GeneratedWrapper, WrapperKind };

/** @deprecated Compatibility name for callers that predate Windows updater support. */
export type InstallShWrapper = GeneratedWrapper;

type WrapperValues = Omit<GeneratedWrapper, "kind" | "path">;

export function renderGeneratedWrapper(wrapper: {
  readonly kind: WrapperKind;
  readonly nodeBin: string;
  readonly runtimeBin: string;
  readonly agencHome: string;
}): string {
  return renderGeneratedWrapperContent(wrapper);
}

function parseGeneratedWrapperText(path: string, content: string): GeneratedWrapper | null {
  return parseGeneratedWrapperContent(path, content);
}

/** Parse only a byte-canonical wrapper generated by an AgenC standalone installer. */
export function parseGeneratedWrapper(path: string): GeneratedWrapper | null {
  const absolutePath = resolve(path);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(absolutePath, { bigint: true });
    if (
      !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > BigInt(GENERATED_WRAPPER_MAX_BYTES)
    ) return null;
    const safeReadFlags = fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0);
    descriptor = openSync(absolutePath, safeReadFlags);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() || opened.nlink !== 1n ||
      opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size > BigInt(GENERATED_WRAPPER_MAX_BYTES)
    ) return null;
    const bytes = Buffer.alloc(GENERATED_WRAPPER_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > GENERATED_WRAPPER_MAX_BYTES) return null;
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(absolutePath, { bigint: true });
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== BigInt(length) ||
      pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.nlink !== 1n
    ) return null;
    const content = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, length));
    return parseGeneratedWrapperText(absolutePath, content);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* a later parse/activation fails closed */ }
    }
  }
}

/** Parse a generated POSIX wrapper. Kept for source compatibility. */
export function parseInstallShWrapper(path: string): InstallShWrapper | null {
  const wrapper = parseGeneratedWrapper(path);
  return wrapper?.kind === "posix" ? wrapper : null;
}

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  name: string,
): string | undefined {
  if (platform !== "win32") return env[name];
  const exact = env[name];
  if (exact !== undefined) return exact;
  const match = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

export function findGeneratedWrapperCandidates(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
  readonly platform?: NodeJS.Platform;
}): string[] {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const platform = options.platform ?? process.platform;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const executableName = platform === "win32" ? "agenc.cmd" : "agenc";
  const dirs = new Map<string, string>();
  const rememberDir = (dir: string): void => {
    if (dir.length === 0) return;
    try {
      const canonical = realpathSync.native(resolve(dir));
      const stat = lstatSync(canonical, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      // Text case-folding is not an identity operation on case-sensitive NTFS.
      // Device/inode deduplicates aliases while retaining distinct directories.
      const unsupportedFileId = BigInt.asUintN(64, stat.ino) === 0xffff_ffff_ffff_ffffn;
      const key = stat.dev !== 0n && stat.ino !== 0n && stat.ino !== -1n && !unsupportedFileId
        ? `id:${stat.dev}:${stat.ino}`
        : `path:${canonical}`;
      if (!dirs.has(key)) dirs.set(key, canonical);
    } catch {
      // A missing/unreadable directory cannot contain an eligible wrapper.
    }
  };
  for (const dir of (environmentValue(env, platform, "PATH") ?? "").split(pathDelimiter)) {
    rememberDir(dir);
  }
  if (platform === "win32") {
    const localAppData = environmentValue(env, platform, "LOCALAPPDATA") ??
      join(userHome, "AppData", "Local");
    rememberDir(join(localAppData, "agenc", "bin"));
  } else {
    rememberDir(join(userHome, ".local", "bin"));
  }

  const found: string[] = [];
  for (const dir of dirs.values()) {
    const candidate = resolve(dir, executableName);
    try {
      const stats = lstatSync(candidate, { bigint: true });
      if (stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n) found.push(candidate);
    } catch {
      // A missing or non-inspectable entry is not a wrapper candidate.
    }
  }
  return found;
}

/**
 * Validate the complete wrapper-directory trust boundary before opening the
 * wrapper itself. This ordering prevents an attacker-controlled PATH entry
 * from substituting a symlink, FIFO, or device while update discovery reads it.
 */
export async function validateAndParseGeneratedWrapper(
  path: string,
  options: {
    readonly timeoutMs?: number;
    readonly deadline?: number;
    readonly label?: string;
  } = {},
): Promise<GeneratedWrapper> {
  const absolutePath = resolve(path);
  const canonicalPath = await assertLocalPrivateFile(absolutePath, {
    timeoutMs: options.timeoutMs,
    deadline: options.deadline,
    label: options.label ?? "wrapper validation",
  });
  if (canonicalPath !== absolutePath) {
    throw new Error(`wrapper must use its canonical path: ${absolutePath}`);
  }
  const wrapper = parseGeneratedWrapper(absolutePath);
  if (wrapper === null) {
    throw new Error(`wrapper is not a canonical regular file generated by AgenC: ${absolutePath}`);
  }
  return wrapper;
}

/**
 * Synchronous compatibility discovery. Mutation paths must additionally call
 * validateAndParseGeneratedWrapper before trusting or rewriting a result.
 */
export function findGeneratedWrappers(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
  readonly platform?: NodeJS.Platform;
}): GeneratedWrapper[] {
  const platform = options.platform ?? process.platform;
  const expectedKind: WrapperKind = platform === "win32" ? "cmd" : "posix";
  return findGeneratedWrapperCandidates(options)
    .map((path) => parseGeneratedWrapper(path))
    .filter((wrapper): wrapper is GeneratedWrapper => wrapper?.kind === expectedKind);
}

/** Find generated POSIX wrappers. Kept for source compatibility. */
export function findInstallShWrappers(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
}): InstallShWrapper[] {
  return findGeneratedWrappers({ ...options, platform: "linux" });
}

/** Render a generated POSIX wrapper. Kept for source compatibility. */
export function renderInstallShWrapper(wrapper: WrapperValues): string {
  return renderGeneratedWrapper({ kind: "posix", ...wrapper });
}

function canonicalizeAgenCHome(requested: string): string {
  if (!isAbsolute(requested)) {
    throw new Error(
      "AGENC_HOME must be an absolute path so its identity does not change with the working directory",
    );
  }
  const absolute = resolve(requested);
  const existed = existsSync(absolute);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const requestedStat = lstatSync(absolute);
  if (!requestedStat.isDirectory() && !requestedStat.isSymbolicLink()) {
    throw new Error(`AGENC_HOME is not a directory: ${absolute}`);
  }
  if (!existed && requestedStat.isSymbolicLink()) {
    throw new Error(`newly created AGENC_HOME became a symlink: ${absolute}`);
  }
  const canonical = realpathSync(absolute);
  const canonicalStat = lstatSync(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new Error(`canonical AGENC_HOME is not a real directory: ${canonical}`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    if (canonicalStat.uid !== process.getuid()) {
      throw new Error(`AGENC_HOME is owned by another user: ${canonical}`);
    }
    chmodSync(canonical, 0o700);
  }
  return canonical;
}

// --- runtime install (marker contract) -------------------------------------------

export interface InstallRuntimeResult {
  readonly binPath: string;
  readonly downloaded: boolean;
}

function strictRelativeRuntimeFile(root: string, relativePath: string): boolean {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) =>
      part.length === 0 || part === "." || part === "..")
  ) return false;
  const finalPath = resolve(root, relativePath);
  const within = relative(resolve(root), finalPath);
  if (
    within === "" ||
    within === ".." ||
    within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(within)
  ) return false;
  let current = root;
  const parts = relativePath.split(/[\\/]/);
  try {
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function strictRuntimeMarkerMatches(path: string, expectedSha: string): boolean {
  try {
    const marker = join(path, RUNTIME_MARKER);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) return false;
    const content = readFileSync(marker, "utf8");
    return content === expectedSha || content === `${expectedSha}\n`;
  } catch {
    return false;
  }
}

function renderOfficialProvenanceReceipt(
  manifest: RuntimeManifest,
  artifact: RuntimeManifestArtifact,
): string {
  const build = manifest.build as {
    readonly sourceCommit?: unknown;
    readonly sourceRef?: unknown;
  };
  if (
    typeof build.sourceCommit !== "string" || typeof build.sourceRef !== "string" ||
    typeof artifact.attestationSha256 !== "string"
  ) {
    throw new Error("official runtime manifest is missing receipt provenance");
  }
  return `${JSON.stringify({
    schemaVersion: 1,
    artifactSha256: artifact.sha256,
    attestationSha256: artifact.attestationSha256,
    sourceRepository: OFFICIAL_SOURCE_REPOSITORY,
    signerWorkflow: OFFICIAL_RELEASE_WORKFLOW,
    signerDigest: build.sourceCommit,
    sourceDigest: build.sourceCommit,
    sourceRef: build.sourceRef,
    oidcIssuer: "https://token.actions.githubusercontent.com",
    predicateType: "https://slsa.dev/provenance/v1",
    denySelfHostedRunners: true,
    verifier: `gh-${PINNED_GITHUB_CLI_VERSION}`,
  })}\n`;
}

function strictProvenanceReceiptMatches(
  path: string,
  expectedReceipt: string | undefined,
): boolean {
  if (expectedReceipt === undefined) return true;
  try {
    const receiptPath = join(path, OFFICIAL_PROVENANCE_RECEIPT);
    const metadata = lstatSync(receiptPath);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 &&
      metadata.size === Buffer.byteLength(expectedReceipt) &&
      readFileSync(receiptPath, "utf8") === expectedReceipt;
  } catch {
    return false;
  }
}

function runtimeInstallReadyAt(
  path: string,
  binRel: string,
  expectedSha: string,
  expectedProvenanceReceipt?: string,
): boolean {
  try {
    const root = lstatSync(path);
    return root.isDirectory() && !root.isSymbolicLink() &&
      strictRelativeRuntimeFile(path, binRel) &&
      strictRuntimeMarkerMatches(path, expectedSha) &&
      strictProvenanceReceiptMatches(path, expectedProvenanceReceipt);
  } catch {
    return false;
  }
}

function hasRuntimeInstallResidue(versionDir: string, base: string): boolean {
  return readdirSync(versionDir).some((name) =>
    name.startsWith(`.${base}.install-`) ||
    name.startsWith(`${base}.old-`));
}

function syncDirectoryEntry(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    fsyncSync(descriptor);
  } catch (error) {
    // Node cannot open directory handles for fsync on Windows. File handles
    // are still flushed before every rename; POSIX directory fsync failures
    // are real durability failures and must not be hidden.
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncRuntimeTree(path: string): void {
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path)) syncRuntimeTree(join(path, entry));
    syncDirectoryEntry(path);
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`runtime staging tree contains an unsupported entry: ${path}`);
  }
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() || opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino || opened.size !== metadata.size
    ) {
      throw new Error(`runtime staging entry changed while being flushed: ${path}`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function reconcileRuntimeInstall(
  versionDir: string,
  installDir: string,
  binRel: string,
  expectedSha: string,
  expectedProvenanceReceipt?: string,
): boolean {
  const base = basename(installDir);
  const entries = readdirSync(versionDir);
  const newestReady = (prefix: string): string | undefined => entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(versionDir, name))
    .filter((path) => runtimeInstallReadyAt(
      path,
      binRel,
      expectedSha,
      expectedProvenanceReceipt,
    ))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];

  if (!runtimeInstallReadyAt(
    installDir,
    binRel,
    expectedSha,
    expectedProvenanceReceipt,
  )) {
    const candidate = newestReady(`.${base}.install-`) ?? newestReady(`${base}.old-`);
    if (candidate !== undefined) promoteRuntimeInstall(candidate, installDir);
  }
  if (!runtimeInstallReadyAt(
    installDir,
    binRel,
    expectedSha,
    expectedProvenanceReceipt,
  )) return false;
  let removedResidue = false;
  for (const name of readdirSync(versionDir)) {
    if (name.startsWith(`.${base}.install-`) || name.startsWith(`${base}.old-`)) {
      try {
        rmSync(join(versionDir, name), { recursive: true, force: true });
        removedResidue = true;
      } catch { /* retry later */ }
    }
  }
  if (removedResidue) syncDirectoryEntry(versionDir);
  return true;
}

function promoteRuntimeInstall(stagingDir: string, installDir: string): void {
  const backup = `${installDir}.old-${process.pid}-${randomUUID()}`;
  const versionDir = dirname(installDir);
  let movedExisting = false;
  syncRuntimeTree(stagingDir);
  try {
    if (existsSync(installDir)) {
      renameSync(installDir, backup);
      syncDirectoryEntry(versionDir);
      movedExisting = true;
    }
    renameSync(stagingDir, installDir);
    syncDirectoryEntry(versionDir);
  } catch (error) {
    if (!existsSync(installDir) && movedExisting && existsSync(backup)) {
      try {
        renameSync(backup, installDir);
        syncDirectoryEntry(versionDir);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `runtime promotion failed; previous install retained at ${backup}`,
        );
      }
    }
    throw error;
  }
}

/**
 * Validate the result of extraction by the absolute operating-system tar path.
 * ENOENT means that trusted system component disappeared between resolution
 * and execution; retain a specific diagnostic while keeping other launch and
 * non-zero-exit failures distinct.
 */
export function assertTarExtractionSucceeded(
  res: Pick<OfficialProvenanceProcessResult, "error" | "status" | "signal" | "stderr">,
): void {
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "trusted operating-system tar disappeared before runtime extraction",
      );
    }
    throw new Error(`failed to run tar: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `tar extraction failed (status ${res.status ?? res.signal}): ${res.stderr?.toString() ?? ""}`,
    );
  }
}

interface TrustedSystemTar {
  readonly path: string;
  readonly env: NodeJS.ProcessEnv;
}

function assertRootOwnedSystemPath(path: string): string {
  const canonical = realpathSync.native(path);
  const current = lstatSync(canonical, { bigint: true });
  if (
    !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
    current.uid !== 0n || (current.mode & 0o022n) !== 0n
  ) {
    throw new Error(`system tar is not a root-owned immutable regular file: ${canonical}`);
  }
  for (let ancestor = dirname(canonical); ; ancestor = dirname(ancestor)) {
    const metadata = lstatSync(ancestor, { bigint: true });
    if (
      !metadata.isDirectory() || metadata.isSymbolicLink() ||
      metadata.uid !== 0n || (metadata.mode & 0o022n) !== 0n
    ) {
      throw new Error(`system tar has an untrusted path ancestor: ${ancestor}`);
    }
    if (dirname(ancestor) === ancestor) break;
  }
  return canonical;
}

/** Resolve an extractor independently of npm/project and caller environment mutation. */
export async function resolveTrustedSystemTar(
  platform: NodeJS.Platform = process.platform,
  runProcess: OfficialProvenanceProcessRunner = runBoundedProcess,
  timeoutMs = 30_000,
): Promise<TrustedSystemTar> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("trusted system tar timeout must be a positive safe integer");
  }
  if (platform === "linux") {
    const candidate = ["/usr/bin/tar", "/bin/tar"].find((path) => existsSync(path));
    if (candidate === undefined) throw new Error("trusted system tar is unavailable");
    return {
      path: assertRootOwnedSystemPath(candidate),
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    };
  }
  if (platform === "darwin") {
    return {
      path: assertRootOwnedSystemPath("/usr/bin/tar"),
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    };
  }
  if (platform !== "win32") {
    throw new Error(`trusted system tar is unsupported on ${platform}`);
  }
  // GLOBALROOT enters the kernel's real SystemRoot namespace and cannot be
  // redirected through caller-controlled SystemRoot/WINDIR values or drive
  // mappings. Keep the namespace path through execution rather than resolving
  // it back to a mutable DOS spelling.
  const systemRoot = WINDOWS_SYSTEM_ROOT;
  const system32 = win32.join(systemRoot, "System32");
  const powershellRoot = win32.join(system32, "WindowsPowerShell", "v1.0");
  const tarPath = win32.join(system32, "tar.exe");
  const metadata = lstatSync(tarPath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Windows system tar is not a regular file");
  }
  const powershell = win32.join(powershellRoot, "powershell.exe");
  const powershellMetadata = lstatSync(powershell, { bigint: true });
  if (!powershellMetadata.isFile() || powershellMetadata.isSymbolicLink()) {
    throw new Error("trusted Windows PowerShell is unavailable");
  }
  const toolEnv: NodeJS.ProcessEnv = {
    APPDATA: "",
    COMSPEC: win32.join(system32, "cmd.exe"),
    HOME: "",
    LOCALAPPDATA: "",
    PATH: `${system32};${powershellRoot}`,
    PATHEXT: ".COM;.EXE",
    PSModulePath: win32.join(powershellRoot, "Modules"),
    SystemRoot: systemRoot,
    TEMP: win32.join(systemRoot, "Temp"),
    TMP: win32.join(systemRoot, "Temp"),
    USERPROFILE: powershellRoot,
    WINDIR: systemRoot,
  };
  const signature = await runProcess(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $args[0];" +
        "if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Microsoft'){exit 51}",
      tarPath,
    ],
    {
      cwd: powershellRoot,
      encoding: "utf8",
      env: toolEnv,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (signature.error !== undefined || signature.status !== 0) {
    throw new Error("Windows system tar failed Microsoft Authenticode validation");
  }
  return { path: tarPath, env: toolEnv };
}

export interface OfficialProvenanceProcessResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type OfficialProvenanceProcessRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => OfficialProvenanceProcessResult | PromiseLike<OfficialProvenanceProcessResult>;

export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): Promise<OfficialProvenanceProcessResult> {
  const timeout = options.timeout;
  if (!Number.isSafeInteger(timeout) || timeout === undefined || timeout <= 0) {
    return Promise.resolve({
      error: new TypeError("bounded process timeout must be a positive safe integer"),
      status: null,
      signal: null,
    });
  }
  const maximumOutput = options.maxBuffer ?? 1024 * 1024;
  return new Promise((resolveProcess) => {
    let settled = false;
    let terminating = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: options.windowsHide,
    });
    let closed = false;
    let resolveClosed: (() => void) | undefined;
    const childClosed = new Promise<void>((resolveWait) => { resolveClosed = resolveWait; });
    const terminationDeadline = (): number => performance.now() + 5_000;
    const runWindowsTreeKill = (deadline: number): Promise<void> => new Promise((resolveKill, rejectKill) => {
      if (child.pid === undefined) {
        rejectKill(new Error("bounded Windows process has no PID for tree termination"));
        return;
      }
      const system32 = win32.join(WINDOWS_SYSTEM_ROOT, "System32");
      const killer = spawn(
        win32.join(system32, "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          cwd: system32,
          env: {
            COMSPEC: win32.join(system32, "cmd.exe"),
            PATH: system32,
            PATHEXT: ".COM;.EXE",
            SystemRoot: WINDOWS_SYSTEM_ROOT,
            WINDIR: WINDOWS_SYSTEM_ROOT,
          },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      let killSettled = false;
      const finishKill = (error?: Error): void => {
        if (killSettled) return;
        killSettled = true;
        clearTimeout(killTimer);
        if (error === undefined) resolveKill();
        else rejectKill(error);
      };
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      const killTimer = setTimeout(() => {
        try { killer.kill("SIGKILL"); } catch { /* already gone */ }
        finishKill(new Error("Windows process-tree termination timed out"));
      }, remaining);
      killer.once("error", (error) => finishKill(
        new Error(`failed to start trusted Windows process-tree terminator: ${error.message}`),
      ));
      killer.once("close", (status, signal) => finishKill(
        status === 0
          ? undefined
          : new Error(
            `Windows process-tree termination failed (${status ?? signal ?? "unknown"})`,
          ),
      ));
    });
    const terminate = async (): Promise<void> => {
      const deadline = terminationDeadline();
      let treeTerminationError: unknown;
      try {
        if (process.platform === "win32") {
          await runWindowsTreeKill(deadline);
        } else if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch (error) {
        treeTerminationError = error;
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!closed) {
        await new Promise<void>((resolveWait, rejectWait) => {
          const remaining = Math.floor(deadline - performance.now());
          if (remaining <= 0) {
            rejectWait(new Error("bounded process termination was not confirmed"));
            return;
          }
          const confirmationTimer = setTimeout(
            () => rejectWait(new Error("bounded process termination was not confirmed")),
            remaining,
          );
          void childClosed.then(() => {
            clearTimeout(confirmationTimer);
            resolveWait();
          });
        });
      }
      if (treeTerminationError !== undefined) throw treeTerminationError;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: OfficialProvenanceProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveProcess(result);
    };
    const terminateAndFinish = (error: Error): void => {
      if (settled || terminating) return;
      terminating = true;
      if (timer !== undefined) clearTimeout(timer);
      void terminate().then(
        () => finish({ error, status: null, signal: "SIGKILL" }),
        (terminationError: unknown) => finish({
          error: new AggregateError(
            [error, terminationError],
            "bounded process failed and its termination could not be confirmed",
          ),
          status: null,
          signal: "SIGKILL",
        }),
      );
    };
    const capture = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
      if (settled || terminating) return;
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > maximumOutput || stderrBytes > maximumOutput) {
        const error = new Error(`bounded process ${stream} exceeded ${maximumOutput} bytes`);
        (error as NodeJS.ErrnoException).code = "ENOBUFS";
        terminateAndFinish(error);
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk, "stderr"));
    child.once("error", (error) => {
      if (!terminating) finish({ error, status: null, signal: null });
    });
    child.once("close", (status, signal) => {
      closed = true;
      resolveClosed?.();
      if (!terminating) finish({
        status,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    });
    timer = setTimeout(() => {
      const error = new Error(`bounded process timed out after ${timeout}ms`);
      (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
      terminateAndFinish(error);
    }, timeout);
  });
}

export interface OfficialRuntimeArtifactProvenanceOptions {
  readonly manifest: RuntimeManifest;
  readonly artifact: RuntimeManifestArtifact;
  readonly artifactPath: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly tmpDir?: string;
  readonly spawnSyncImpl?: OfficialProvenanceProcessRunner;
}

function remainingProvenanceTimeout(
  deadline: number,
  timeoutMs: number,
  label: string,
): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) {
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
  }
  return Math.min(remaining, 2_147_483_647);
}

async function hashStableRegularFile(
  path: string,
  expectedBytes: number,
  label: string,
  guard?: FetchDeadline,
): Promise<string> {
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
    before.size !== BigInt(expectedBytes)
  ) {
    throw new Error(`${label} must be an exact-size regular single-link file`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() || opened.nlink !== 1n ||
      opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs ||
      opened.size !== BigInt(expectedBytes)
    ) {
      throw new Error(`${label} changed while it was opened`);
    }
    const hash = createHash("sha256");
    const source = createReadStream(path, { fd: descriptor, autoClose: false });
    if (guard === undefined) {
      await pipeline(source, hash);
    } else {
      await waitForFetchDeadline(
        pipeline(source, hash, { signal: guard.controller.signal }),
        guard,
        `${label} hash`,
      );
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      after.dev !== opened.dev || after.ino !== opened.ino ||
      after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
      after.size !== BigInt(expectedBytes) ||
      pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
      pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs ||
      pathAfter.nlink !== 1n
    ) {
      throw new Error(`${label} identity changed while it was hashed`);
    }
    return hash.digest("hex");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the verification error */ }
    }
  }
}

function officialVerifierEnvironment(workDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "LANG",
    "LC_ALL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const configDir = join(workDir, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const windowsSystem32 = win32.join(WINDOWS_SYSTEM_ROOT, "System32");
  const windowsPowerShell = win32.join(
    windowsSystem32,
    "WindowsPowerShell",
    "v1.0",
  );
  const trustedPath = process.platform === "win32"
    ? `${windowsSystem32};${windowsPowerShell}`
    : "/usr/bin:/bin";
  return {
    ...env,
    ...(process.platform === "win32" ? {
      COMSPEC: win32.join(windowsSystem32, "cmd.exe"),
      PATHEXT: ".COM;.EXE",
      PSModulePath: win32.join(windowsPowerShell, "Modules"),
      SystemRoot: WINDOWS_SYSTEM_ROOT,
      WINDIR: WINDOWS_SYSTEM_ROOT,
    } : {}),
    PATH: trustedPath,
    HOME: workDir,
    USERPROFILE: workDir,
    APPDATA: configDir,
    LOCALAPPDATA: configDir,
    XDG_CONFIG_HOME: configDir,
    XDG_CACHE_HOME: configDir,
    GH_CONFIG_DIR: configDir,
    GH_HOST: "github.com",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    GH_SPINNER_DISABLED: "1",
    GH_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    TEMP: workDir,
    TMP: workDir,
  };
}

function processFailureDetail(result: OfficialProvenanceProcessResult): string {
  const detail = sanitizeTerminalText(result.stderr ?? "", 2_048);
  return detail.length === 0 ? "" : `: ${detail}`;
}

function assertVerifierProcessSucceeded(
  result: OfficialProvenanceProcessResult,
  label: string,
): void {
  if (result.error !== undefined) {
    throw new Error(`${label} could not run: ${sanitizeTerminalText(result.error.message, 2_048)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (status ${result.status ?? result.signal})` +
        processFailureDetail(result),
    );
  }
}

/** Render untrusted diagnostics as one bounded inert terminal line. */
export function sanitizeTerminalText(value: unknown, maximumCodePoints = 4_096): string {
  if (!Number.isSafeInteger(maximumCodePoints) || maximumCodePoints <= 0) {
    throw new TypeError("terminal text limit must be a positive safe integer");
  }
  const inert = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...inert].slice(0, maximumCodePoints).join("");
}

export function officialRuntimeAttestationVerificationArgs(options: {
  readonly manifest: Pick<RuntimeManifest, "build">;
  readonly artifactPath: string;
  readonly bundlePath: string;
}): readonly string[] {
  const build = options.manifest.build as {
    readonly sourceCommit?: unknown;
    readonly sourceRef?: unknown;
  };
  if (typeof build.sourceCommit !== "string" || typeof build.sourceRef !== "string") {
    throw new Error("official runtime manifest is missing source provenance");
  }
  return canonicalRuntimeAttestationVerificationArgs({
    subjectPath: options.artifactPath,
    bundlePath: options.bundlePath,
    sourceCommit: build.sourceCommit,
    sourceRef: build.sourceRef,
  });
}

export async function runPreparedOfficialAttestationVerifier(options: {
  readonly cliPath: string;
  readonly manifest: RuntimeManifest;
  readonly artifactPath: string;
  readonly bundlePath: string;
  readonly workDir: string;
  readonly deadline: number;
  readonly timeoutMs: number;
  readonly runProcess: OfficialProvenanceProcessRunner;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const processOptions = (): SpawnSyncOptionsWithStringEncoding => ({
    cwd: options.workDir,
    encoding: "utf8",
    env: options.env ?? officialVerifierEnvironment(options.workDir),
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: remainingProvenanceTimeout(
      options.deadline,
      options.timeoutMs,
      "provenance verification",
    ),
    windowsHide: true,
  });
  const versionResult = await options.runProcess(
    options.cliPath,
    ["--version"],
    processOptions(),
  );
  assertVerifierProcessSucceeded(versionResult, "GitHub CLI bootstrap version check");
  if (!`${versionResult.stdout ?? ""}`.startsWith(
    `gh version ${PINNED_GITHUB_CLI_VERSION} `,
  )) {
    throw new Error(
      `GitHub CLI bootstrap did not report pinned version ${PINNED_GITHUB_CLI_VERSION}`,
    );
  }
  const verification = await options.runProcess(
    options.cliPath,
    officialRuntimeAttestationVerificationArgs({
      manifest: options.manifest,
      artifactPath: options.artifactPath,
      bundlePath: options.bundlePath,
    }),
    processOptions(),
  );
  assertVerifierProcessSucceeded(verification, "official runtime provenance verification");
}

/**
 * Verify an official runtime artifact's GitHub artifact attestation before any
 * archive parsing or extraction. The verifier itself is fetched from a source-
 * pinned GitHub CLI release, checked by exact byte count and SHA-256, and run
 * from an isolated configuration directory without ambient GitHub credentials.
 */
export async function verifyOfficialRuntimeArtifactProvenance(
  options: OfficialRuntimeArtifactProvenanceOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("provenance verification timeoutMs must be a positive safe integer");
  }
  const guard = createFetchDeadline(timeoutMs);
  validateRuntimeReleaseManifest(
    options.manifest as unknown as RuntimeReleaseManifest,
    { trustMode: "official" },
  );
  if (options.manifest.artifacts.filter((entry) => entry === options.artifact).length !== 1) {
    throw new Error("official runtime artifact must be the unique selected manifest member");
  }
  const artifact = options.artifact;
  const attestationUrl = artifact.attestationUrl;
  const attestationSha256 = artifact.attestationSha256;
  const attestationBytes = artifact.attestationBytes;
  if (
    attestationUrl === undefined || attestationSha256 === undefined ||
    attestationBytes === undefined
  ) {
    throw new Error("official runtime artifact is missing its attestation contract");
  }
  const platform = options.platform ?? process.platform;
  const platformSlug = platform === "win32" ? "win" : platform;
  const key = `${platformSlug}-${options.arch ?? process.arch}`;
  const pinnedCli = PINNED_GITHUB_CLI_ARTIFACTS[key];
  if (pinnedCli === undefined) {
    throw new Error(`official provenance verification is unsupported on ${key}`);
  }

  const actualArtifactSha = await hashStableRegularFile(
    options.artifactPath,
    artifact.bytes,
    "runtime artifact",
    guard,
  );
  if (actualArtifactSha !== artifact.sha256) {
    throw new Error(
      `runtime checksum mismatch (expected ${artifact.sha256}, got ${actualArtifactSha})`,
    );
  }

  let workDir: string | undefined;
  let operationError: unknown;
  try {
    workDir = await createPrivateUpdateWorkDirectory({
      parent: options.tmpDir ?? tmpdir(),
      prefix: "agenc-provenance-",
      label: "provenance work directory validation",
      timeoutMs,
      deadline: guard.deadline,
    });
    const bundlePath = join(workDir, "artifact.sigstore.json");
    const cliArchivePath = join(workDir, pinnedCli.file);
    const cliRoot = join(workDir, "gh");
    mkdirSync(cliRoot, { recursive: true, mode: 0o700 });
    const runProcess: OfficialProvenanceProcessRunner = options.spawnSyncImpl ??
      runBoundedProcess;
    await fetchToFile(
      attestationUrl,
      bundlePath,
      attestationBytes,
      "official",
      options.fetchImpl ?? globalThis.fetch,
      remainingProvenanceTimeout(guard.deadline, timeoutMs, "provenance verification"),
      {
        maximumBytes: MAX_RUNTIME_ATTESTATION_BYTES,
        label: "runtime attestation bundle",
      },
    );
    const actualBundleSha = await hashStableRegularFile(
      bundlePath,
      attestationBytes,
      "runtime attestation bundle",
      guard,
    );
    if (actualBundleSha !== attestationSha256) {
      throw new Error(
        `runtime attestation checksum mismatch ` +
          `(expected ${attestationSha256}, got ${actualBundleSha})`,
      );
    }

    await fetchToFile(
      pinnedCli.url,
      cliArchivePath,
      pinnedCli.bytes,
      "official",
      options.fetchImpl ?? globalThis.fetch,
      remainingProvenanceTimeout(guard.deadline, timeoutMs, "provenance verification"),
      {
        maximumBytes: MAX_RUNTIME_ARTIFACT_BYTES,
        label: "GitHub CLI bootstrap",
      },
    );
    const actualCliSha = await hashStableRegularFile(
      cliArchivePath,
      pinnedCli.bytes,
      "GitHub CLI bootstrap",
      guard,
    );
    if (actualCliSha !== pinnedCli.sha256) {
      throw new Error(
        `GitHub CLI bootstrap checksum mismatch ` +
          `(expected ${pinnedCli.sha256}, got ${actualCliSha})`,
      );
    }

    const processOptions = (
      processEnv = officialVerifierEnvironment(workDir!),
    ): SpawnSyncOptionsWithStringEncoding => ({
      cwd: workDir!,
      encoding: "utf8",
      env: processEnv,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: remainingProvenanceTimeout(
        guard.deadline,
        timeoutMs,
        "provenance verification",
      ),
      windowsHide: true,
    });
    const extractArgs = pinnedCli.file.endsWith(".tar.gz")
      ? ["-xzf", cliArchivePath, "-C", cliRoot]
      : ["-xf", cliArchivePath, "-C", cliRoot];
    const trustedTar = await resolveTrustedSystemTar(
      platform,
      runProcess,
      remainingProvenanceTimeout(
        guard.deadline,
        timeoutMs,
        "trusted extractor validation",
      ),
    );
    const extraction = await runProcess(
      trustedTar.path,
      extractArgs,
      processOptions(trustedTar.env),
    );
    assertVerifierProcessSucceeded(extraction, "GitHub CLI bootstrap extraction");

    const cliPath = join(cliRoot, pinnedCli.executable);
    if (!strictRelativeRuntimeFile(cliRoot, pinnedCli.executable)) {
      throw new Error("GitHub CLI bootstrap did not contain its canonical executable");
    }
    const cliMetadata = lstatSync(cliPath, { bigint: true });
    if (!cliMetadata.isFile() || cliMetadata.isSymbolicLink() || cliMetadata.nlink !== 1n) {
      throw new Error("GitHub CLI bootstrap executable is not a regular single-link file");
    }
    if (platform !== "win32") chmodSync(cliPath, 0o700);

    await runPreparedOfficialAttestationVerifier({
      cliPath,
      manifest: options.manifest,
      artifactPath: options.artifactPath,
      bundlePath,
      workDir,
      deadline: guard.deadline,
      timeoutMs,
      runProcess,
    });

    const afterVerificationSha = await hashStableRegularFile(
      options.artifactPath,
      artifact.bytes,
      "runtime artifact",
      guard,
    );
    if (afterVerificationSha !== artifact.sha256) {
      throw new Error("runtime artifact changed during provenance verification");
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    guard.controller.abort();
    if (workDir !== undefined) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          operationError === undefined
            ? [cleanupError]
            : [operationError, cleanupError],
          "official runtime provenance verification and cleanup did not both complete",
        );
      }
    }
  }
}

export async function installRuntimeFromManifest(options: {
  readonly manifest: RuntimeManifest;
  readonly artifact: RuntimeManifestArtifact;
  readonly agencHome: string;
  readonly acquireLock?: typeof acquireLocalSqliteLock;
  readonly downloadTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly manifestTrust: RuntimeManifestTrustMode;
  readonly verifyOfficialProvenance?: typeof verifyOfficialRuntimeArtifactProvenance;
  readonly remove?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => void;
  readonly tmpDir?: string;
}): Promise<InstallRuntimeResult> {
  const { manifest, artifact } = options;
  const acquireLock = options.acquireLock ?? acquireLocalSqliteLock;
  const remove = options.remove ?? rmSync;
  const version = manifest.runtimeVersion;
  const manifestTrust = options.manifestTrust;
  if (!/^\d+$/.test(artifact.nodeModuleAbi)) {
    throw new Error("manifest artifact is missing a valid native module ABI");
  }
  if (
    !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
    artifact.bytes > MAX_RUNTIME_ARTIFACT_BYTES
  ) {
    throw new Error(
      `runtime artifact signed size must be between 1 and ` +
      `${MAX_RUNTIME_ARTIFACT_BYTES} bytes`,
    );
  }
  validateRuntimeReleaseManifest(
    manifest as unknown as RuntimeReleaseManifest,
    { trustMode: manifestTrust },
  );
  if (manifest.artifacts.filter((entry) => entry === artifact).length !== 1) {
    throw new Error("runtime artifact must be the unique selected manifest member");
  }
  const expectedProvenanceReceipt = manifestTrust === "official"
    ? renderOfficialProvenanceReceipt(manifest, artifact)
    : undefined;
  const agencHome = canonicalizeAgenCHome(options.agencHome);
  await assertLocalPrivateDirectory(agencHome, {
    label: "runtime install home validation",
    timeoutMs: 60_000,
  });
  const installDir = join(
    agencHome,
    "runtime",
    version,
    updateInstallKey(artifact),
  );
  const binRel = artifact.bins?.agenc ?? "node_modules/@tetsuo-ai/runtime/bin/agenc";
  const binPath = join(installDir, binRel);
  const versionDir = dirname(installDir);
  mkdirSync(versionDir, { recursive: true, mode: 0o700 });
  chmodSync(versionDir, 0o700);
  const lockPath = `${installDir}.agenc-lock.sqlite`;

  if (
    runtimeInstallReadyAt(
      installDir,
      binRel,
      artifact.sha256,
      expectedProvenanceReceipt,
    ) &&
    !hasRuntimeInstallResidue(versionDir, basename(installDir))
  ) {
    return { binPath, downloaded: false };
  }

  // Recover any fully prepared tree left at a promotion rename boundary before
  // attempting network I/O. This makes a killed update repairable offline.
  let releaseLock: (() => void) | undefined;
  let downloadDir: string | undefined;
  let stagingDir: string | undefined;
  let operationError: unknown;
  try {
    releaseLock = await acquireLock(lockPath, {
      label: "runtime install",
      timeoutMs: 60_000,
    });
    if (reconcileRuntimeInstall(
      versionDir,
      installDir,
      binRel,
      artifact.sha256,
      expectedProvenanceReceipt,
    )) {
      return { binPath, downloaded: false };
    }
    releaseLock();
    releaseLock = undefined;

    downloadDir = await createPrivateUpdateWorkDirectory({
      parent: options.tmpDir ?? tmpdir(),
      prefix: "agenc-update-download-",
      label: "runtime download directory validation",
      timeoutMs: 60_000,
    });
    const tmp = join(downloadDir, "runtime.tar.gz");
    const verificationTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_UPDATE_FETCH_TIMEOUT_MS;
    const verificationGuard = createFetchDeadline(verificationTimeoutMs);
    await fetchToFile(
      artifact.url,
      tmp,
      artifact.bytes,
      manifestTrust,
      options.fetchImpl ?? globalThis.fetch,
      remainingProvenanceTimeout(
        verificationGuard.deadline,
        verificationTimeoutMs,
        "runtime installation",
      ),
    );
    const actual = await hashStableRegularFile(
      tmp,
      artifact.bytes,
      "runtime artifact",
      verificationGuard,
    );
    if (actual !== artifact.sha256) {
      throw new Error(
        `runtime checksum mismatch (expected ${artifact.sha256}, got ${actual}). Refusing to install.`,
      );
    }
    if (statSync(tmp).size !== artifact.bytes) {
      throw new Error(
        `runtime byte count mismatch (expected ${artifact.bytes}, got ${statSync(tmp).size})`,
      );
    }
    if (manifestTrust === "official") {
      await (options.verifyOfficialProvenance ??
        verifyOfficialRuntimeArtifactProvenance)({
        manifest,
        artifact,
        artifactPath: tmp,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        timeoutMs: remainingProvenanceTimeout(
          verificationGuard.deadline,
          verificationTimeoutMs,
          "runtime installation",
        ),
        tmpDir: downloadDir,
      });
    }
    remainingProvenanceTimeout(
      verificationGuard.deadline,
      verificationTimeoutMs,
      "runtime archive validation",
    );
    validateRuntimeArchive(tmp, artifact.platform);
    remainingProvenanceTimeout(
      verificationGuard.deadline,
      verificationTimeoutMs,
      "runtime archive validation",
    );
    releaseLock = await acquireLock(lockPath, {
      label: "runtime install",
      timeoutMs: 60_000,
    });
    if (reconcileRuntimeInstall(
      versionDir,
      installDir,
      binRel,
      artifact.sha256,
      expectedProvenanceReceipt,
    )) {
      return { binPath, downloaded: false };
    }
    stagingDir = mkdtempSync(join(versionDir, `.${basename(installDir)}.install-`));
    try { chmodSync(stagingDir, 0o700); } catch { /* best effort */ }
    const trustedTar = await resolveTrustedSystemTar(
      process.platform,
      runBoundedProcess,
      options.downloadTimeoutMs ?? DEFAULT_UPDATE_FETCH_TIMEOUT_MS,
    );
    const res = await runBoundedProcess(
      trustedTar.path,
      ["-xzf", tmp, "-C", stagingDir],
      {
      cwd: stagingDir,
      encoding: "utf8",
      env: trustedTar.env,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.downloadTimeoutMs ?? DEFAULT_UPDATE_FETCH_TIMEOUT_MS,
      windowsHide: true,
    },
    );
    assertTarExtractionSucceeded(res);
    const stagedBin = join(stagingDir, binRel);
    if (!existsSync(stagedBin)) {
      throw new Error(`runtime extracted but entry missing: ${stagedBin}`);
    }
    writeFileSync(join(stagingDir, RUNTIME_MARKER), artifact.sha256, {
      flag: "wx",
      mode: 0o600,
    });
    if (expectedProvenanceReceipt !== undefined) {
      writeFileSync(
        join(stagingDir, OFFICIAL_PROVENANCE_RECEIPT),
        expectedProvenanceReceipt,
        { flag: "wx", mode: 0o600 },
      );
    }
    promoteRuntimeInstall(stagingDir, installDir);
    stagingDir = undefined;
    if (!reconcileRuntimeInstall(
      versionDir,
      installDir,
      binRel,
      artifact.sha256,
      expectedProvenanceReceipt,
    )) {
      throw new Error("promoted runtime did not satisfy the marker contract");
    }
    return { binPath, downloaded: true };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (stagingDir !== undefined) {
      try { remove(stagingDir, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (releaseLock !== undefined) {
      try { releaseLock(); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (downloadDir !== undefined) {
      try { remove(downloadDir, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined
          ? cleanupErrors
          : [operationError, ...cleanupErrors],
        "runtime install and cleanup did not both complete",
      );
    }
  }
}

// --- wrapper activation transaction --------------------------------------------

interface WrapperActivationEntry {
  readonly path: string;
  readonly original: string | null;
  readonly desired: string;
  readonly mode: number;
}

interface WrapperActivationTransaction {
  readonly version: 1;
  readonly targetVersion: string;
  readonly entries: readonly WrapperActivationEntry[];
}

export interface WrapperActivationResult {
  readonly activated: boolean;
  readonly retainedVersion?: string;
}

function readOptionalFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function replaceFileAtomically(path: string, content: string, mode: number): void {
  const temporary = `${path}.agenc-activate-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode,
    );
    writeFileSync(descriptor, content);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectoryEntry(dirname(path));
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the primary failure */ }
    }
    try { rmSync(temporary, { force: true }); } catch { /* next activation can retry */ }
  }
}

function recognizedGeneratedWrapperContent(path: string, content: string): GeneratedWrapper | null {
  return parseGeneratedWrapperText(path, content);
}

function validateActivationTransaction(raw: string): WrapperActivationTransaction {
  if (raw.length > 4 * 1024 * 1024) throw new Error("wrapper activation journal is too large");
  const parsed = JSON.parse(raw) as Partial<WrapperActivationTransaction>;
  if (
    parsed.version !== 1 ||
    typeof parsed.targetVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parsed.targetVersion) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0 ||
    parsed.entries.length > 64
  ) throw new Error("wrapper activation journal is invalid");
  const seen = new Set<string>();
  for (const candidate of parsed.entries) {
    const entry = candidate as Partial<WrapperActivationEntry>;
    if (
      typeof entry.path !== "string" ||
      !isAbsolute(entry.path) ||
      seen.has(entry.path) ||
      (entry.original !== null && typeof entry.original !== "string") ||
      typeof entry.desired !== "string" ||
      !Number.isInteger(entry.mode) ||
      (entry.mode as number) < 0 ||
      (entry.mode as number) > 0o777
    ) throw new Error("wrapper activation journal entry is invalid");
    const originalWrapper = entry.original === null
      ? null
      : recognizedGeneratedWrapperContent(entry.path, entry.original);
    const desiredWrapper = recognizedGeneratedWrapperContent(entry.path, entry.desired);
    if (
      (entry.original !== null && originalWrapper === null) ||
      desiredWrapper === null ||
      (originalWrapper !== null && originalWrapper.kind !== desiredWrapper.kind) ||
      entry.mode !== (desiredWrapper.kind === "cmd" ? 0o644 : 0o755)
    ) throw new Error("wrapper activation journal entry is invalid");
    seen.add(entry.path);
  }
  return parsed as WrapperActivationTransaction;
}

function completeActivationTransaction(journalPath: string): void {
  const raw = readOptionalFile(journalPath);
  if (raw === null) return;
  const transaction = validateActivationTransaction(raw);
  for (const entry of transaction.entries) {
    const current = readOptionalFile(entry.path);
    if (current !== entry.original && current !== entry.desired) {
      throw new Error(
        `wrapper changed outside its interrupted activation transaction: ${entry.path}`,
      );
    }
  }
  for (const entry of transaction.entries) {
    if (readOptionalFile(entry.path) !== entry.desired) {
      replaceFileAtomically(entry.path, entry.desired, entry.mode);
    }
  }
  rmSync(journalPath, { force: true });
  syncDirectoryEntry(dirname(journalPath));
}

function runtimeVersionFromBin(runtimeBin: string, agencHome: string): string | undefined {
  const root = resolve(agencHome, "runtime");
  const candidate = resolve(runtimeBin);
  const pathWithinRuntime = relative(root, candidate);
  if (
    pathWithinRuntime.length === 0 ||
    pathWithinRuntime.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    pathWithinRuntime === ".." ||
    isAbsolute(pathWithinRuntime)
  ) return undefined;
  const version = pathWithinRuntime.split(/[\\/]/)[0];
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : undefined;
}

export async function activateGeneratedWrappers(options: {
  readonly wrappers: readonly GeneratedWrapper[];
  readonly runtimeBin: string;
  readonly targetVersion: string;
  readonly agencHome: string;
  readonly allowDowngrade: boolean;
}): Promise<WrapperActivationResult> {
  const agencHome = canonicalizeAgenCHome(options.agencHome);
  const agencHomeIdentity = existingAgenCHomeIdentity(agencHome);
  if (agencHomeIdentity === undefined) {
    throw new Error(`cannot establish canonical AGENC_HOME identity: ${agencHome}`);
  }
  const runtimeRoot = join(agencHome, "runtime");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  chmodSync(runtimeRoot, 0o700);
  const lockPath = join(runtimeRoot, ".activation-lock.sqlite");
  const journalPath = join(runtimeRoot, ".activation-transaction.json");
  const timeoutMs = 120_000;
  const deadline = performance.now() + timeoutMs;
  const releaseHomeLock = await acquireLocalSqliteLock(lockPath, {
    label: "wrapper activation",
    timeoutMs,
    deadline,
  });
  let releaseWrapperLocks: (() => void) | undefined;
  let operationError: unknown;
  try {
    const wrapperLockRegistry = resolveActivationLockRegistry();
    const wrapperPaths = new Set(options.wrappers.map((wrapper) => resolve(wrapper.path)));
    const interrupted = readOptionalFile(journalPath);
    if (interrupted !== null) {
      for (const entry of validateActivationTransaction(interrupted).entries) {
        wrapperPaths.add(resolve(entry.path));
      }
    }
    const wrapperParents = new Set([...wrapperPaths].map((path) => dirname(path)));
    await Promise.all([...wrapperParents].map(async (path) => {
      const canonical = await assertLocalPrivateDirectory(path, {
        label: "wrapper activation",
        timeoutMs,
        deadline,
      });
      if (canonical !== resolve(path)) {
        throw new Error(`wrapper parent must use its canonical path: ${path}`);
      }
    }));
    releaseWrapperLocks = await acquireLocalSqliteLocks(
      [...wrapperPaths].map((path) => wrapperActivationLockPath(path, wrapperLockRegistry)),
      { label: "wrapper activation", timeoutMs, deadline },
    );
    for (const path of wrapperPaths) {
      if (!existsSync(path)) continue;
      const canonical = await assertLocalPrivateFile(path, {
        label: "wrapper activation",
        timeoutMs,
        deadline,
      });
      if (canonical !== resolve(path)) {
        throw new Error(`wrapper must use its canonical path: ${path}`);
      }
    }
    completeActivationTransaction(journalPath);

    const freshWrappers: GeneratedWrapper[] = [];
    const seen = new Set<string>();
    for (const stale of options.wrappers) {
      if (seen.has(stale.path)) continue;
      seen.add(stale.path);
      const canonicalWrapperPath = await assertLocalPrivateFile(stale.path, {
        label: "wrapper activation",
        timeoutMs,
        deadline,
      });
      if (canonicalWrapperPath !== resolve(stale.path)) {
        throw new Error(`wrapper must use its canonical path: ${stale.path}`);
      }
      const fresh = parseGeneratedWrapper(stale.path);
      if (fresh === null) {
        throw new Error(`wrapper changed or is no longer generated by AgenC: ${stale.path}`);
      }
      if (existingAgenCHomeIdentity(fresh.agencHome) !== agencHomeIdentity) {
        throw new Error(`wrapper belongs to a different AGENC_HOME: ${stale.path}`);
      }
      if (runtimeVersionFromBin(fresh.runtimeBin, agencHome) === undefined) {
        throw new Error(`wrapper runtime target is outside its AGENC_HOME: ${stale.path}`);
      }
      // Migrate legacy/manual wrapper aliases to the canonical home while the
      // validated identity is held. Retaining an alias would let a later
      // retarget redirect config, credentials, and plugins at launch time.
      freshWrappers.push({ ...fresh, agencHome });
    }
    if (freshWrappers.length === 0) throw new Error("no wrappers remain eligible for activation");

    if (!options.allowDowngrade) {
      let newest: string | undefined;
      for (const wrapper of freshWrappers) {
        const version = runtimeVersionFromBin(wrapper.runtimeBin, agencHome);
        if (version !== undefined && (newest === undefined || semverGt(version, newest))) {
          newest = version;
        }
      }
      if (newest !== undefined && semverGt(newest, options.targetVersion)) {
        return { activated: false, retainedVersion: newest };
      }
    }

    const entries: WrapperActivationEntry[] = freshWrappers.map((wrapper) => ({
      path: wrapper.path,
      original: readFileSync(wrapper.path, "utf8"),
      desired: renderGeneratedWrapper({
        ...wrapper,
        agencHome,
        runtimeBin: options.runtimeBin,
      }),
      mode: wrapper.kind === "cmd" ? 0o644 : 0o755,
    }));
    const transaction: WrapperActivationTransaction = {
      version: 1,
      targetVersion: options.targetVersion,
      entries,
    };
    const serializedTransaction = `${JSON.stringify(transaction)}\n`;
    validateActivationTransaction(serializedTransaction);
    replaceFileAtomically(journalPath, serializedTransaction, 0o600);
    try {
      completeActivationTransaction(journalPath);
    } catch (activationError) {
      // Once the journal is durable the coherent crash policy is roll-forward.
      // A later installer/updater completes every desired wrapper before
      // starting a new activation; never report a rollback while leaving a
      // journal that instructs the opposite outcome.
      throw new Error(
        "wrapper activation was interrupted; its durable journal will resume on retry",
        { cause: activationError },
      );
    }
    return { activated: true };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const releaseErrors: unknown[] = [];
    try { releaseWrapperLocks?.(); } catch (error) { releaseErrors.push(error); }
    try { releaseHomeLock(); } catch (error) { releaseErrors.push(error); }
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? releaseErrors : [operationError, ...releaseErrors],
        "wrapper activation and lock release did not both complete",
      );
    }
  }
}

/** Activate generated wrappers. Historical name retained for source compatibility. */
export async function activateInstallShWrappers(options: {
  readonly wrappers: readonly InstallShWrapper[];
  readonly runtimeBin: string;
  readonly targetVersion: string;
  readonly agencHome: string;
  readonly allowDowngrade: boolean;
}): Promise<WrapperActivationResult> {
  return activateGeneratedWrappers(options);
}

// --- run ------------------------------------------------------------------------

export interface UpdateCliDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly currentVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly nodeModuleAbi?: string;
  readonly runtimeCompatibility?: UpdateRuntimeCompatibility;
  readonly userHome?: string;
}

export async function runAgenCUpdateCli(
  command: AgenCUpdateCliCommand,
  deps: UpdateCliDeps = {},
): Promise<number> {
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderrSink =
    deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const stderr = (line: string): void => stderrSink(sanitizeTerminalText(line));
  if (command.kind === "help") {
    stdout(command.text);
    return 0;
  }
  if (command.kind === "error") {
    stderr(`agenc: ${command.message}`);
    return 1;
  }

  const env = deps.env ?? process.env;
  const currentVersion = deps.currentVersion ?? VERSION;
  let manifestRequest: ResolvedUpdateManifestRequest;
  try {
    manifestRequest = resolveUpdateManifestRequest({ ...command, env });
  } catch (error) {
    stderr(`agenc: update failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let manifest: RuntimeManifest;
  let artifact: RuntimeManifestArtifact;
  try {
    manifest = await fetchRuntimeManifest(
      manifestRequest.url,
      deps.fetchImpl,
      {
        trustMode: manifestRequest.trustMode,
        ...(manifestRequest.expectedRuntimeVersion === undefined
          ? {}
          : { expectedRuntimeVersion: manifestRequest.expectedRuntimeVersion }),
        ...(manifestRequest.expectedRepository === undefined
          ? {}
          : { expectedRepository: manifestRequest.expectedRepository }),
      },
    );
    if (
      command.pinVersion !== undefined &&
      manifest.runtimeVersion !== command.pinVersion
    ) {
      throw new Error(
        `manifest runtime ${manifest.runtimeVersion} does not match pinned version ${command.pinVersion}`,
      );
    }
    artifact = selectUpdateArtifact(
      manifest,
      updatePlatformSlug(deps.platform, deps.arch),
      deps.nodeModuleAbi ?? process.versions.modules,
      deps.runtimeCompatibility ?? currentUpdateRuntimeCompatibility(
        deps.platform,
        deps.arch,
        deps.nodeModuleAbi ?? process.versions.modules,
      ),
    );
  } catch (error) {
    stderr(`agenc: update failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const latestVersion = manifest.runtimeVersion;
  // Unpinned updates only when remote is semver-greater (todo-121).
  // --pin installs that exact release even if lower.
  const pinned = command.pinVersion !== undefined;
  let updateAvailable = false;
  try {
    updateAvailable = pinned
      ? latestVersion !== currentVersion
      : semverGt(latestVersion, currentVersion);
  } catch {
    updateAvailable = latestVersion !== currentVersion;
  }

  if (!updateAvailable) {
    if (command.json) {
      stdout(
        JSON.stringify({
          currentVersion,
          latestVersion,
          updateAvailable: false,
        }),
      );
    } else if (
      !pinned &&
      latestVersion !== currentVersion
    ) {
      stdout(
        `agenc ${currentVersion} is newer than or equal to remote ${latestVersion}; not downgrading. Use --pin ${latestVersion} to force.`,
      );
    } else {
      stdout(`agenc ${currentVersion} is up to date.`);
    }
    return 0;
  }

  if (command.check) {
    if (command.json) {
      stdout(JSON.stringify({ currentVersion, latestVersion, updateAvailable: true }));
    } else {
      stdout(
        `Update available: ${currentVersion} -> ${latestVersion}. Run 'agenc update' to install.`,
      );
    }
    return 0;
  }

  // Locate the wrapper BEFORE downloading: without one there is nothing to
  // repoint, and downloading a runtime nothing will launch helps nobody.
  const platform = deps.platform ?? process.platform;
  let wrappers: GeneratedWrapper[];
  if (command.wrapper !== undefined) {
    try {
      wrappers = [await validateAndParseGeneratedWrapper(command.wrapper, {
        label: "wrapper update",
      })];
    } catch (error) {
      stderr(
        `agenc: ${command.wrapper} is not a secure canonical wrapper generated by an AgenC installer; ` +
        `refusing to rewrite it (${error instanceof Error ? error.message : String(error)})`,
      );
      return 1;
    }
  } else {
    const expectedKind: WrapperKind = platform === "win32" ? "cmd" : "posix";
    const candidates = findGeneratedWrapperCandidates({
      env,
      userHome: deps.userHome,
      platform,
    });
    const validationDeadline = performance.now() + 120_000;
    const validated = await Promise.all(candidates.map(async (path) => {
      try {
        return await validateAndParseGeneratedWrapper(path, {
          label: "wrapper discovery",
          timeoutMs: 120_000,
          deadline: validationDeadline,
        });
      } catch {
        return null;
      }
    }));
    wrappers = validated.filter(
      (wrapper): wrapper is GeneratedWrapper => wrapper?.kind === expectedKind,
    );
  }
  if (wrappers.length === 0) {
    stderr(
      platform === "win32"
        ? "agenc: no install.ps1 agenc.cmd wrapper found on PATH."
        : "agenc: no install.sh wrapper found on PATH.",
    );
    stderr(
      "agenc: if you installed via npm, update with: npm install -g @tetsuo-ai/agenc@latest",
    );
    stderr(
      platform === "win32"
        ? "agenc: otherwise re-run the installer (iwr -useb https://get.agenc.ag/install.ps1 | iex)"
        : "agenc: otherwise re-run the installer (curl -fsSL https://get.agenc.ag/install.sh | sh)",
    );
    stderr("agenc: or pass --wrapper <path> to the generated wrapper script.");
    return 1;
  }

  let agencHome: string;
  try {
    agencHome = canonicalizeAgenCHome(resolveAgencHome(env));
  } catch (error) {
    stderr(`agenc: update failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const agencHomeIdentity = existingAgenCHomeIdentity(agencHome);
  const foreignWrapper = wrappers.find(
    (wrapper) => existingAgenCHomeIdentity(wrapper.agencHome) !== agencHomeIdentity,
  );
  if (foreignWrapper !== undefined) {
    stderr(`agenc: wrapper belongs to a different AGENC_HOME: ${foreignWrapper.path}`);
    return 1;
  }
  let result: InstallRuntimeResult;
  try {
    result = await installRuntimeFromManifest({
      manifest,
      artifact,
      agencHome,
      manifestTrust: manifestRequest.trustMode,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch (error) {
    stderr(`agenc: update failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let activation: WrapperActivationResult;
  try {
    activation = await activateGeneratedWrappers({
      wrappers,
      runtimeBin: result.binPath,
      targetVersion: latestVersion,
      agencHome,
      allowDowngrade: pinned,
    });
  } catch (error) {
    stderr(
      `agenc: installed runtime ${latestVersion} but wrapper activation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (command.json) {
    stdout(
      JSON.stringify({
        currentVersion,
        latestVersion,
        updateAvailable: true,
        installed: true,
        downloaded: result.downloaded,
        runtimeBin: result.binPath,
        activated: activation.activated,
        ...(activation.retainedVersion !== undefined
          ? { retainedVersion: activation.retainedVersion }
          : {}),
        wrappers: activation.activated ? wrappers.map((w) => w.path) : [],
      }),
    );
  } else {
    if (activation.activated) {
      stdout(
        `Updated agenc ${currentVersion} -> ${latestVersion} (${result.downloaded ? "downloaded" : "already present"}, sha256 verified).`,
      );
      for (const wrapper of wrappers) {
        stdout(`  wrapper repointed: ${wrapper.path}`);
      }
      stdout("Restart the daemon to pick it up: agenc daemon restart");
    } else {
      stdout(
        `Installed runtime ${latestVersion}, but retained active ${activation.retainedVersion} to prevent an unpinned downgrade.`,
      );
    }
  }
  return 0;
}
