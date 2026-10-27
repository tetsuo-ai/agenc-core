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
  readonly sessionTempRoot: string;
  readonly enforceManagedNetwork: boolean;
  readonly network?: NetworkProxyConfig;
  readonly extraAllowUnixSockets?: readonly string[];
  /** Opt-in GPU compute (Metal) — see {@link MACOS_SEATBELT_GPU_POLICY}. */
  readonly allowGpu?: boolean;
  /**
   * The command launches Chromium for the Browser tool. See
   * {@link MACOS_SEATBELT_CHROMIUM_POLICY}. `bundleIdentifier` is the
   * browser app's CFBundleIdentifier, the prefix of the Mach names Chromium
   * registers for its own processes.
   */
  readonly chromiumBrowser?: {
    readonly bundleIdentifier: string | undefined;
    /** The per-user temporary folder (`getconf DARWIN_USER_TEMP_DIR`). */
    readonly userTempDir?: string | undefined;
  };
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

/**
 * Chromium launch allowance for the Browser tool's own spawn.
 *
 * Chromium on macOS starts as an AppKit app even when headless: it registers
 * with LaunchServices (`TransformProcessType`) and connects to the window
 * server. HIServices aborts the process when launchservicesd is out of reach,
 * which is the "Google Chrome quit unexpectedly" crash every sandboxed launch
 * hit. Chromium's child processes then find the browser through Mach names it
 * registers itself (the MachPortRendezvousServer and crashpad handshake names
 * under `org.chromium.` and the browser's bundle identifier, see
 * {@link MACOS_SEATBELT_CHROMIUM_BUNDLE_POLICY}).
 *
 * Measured on macOS 26 with Chrome 155 and Chrome for Testing 153 (headless,
 * CDP over pipes, Chromium's own sandbox off): these rules are enough to
 * launch, navigate, fill forms, open tabs and take screenshots. The window
 * system plumbing an app uses at startup is allowed. Services that carry the
 * user's data stay denied and Chromium carries on without them: the
 * clipboard, AppleEvents, keychain and credential services, location,
 * Spotlight, iCloud, notifications, Time Machine, analytics, and GPU user
 * clients (rendering falls back to software). File and network rules are
 * the session profile's, plus the per-user temporary folder (see
 * {@link MACOS_SEATBELT_CHROMIUM_TEMP_POLICY}).
 */
export const MACOS_SEATBELT_CHROMIUM_POLICY = `; Chromium browser launch (Browser tool only)
(allow mach-lookup
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.lsd.mapdb")
  (global-name "com.apple.lsd.modifydb")
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.windowserver.active")
  (global-name "com.apple.CARenderServer")
  (global-name "com.apple.hiservices-xpcservice")
  (global-name "com.apple.dock.server")
  (global-name "com.apple.dock.fullscreen")
  (global-name "com.apple.window_proxies")
  (global-name "com.apple.windowmanager.server")
  (global-name "com.apple.distributed_notifications@Uv3")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.runningboard")
  (global-name "com.apple.fonts")
  (global-name "com.apple.logd")
  (global-name "com.apple.touchbarserver.mig")
  (global-name "com.apple.tccd.system")
  (global-name "com.apple.system.opendirectoryd.api")
  (global-name-prefix "org.chromium."))
(allow mach-register
  (local-name-prefix "")
  (global-name-prefix "org.chromium."))
(allow ipc-posix-shm-read-data
  (ipc-posix-name "apple.shm.notification_center"))
(allow sysctl-read
  (sysctl-name "hw.product")
  (sysctl-name "kern.bootargs")
  (sysctl-name "kern.hv_vmm_present")
  (sysctl-name "kern.iossupportversion")
  (sysctl-name "kern.maxfiles")
  (sysctl-name "kern.num_files")
  (sysctl-name "kern.willshutdown")
  (sysctl-name "security.mac.lockdown_mode_state"))`;

/**
 * Chromium names its rendezvous server after the browser app's bundle
 * identifier (`com.google.Chrome.MachPortRendezvousServer.<pid>`), so the
 * prefix comes from the launched app's Info.plist through a parameter.
 */
export const MACOS_SEATBELT_CHROMIUM_BUNDLE_POLICY = `(allow mach-lookup mach-register
  (global-name-prefix (param "CHROMIUM_MACH_NAME_PREFIX")))`;

/**
 * Chromium creates its process-singleton socket folder
 * (`com.google.Chrome.XXXXXX`) in the per-user temporary folder that
 * `getconf DARWIN_USER_TEMP_DIR` names, whatever TMPDIR says, and aborts with
 * "Failed to create a ProcessSingleton" when it cannot. With the default
 * TMPDIR that folder is already the session's temporary root; with a custom
 * TMPDIR or AGENC_TMPDIR it is not, so the browser gets it explicitly.
 */
export const MACOS_SEATBELT_CHROMIUM_TEMP_POLICY = `(allow file-write*
  (subpath (param "CHROMIUM_USER_TEMP_DIR")))`;

const BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u;

/**
 * The CFBundleIdentifier of the app that contains a Chromium executable, or
 * undefined for a bare binary (chrome-headless-shell) or a bundle whose
 * Info.plist cannot be read.
 */
export function chromiumBundleIdentifier(executablePath: string): string | undefined {
  let realPath: string;
  try {
    realPath = fs.realpathSync(executablePath);
  } catch {
    return undefined;
  }
  const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/u.exec(realPath)?.[1];
  if (bundle === undefined) return undefined;
  const infoPlist = path.join(bundle, "Contents", "Info.plist");
  let text: string;
  try {
    text = fs.readFileSync(infoPlist, "utf8");
  } catch {
    return undefined;
  }
  let identifier =
    /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1];
  if (identifier === undefined && text.startsWith("bplist")) {
    const result = spawnSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
      { encoding: "utf8", timeout: 2_000 },
    );
    identifier = result.status === 0 ? result.stdout.trim() : undefined;
  }
  return identifier !== undefined && BUNDLE_IDENTIFIER_PATTERN.test(identifier)
    ? identifier
    : undefined;
}

export function createSeatbeltCommandArgs(
  args: CreateSeatbeltCommandArgsParams,
): string[] {
  const {
    command,
    fileSystemSandboxPolicy,
    networkSandboxPolicy,
    sandboxPolicyCwd,
    sessionTempRoot,
    enforceManagedNetwork,
    network,
    extraAllowUnixSockets = [],
    allowGpu = false,
    chromiumBrowser,
  } = args;

  const unreadableRoots = getUnreadableRootsWithCwd(
    fileSystemSandboxPolicy,
    sandboxPolicyCwd,
    sessionTempRoot,
  );
  const [fileWritePolicy, fileWriteDirParams] =
    buildFileWritePolicyAndParams(
      fileSystemSandboxPolicy,
      sandboxPolicyCwd,
      unreadableRoots,
      sessionTempRoot,
    );
  const [fileReadPolicy, fileReadDirParams] = buildFileReadPolicyAndParams(
    fileSystemSandboxPolicy,
    sandboxPolicyCwd,
    unreadableRoots,
    sessionTempRoot,
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
  const [reservedWritePolicy, reservedWriteParams] = buildReservedWritePolicy(fileSystemSandboxPolicy);

  const policySections = [
    getMacosSeatbeltBasePolicy(),
    fileReadPolicy,
    fileWritePolicy,
    denyReadPolicy,
    reservedWritePolicy,
    networkPolicy,
  ];
  if (includePlatformDefaults(fileSystemSandboxPolicy)) {
    policySections.push(getMacosRestrictedReadOnlyPlatformDefaults());
  }
  if (allowGpu) {
    policySections.push(MACOS_SEATBELT_GPU_POLICY);
  }
  const chromiumParams: (readonly [string, string])[] = [];
  if (chromiumBrowser !== undefined) {
    policySections.push(MACOS_SEATBELT_CHROMIUM_POLICY);
    const bundleIdentifier = chromiumBrowser.bundleIdentifier;
    if (
      bundleIdentifier !== undefined &&
      BUNDLE_IDENTIFIER_PATTERN.test(bundleIdentifier)
    ) {
      policySections.push(MACOS_SEATBELT_CHROMIUM_BUNDLE_POLICY);
      chromiumParams.push(["CHROMIUM_MACH_NAME_PREFIX", `${bundleIdentifier}.`]);
    }
    const userTempDir = chromiumBrowser.userTempDir;
    if (userTempDir !== undefined && path.isAbsolute(userTempDir)) {
      policySections.push(MACOS_SEATBELT_CHROMIUM_TEMP_POLICY);
      chromiumParams.push(["CHROMIUM_USER_TEMP_DIR", normalizePathForPolicy(userTempDir)]);
    }
  }
  const fullPolicy = policySections.join("\n");

  const dirParams = [
    ...fileReadDirParams,
    ...fileWriteDirParams,
    ...reservedWriteParams,
    ...macosDirParams(),
    ...unixSocketDirParams(proxy),
    ...chromiumParams,
  ];
  return [
    "-p",
    fullPolicy,
    ...dirParams.map(([key, value]) => `-D${key}=${value}`),
    "--",
    ...command,
  ];
}

function buildReservedWritePolicy(policy: FileSystemSandboxPolicy): readonly [string, readonly (readonly [string, string])[]] {
  const rules: string[] = [];
  const params: [string, string][] = [];
  const ancestors = new Set<string>();
  for (const [index, root] of (policy.reservedReadOnlyPaths ?? []).entries()) {
    const key = `RESERVED_READ_ONLY_${index}`;
    params.push([key, root]);
    rules.push(`(deny file-write* (subpath (param "${key}")))`);
    // A writable ancestor must not be renamed/replaced to bypass the subtree.
    for (let parent = root; parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  }
  for (const [index, ancestor] of [...ancestors].entries()) {
    const key = `RESERVED_ANCESTOR_${index}`;
    params.push([key, ancestor]);
    rules.push(`(deny file-write-unlink (literal (param "${key}")))`);
  }
  return [rules.join("\n"), params];
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
  sessionTempRoot: string,
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

  const roots = getWritableRootsWithCwd(policy, cwd, sessionTempRoot).map((root) => ({
    root: root.root,
    excludedSubpaths: root.readOnlySubpaths,
    protectedMetadataNames: protectedMetadataNamesForWritableRoot(
      policy,
      root,
      cwd,
      sessionTempRoot,
    ),
  }));
  return buildSeatbeltAccessPolicy("file-write*", "WRITABLE_ROOT", roots);
}

function buildFileReadPolicyAndParams(
  policy: FileSystemSandboxPolicy,
  cwd: string,
  unreadableRoots: readonly string[],
  sessionTempRoot: string,
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

  const roots = getReadableRootsWithCwd(policy, cwd, sessionTempRoot).map((root) => ({
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
  sessionTempRoot: string,
): string[] {
  const names = new Set(writableRoot.protectedMetadataNames ?? []);
  for (const name of PROTECTED_METADATA_PATH_NAMES) {
    if (names.has(name)) continue;
    const candidate = path.join(writableRoot.root, name);
    if (!canWritePathWithCwd(policy, candidate, cwd, sessionTempRoot)) {
      names.add(name);
    }
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

/**
 * The per-user cache directory is fixed for the life of the process, but
 * asking for it runs getconf synchronously (about 3 ms of blocked event loop)
 * and every sandboxed command transform needs it: an agent step with a
 * sandboxed Glob, Grep, or exec_command paid that once or twice. Only an
 * answer whose real path resolved is remembered; a failed lookup, or a
 * directory that does not exist yet, is asked again next time as before.
 */
let resolvedDarwinUserCacheDir: string | undefined;

function darwinUserCacheDir(): string | null {
  if (resolvedDarwinUserCacheDir !== undefined) {
    return resolvedDarwinUserCacheDir;
  }
  const result = spawnSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], {
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = result.stdout.trim();
  if (value.length === 0 || !path.isAbsolute(value)) return null;
  let realPath: string;
  try {
    realPath = fs.realpathSync(value);
  } catch {
    return normalizePathForPolicy(value);
  }
  resolvedDarwinUserCacheDir = normalizePathForPolicy(realPath);
  return resolvedDarwinUserCacheDir;
}

let resolvedDarwinUserTempDir: string | undefined;

/**
 * The per-user temporary folder macOS gives every process, independent of
 * TMPDIR. Remembered once its real path resolved, like the cache folder.
 */
export function darwinUserTempDir(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "darwin") return undefined;
  if (resolvedDarwinUserTempDir !== undefined) return resolvedDarwinUserTempDir;
  const result = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const value = result.stdout.trim();
  if (value.length === 0 || !path.isAbsolute(value)) return undefined;
  try {
    resolvedDarwinUserTempDir = normalizePathForPolicy(fs.realpathSync(value));
  } catch {
    return undefined;
  }
  return resolvedDarwinUserTempDir;
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
