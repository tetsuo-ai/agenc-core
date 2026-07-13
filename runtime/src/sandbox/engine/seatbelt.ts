/**
 * macOS seatbelt policy generation.
 *
 * The trusted executable path remains fixed to `/usr/bin/sandbox-exec`; this
 * module creates the policy payload and owns the child-process handoff to that
 * executable.
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  PROTECTED_METADATA_PATH_NAMES,
  canWritePathWithCwd,
  getReadableRootsWithCwd,
  getUnreadableGlobsWithCwd,
  getUnreadableRootsWithCwd,
  getWritableRootsWithCwd,
  hasFullDiskReadAccess,
  hasFullDiskWriteAccess,
  includePlatformDefaults,
  networkPolicyEnabled,
  normalizePathForPolicy,
  type FileSystemSandboxPolicy,
  type NetworkProxyConfig,
  type NetworkSandboxPolicy,
  type WritableRoot,
} from "./index.js";

// Policies are read on first use rather than at module init so a
// partially-built `dist/` (where `dist/bin/agenc.js` exists but
// `dist/policies/*.sbpl` have not yet been copied by the post-build step)
// cannot crash startup. Any missing-file error now surfaces only when a
// sandbox is actually about to be spawned.
let MACOS_SEATBELT_BASE_POLICY_CACHE: string | undefined;
let MACOS_SEATBELT_NETWORK_POLICY_CACHE: string | undefined;
let MACOS_RESTRICTED_READ_ONLY_PLATFORM_DEFAULTS_CACHE: string | undefined;

function getMacosSeatbeltBasePolicy(): string {
  if (MACOS_SEATBELT_BASE_POLICY_CACHE === undefined) {
    MACOS_SEATBELT_BASE_POLICY_CACHE = fs.readFileSync(
      new URL("./policies/seatbelt_base_policy.sbpl", import.meta.url),
      "utf8",
    );
  }
  return MACOS_SEATBELT_BASE_POLICY_CACHE;
}

function getMacosSeatbeltNetworkPolicy(): string {
  if (MACOS_SEATBELT_NETWORK_POLICY_CACHE === undefined) {
    MACOS_SEATBELT_NETWORK_POLICY_CACHE = fs.readFileSync(
      new URL("./policies/seatbelt_network_policy.sbpl", import.meta.url),
      "utf8",
    );
  }
  return MACOS_SEATBELT_NETWORK_POLICY_CACHE;
}

function getMacosRestrictedReadOnlyPlatformDefaults(): string {
  if (MACOS_RESTRICTED_READ_ONLY_PLATFORM_DEFAULTS_CACHE === undefined) {
    MACOS_RESTRICTED_READ_ONLY_PLATFORM_DEFAULTS_CACHE = fs.readFileSync(
      new URL(
        "./policies/restricted_read_only_platform_defaults.sbpl",
        import.meta.url,
      ),
      "utf8",
    );
  }
  return MACOS_RESTRICTED_READ_ONLY_PLATFORM_DEFAULTS_CACHE;
}

const PROXY_URL_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export const MACOS_PATH_TO_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

export interface CreateSeatbeltCommandArgsParams {
  readonly command: readonly string[];
  readonly fileSystemSandboxPolicy: FileSystemSandboxPolicy;
  readonly networkSandboxPolicy: NetworkSandboxPolicy;
  readonly sandboxPolicyCwd: string;
  readonly enforceManagedNetwork: boolean;
  readonly network?: NetworkProxyConfig;
  readonly extraAllowUnixSockets?: readonly string[];
  /** Opt-in GPU compute (Metal) — see {@link MACOS_SEATBELT_GPU_POLICY}. */
  readonly allowGpu?: boolean;
}

interface ProxyPolicyInputs {
  readonly ports: readonly number[];
  readonly hasProxyConfig: boolean;
  readonly allowLocalBinding: boolean;
  readonly unixDomainSocketPolicy: UnixDomainSocketPolicy;
}

type UnixDomainSocketPolicy =
  | { readonly kind: "allow_all" }
  | { readonly kind: "restricted"; readonly allowed: readonly string[] };

interface SeatbeltAccessRoot {
  readonly root: string;
  readonly excludedSubpaths: readonly string[];
  readonly protectedMetadataNames: readonly string[];
}

interface UnixSocketPathParam {
  readonly index: number;
  readonly path: string;
}

/**
 * Opt-in GPU compute (Metal) allowance.
 *
 * The restricted profile denies all GPU IOKit user clients, so
 * `MTLCreateSystemDefaultDevice()` returns nil inside the sandbox and GPU
 * tools fail or crash outright (e.g. Blender 5.0.1 segfaults on the nil
 * device name during startup backend detection, even in `--background`).
 *
 * Measured minimal set (macOS 26 / M4 Pro): `AGXDeviceUserClient` is the
 * Apple Silicon GPU user client — the only IOKit class Metal needs for
 * device enumeration and compute dispatch — and `MTLCompilerService` is
 * the XPC shader compiler required for uncached pipeline compilation.
 * GPU user clients are kernel attack surface, so this stays opt-in
 * (config `sandbox.allow_gpu`) and deliberately excludes WindowServer,
 * IOSurface, and every other display-adjacent service.
 */
export const MACOS_SEATBELT_GPU_POLICY = `; GPU compute (Metal) — opt-in via config \`sandbox.allow_gpu\`
(allow iokit-open
  (iokit-user-client-class "AGXDeviceUserClient"))
(allow mach-lookup
  (global-name "com.apple.MTLCompilerService"))`;

export function createSeatbeltCommandArgs(
  args: CreateSeatbeltCommandArgsParams,
): string[] {
  const {
    command,
    fileSystemSandboxPolicy,
    networkSandboxPolicy,
    sandboxPolicyCwd,
    enforceManagedNetwork,
    network,
    extraAllowUnixSockets = [],
    allowGpu = false,
  } = args;

  const unreadableRoots = getUnreadableRootsWithCwd(
    fileSystemSandboxPolicy,
    sandboxPolicyCwd,
  );
  const [fileWritePolicy, fileWriteDirParams] =
    buildFileWritePolicyAndParams(
      fileSystemSandboxPolicy,
      sandboxPolicyCwd,
      unreadableRoots,
    );
  const [fileReadPolicy, fileReadDirParams] = buildFileReadPolicyAndParams(
    fileSystemSandboxPolicy,
    sandboxPolicyCwd,
    unreadableRoots,
  );

  const proxy = proxyPolicyInputs(network, extraAllowUnixSockets);
  const networkPolicy = dynamicNetworkPolicyForNetwork(
    networkSandboxPolicy,
    enforceManagedNetwork,
    proxy,
  );
  const denyReadPolicy = buildSeatbeltUnreadableGlobPolicy(
    fileSystemSandboxPolicy,
    sandboxPolicyCwd,
  );

  const policySections = [
    getMacosSeatbeltBasePolicy(),
    fileReadPolicy,
    fileWritePolicy,
    denyReadPolicy,
    networkPolicy,
  ];
  if (includePlatformDefaults(fileSystemSandboxPolicy)) {
    policySections.push(getMacosRestrictedReadOnlyPlatformDefaults());
  }
  if (allowGpu) {
    policySections.push(MACOS_SEATBELT_GPU_POLICY);
  }
  const fullPolicy = policySections.join("\n");

  const dirParams = [
    ...fileReadDirParams,
    ...fileWriteDirParams,
    ...macosDirParams(),
    ...unixSocketDirParams(proxy),
  ];
  return [
    "-p",
    fullPolicy,
    ...dirParams.map(([key, value]) => `-D${key}=${value}`),
    "--",
    ...command,
  ];
}

export function spawnSeatbeltCommand(
  args: CreateSeatbeltCommandArgsParams,
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(MACOS_PATH_TO_SEATBELT_EXECUTABLE, createSeatbeltCommandArgs(args), {
    ...options,
    env: options.env,
  });
}

function buildFileWritePolicyAndParams(
  policy: FileSystemSandboxPolicy,
  cwd: string,
  unreadableRoots: readonly string[],
): readonly [string, readonly (readonly [string, string])[]] {
  if (hasFullDiskWriteAccess(policy)) {
    if (unreadableRoots.length === 0) {
      return [`(allow file-write* (regex #"^/"))`, []];
    }
    return buildSeatbeltAccessPolicy("file-write*", "WRITABLE_ROOT", [
      {
        root: rootAbsolutePath(),
        excludedSubpaths: unreadableRoots,
        protectedMetadataNames: [],
      },
    ]);
  }

  const roots = getWritableRootsWithCwd(policy, cwd).map((root) => ({
    root: root.root,
    excludedSubpaths: root.readOnlySubpaths,
    protectedMetadataNames: protectedMetadataNamesForWritableRoot(
      policy,
      root,
      cwd,
    ),
  }));
  return buildSeatbeltAccessPolicy("file-write*", "WRITABLE_ROOT", roots);
}

function buildFileReadPolicyAndParams(
  policy: FileSystemSandboxPolicy,
  cwd: string,
  unreadableRoots: readonly string[],
): readonly [string, readonly (readonly [string, string])[]] {
  if (hasFullDiskReadAccess(policy)) {
    if (unreadableRoots.length === 0) {
      return ["; allow read-only file operations\n(allow file-read*)", []];
    }
    const [accessPolicy, params] = buildSeatbeltAccessPolicy(
      "file-read*",
      "READABLE_ROOT",
      [
        {
          root: rootAbsolutePath(),
          excludedSubpaths: unreadableRoots,
          protectedMetadataNames: [],
        },
      ],
    );
    return [`; allow read-only file operations\n${accessPolicy}`, params];
  }

  const roots = getReadableRootsWithCwd(policy, cwd).map((root) => ({
    root,
    excludedSubpaths: unreadableRoots.filter((candidate) =>
      pathStartsWith(candidate, root),
    ),
    protectedMetadataNames: [],
  }));
  const [accessPolicy, params] = buildSeatbeltAccessPolicy(
    "file-read*",
    "READABLE_ROOT",
    roots,
  );
  return accessPolicy.length === 0
    ? ["", params]
    : [`; allow read-only file operations\n${accessPolicy}`, params];
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  const bracketless =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  return bracketless === "localhost" ||
    bracketless === "127.0.0.1" ||
    bracketless === "::1";
}

function proxySchemeDefaultPort(scheme: string): number {
  switch (scheme) {
    case "https":
      return 443;
    case "socks5":
    case "socks5h":
    case "socks4":
    case "socks4a":
      return 1080;
    default:
      return 80;
  }
}

function proxyLoopbackPortsFromEnv(
  env: Readonly<Record<string, string>>,
): number[] {
  const ports = new Set<number>();
  for (const key of PROXY_URL_ENV_KEYS) {
    const rawValue = env[key];
    if (rawValue === undefined) continue;
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) continue;
    const candidate = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (!isLoopbackHost(parsed.hostname)) continue;
    ports.add(
      parsed.port.length > 0
        ? Number.parseInt(parsed.port, 10)
        : proxySchemeDefaultPort(parsed.protocol.replace(/:$/u, "")),
    );
  }
  return [...ports].sort((left, right) => left - right);
}

function proxyPolicyInputs(
  network: NetworkProxyConfig | undefined,
  extraAllowUnixSockets: readonly string[],
): ProxyPolicyInputs {
  const extraAllowed = extraAllowUnixSockets
    .map((socketPath) => normalizePathForSandbox(socketPath))
    .filter((socketPath): socketPath is string => socketPath !== null);
  if (!network) {
    return {
      ports: [],
      hasProxyConfig: false,
      allowLocalBinding: false,
      unixDomainSocketPolicy: {
        kind: "restricted",
        allowed: extraAllowed,
      },
    };
  }

  const env = network.env ?? {};
  const networkAllowedSockets =
    network.allowUnixSockets
      ?.map((socketPath) => normalizePathForSandbox(socketPath))
      .filter((socketPath): socketPath is string => socketPath !== null) ?? [];
  return {
    ports: proxyLoopbackPortsFromEnv(env),
    hasProxyConfig: PROXY_URL_ENV_KEYS.some(
      (key) => env[key]?.trim().length > 0,
    ),
    allowLocalBinding: network.allowLocalBinding === true,
    unixDomainSocketPolicy:
      network.allowAllUnixSockets === true
        ? { kind: "allow_all" }
        : {
            kind: "restricted",
            allowed: [...networkAllowedSockets, ...extraAllowed],
          },
  };
}

function dynamicNetworkPolicyForNetwork(
  networkPolicy: NetworkSandboxPolicy,
  enforceManagedNetwork: boolean,
  proxy: ProxyPolicyInputs,
): string {
  const hasSomeUnixSocketAccess =
    proxy.unixDomainSocketPolicy.kind === "allow_all" ||
    proxy.unixDomainSocketPolicy.allowed.length > 0;
  const shouldUseRestrictedNetworkPolicy =
    proxy.ports.length > 0 ||
    proxy.hasProxyConfig ||
    enforceManagedNetwork ||
    (!networkPolicyEnabled(networkPolicy) && hasSomeUnixSocketAccess);

  if (shouldUseRestrictedNetworkPolicy) {
    const policy: string[] = [];
    if (proxy.allowLocalBinding) {
      policy.push("; allow local binding and loopback traffic");
      policy.push(`(allow network-bind (local ip "*:*"))`);
      policy.push(`(allow network-inbound (local ip "localhost:*"))`);
      policy.push(`(allow network-outbound (remote ip "localhost:*"))`);
    }
    if (proxy.allowLocalBinding && proxy.ports.length > 0) {
      policy.push("; allow DNS lookups while application traffic remains proxy-routed");
      policy.push(`(allow network-outbound (remote ip "*:53"))`);
    }
    for (const port of proxy.ports) {
      policy.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
    }
    const socketPolicy = unixSocketPolicy(proxy);
    if (socketPolicy.length > 0) {
      policy.push("; allow unix domain sockets for local IPC");
      policy.push(socketPolicy.trimEnd());
    }
    policy.push(getMacosSeatbeltNetworkPolicy());
    return policy.join("\n");
  }

  if (proxy.hasProxyConfig || enforceManagedNetwork) {
    return "";
  }

  if (networkPolicyEnabled(networkPolicy)) {
    const policy = ["(allow network-outbound)", "(allow network-inbound)"];
    const socketPolicy = unixSocketPolicy(proxy);
    if (socketPolicy.length > 0) {
      policy.push("; allow unix domain sockets for local IPC");
      policy.push(socketPolicy.trimEnd());
    }
    policy.push(getMacosSeatbeltNetworkPolicy());
    return policy.join("\n");
  }

  return "";
}

function unixSocketPolicy(proxy: ProxyPolicyInputs): string {
  const socketParams = unixSocketPathParams(proxy);
  const hasUnixSocketAccess =
    proxy.unixDomainSocketPolicy.kind === "allow_all" ||
    socketParams.length > 0;
  if (!hasUnixSocketAccess) return "";

  const policy = ["(allow system-socket (socket-domain AF_UNIX))"];
  if (proxy.unixDomainSocketPolicy.kind === "allow_all") {
    policy.push("(allow network-bind (local unix-socket))");
    policy.push("(allow network-outbound (remote unix-socket))");
    return `${policy.join("\n")}\n`;
  }

  for (const param of socketParams) {
    const key = unixSocketPathParamKey(param.index);
    policy.push(
      `(allow network-bind (local unix-socket (subpath (param "${key}"))))`,
    );
    policy.push(
      `(allow network-outbound (remote unix-socket (subpath (param "${key}"))))`,
    );
  }
  return `${policy.join("\n")}\n`;
}

function unixSocketPathParams(proxy: ProxyPolicyInputs): UnixSocketPathParam[] {
  if (proxy.unixDomainSocketPolicy.kind !== "restricted") return [];
  const deduped = new Map<string, string>();
  for (const socketPath of proxy.unixDomainSocketPolicy.allowed) {
    deduped.set(socketPath, socketPath);
  }
  return [...deduped.values()].map((socketPath, index) => ({
    index,
    path: socketPath,
  }));
}

function unixSocketPathParamKey(index: number): string {
  return `UNIX_SOCKET_PATH_${index}`;
}

function unixSocketDirParams(
  proxy: ProxyPolicyInputs,
): readonly (readonly [string, string])[] {
  return unixSocketPathParams(proxy).map((param) => [
    unixSocketPathParamKey(param.index),
    param.path,
  ]);
}

function buildSeatbeltAccessPolicy(
  action: string,
  paramPrefix: string,
  roots: readonly SeatbeltAccessRoot[],
): readonly [string, readonly (readonly [string, string])[]] {
  const policyComponents: string[] = [];
  const params: (readonly [string, string])[] = [];

  roots.forEach((accessRoot, index) => {
    const root = normalizePathForSandbox(accessRoot.root) ?? accessRoot.root;
    const rootParam = `${paramPrefix}_${index}`;
    params.push([rootParam, root]);

    if (
      accessRoot.excludedSubpaths.length === 0 &&
      accessRoot.protectedMetadataNames.length === 0
    ) {
      policyComponents.push(`(subpath (param "${rootParam}"))`);
      return;
    }

    const requireParts = [`(subpath (param "${rootParam}"))`];
    accessRoot.excludedSubpaths.forEach((excludedSubpath, excludedIndex) => {
      const normalizedSubpath =
        normalizePathForSandbox(excludedSubpath) ?? excludedSubpath;
      const excludedParam = `${paramPrefix}_${index}_EXCLUDED_${excludedIndex}`;
      params.push([excludedParam, normalizedSubpath]);
      requireParts.push(`(require-not (literal (param "${excludedParam}")))`);
      requireParts.push(`(require-not (subpath (param "${excludedParam}")))`);
    });

    for (const metadataName of accessRoot.protectedMetadataNames) {
      const regex = seatbeltProtectedMetadataNameRegex(root, metadataName)
        .replaceAll('"', '\\"');
      requireParts.push(`(require-not (regex #"${regex}"))`);
    }
    policyComponents.push(`(require-all ${requireParts.join(" ")} )`);
  });

  if (policyComponents.length === 0) return ["", []];
  return [
    `(allow ${action}\n${policyComponents.join(" ")}\n)`,
    params,
  ];
}

function seatbeltProtectedMetadataNameRegex(root: string, name: string): string {
  let normalizedRoot = root;
  while (normalizedRoot.length > 1 && normalizedRoot.endsWith("/")) {
    normalizedRoot = normalizedRoot.slice(0, -1);
  }
  const escapedRoot = escapeRegex(normalizedRoot);
  const escapedName = escapeRegex(name);
  return normalizedRoot === "/"
    ? `^/${escapedName}(/.*)?$`
    : `^${escapedRoot}/${escapedName}(/.*)?$`;
}

function protectedMetadataNamesForWritableRoot(
  policy: FileSystemSandboxPolicy,
  writableRoot: WritableRoot,
  cwd: string,
): string[] {
  const names = new Set(writableRoot.protectedMetadataNames ?? []);
  for (const name of PROTECTED_METADATA_PATH_NAMES) {
    if (names.has(name)) continue;
    const candidate = path.join(writableRoot.root, name);
    if (!canWritePathWithCwd(policy, candidate, cwd)) names.add(name);
  }
  return [...names];
}

function buildSeatbeltUnreadableGlobPolicy(
  policy: FileSystemSandboxPolicy,
  cwd: string,
): string {
  const unreadableGlobs = getUnreadableGlobsWithCwd(policy, cwd);
  if (unreadableGlobs.length === 0) return "";

  const policyComponents = new Set<string>();
  for (const pattern of unreadableGlobs) {
    const regexes = new Set<string>();
    const regex = seatbeltRegexForUnreadableGlob(pattern);
    if (regex !== null) regexes.add(regex);
    const canonicalized = canonicalizeGlobStaticPrefixForSandbox(pattern);
    if (canonicalized !== null) {
      const canonicalizedRegex = seatbeltRegexForUnreadableGlob(canonicalized);
      if (canonicalizedRegex !== null) regexes.add(canonicalizedRegex);
    }
    for (const item of regexes) {
      const escaped = item.replaceAll('"', '\\"');
      policyComponents.add(`(deny file-read* (regex #"${escaped}"))`);
      policyComponents.add(`(deny file-write-unlink (regex #"${escaped}"))`);
    }
  }
  return [...policyComponents].join("\n");
}

function canonicalizeGlobStaticPrefixForSandbox(pattern: string): string | null {
  const firstGlobIndex = pattern.search(/[*?[\]]/u);
  if (firstGlobIndex === -1) return normalizePathForSandbox(pattern);

  const staticPrefix = pattern.slice(0, firstGlobIndex);
  const prefixEnd = staticPrefix.endsWith("/")
    ? staticPrefix.length - 1
    : staticPrefix.lastIndexOf("/");
  if (prefixEnd <= 0) return null;

  const root = normalizePathForSandbox(pattern.slice(0, prefixEnd));
  if (root === null) return null;
  const normalizedPattern = `${root}${pattern.slice(prefixEnd)}`;
  return normalizedPattern === pattern ? null : normalizedPattern;
}

export function seatbeltRegexForUnreadableGlob(pattern: string): string | null {
  if (pattern.length === 0) return null;

  let regex = "^";
  const chars = [...pattern];
  let index = 0;
  let sawGlob = false;
  while (index < chars.length) {
    const ch = chars[index++] ?? "";
    switch (ch) {
      case "*":
        sawGlob = true;
        if (chars[index] === "*") {
          index += 1;
          if (chars[index] === "/") {
            index += 1;
            regex += "(.*/)?";
          } else {
            regex += ".*";
          }
        } else {
          regex += "[^/]*";
        }
        break;
      case "?":
        sawGlob = true;
        regex += "[^/]";
        break;
      case "[": {
        sawGlob = true;
        const classChars: string[] = [];
        let closed = false;
        while (index < chars.length) {
          const classCh = chars[index++] ?? "";
          if (classCh === "]") {
            closed = true;
            break;
          }
          classChars.push(classCh);
        }
        if (!closed) {
          regex += "\\[";
          index -= classChars.length;
          break;
        }
        regex += "[";
        const [first, ...rest] = classChars;
        if (first !== undefined) {
          if (first === "!") regex += "^";
          else if (first === "^") regex += "\\^";
          else regex += first;
        }
        for (const classCh of rest) {
          regex += classCh === "\\" ? "\\\\" : classCh;
        }
        regex += "]";
        break;
      }
      case "]":
        sawGlob = true;
        regex += "\\]";
        break;
      default:
        regex += escapeRegex(ch);
        break;
    }
  }

  if (!sawGlob) regex += "(/.*)?";
  regex += "$";
  return regex;
}

function macosDirParams(
  platform: NodeJS.Platform = process.platform,
): readonly (readonly [string, string])[] {
  if (platform !== "darwin") return [];
  const cacheDir = darwinUserCacheDir();
  return cacheDir === null
    ? []
    : [["DARWIN_USER_CACHE_DIR", normalizePathForPolicy(cacheDir)]];
}

function darwinUserCacheDir(): string | null {
  const result = spawnSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], {
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = result.stdout.trim();
  if (value.length === 0 || !path.isAbsolute(value)) return null;
  return normalizePathForSandbox(value);
}

function normalizePathForSandbox(candidate: string): string | null {
  if (!path.isAbsolute(candidate)) return null;
  try {
    return normalizePathForPolicy(fs.realpathSync(candidate));
  } catch {
    return normalizePathForPolicy(candidate);
  }
}

function rootAbsolutePath(): string {
  return path.parse(process.cwd()).root;
}

function pathStartsWith(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePathForPolicy(candidate);
  const normalizedRoot = normalizePathForPolicy(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}
