// End-to-end tests for scripts/install/install.sh (TODO task 1).
//
// The installer must speak the exact runtime-manager install contract
// (runtime/<version>/<platform>-<arch>-<libc>-node-abi-<abi>-sha256-<digest>/ + marker)
// so the npm launcher and the shell installer can reuse each other's
// installs. Everything runs against a synthetic tarball + file:// manifest,
// mirroring packages/agenc/test/runtime-manager.test.mjs.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  parseGeneratedWrapper,
  parseInstallShWrapper,
  renderInstallShWrapper,
} from "../../src/bin/update-cli.js";
import {
  resolveActivationLockRegistry,
  wrapperActivationLockPath,
} from "../../src/utils/activation-lock-identity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const INSTALL_SH = join(REPO_ROOT, "scripts", "install", "install.sh");
const INSTALL_PS1 = join(REPO_ROOT, "scripts", "install", "install.ps1");
const RELEASE_TOOLCHAIN = join(REPO_ROOT, "release-toolchain.json");

const VERSION = "9.9.9-test";
const BIN_REL = "node_modules/@tetsuo-ai/runtime/bin/agenc";
const NODE_ABI = process.versions.modules;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function removePersistentWrapperLocks(root: string): void {
  const registry = resolveActivationLockRegistry();
  if (!existsSync(registry) || !existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path);
      } else if (entry.isFile() && (entry.name === "agenc" || entry.name === "agenc.cmd")) {
        if (parseGeneratedWrapper(path) === null) continue;
        const lockPath = wrapperActivationLockPath(path, registry);
        for (const suffix of ["", "-shm", "-wal"]) {
          rmSync(`${lockPath}${suffix}`, { force: true });
        }
      }
    }
  }
}

// Synthetic runtime tarball with the real extraction layout; the bin is a
// node script so the generated wrapper can actually be executed.
function makeSyntheticArtifact(dir: string): { tarball: string; sha: string } {
  const tree = join(dir, "tree");
  const binDir = join(tree, "node_modules", "@tetsuo-ai", "runtime", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "agenc"),
    'console.log("ok " + process.argv.slice(2).join(" "));\n',
  );
  const tarball = join(dir, `agenc-runtime-${VERSION}-test.tar.gz`);
  const res = spawnSync("tar", ["-czf", tarball, "-C", tree, "node_modules"]);
  expect(res.status).toBe(0);
  return { tarball, sha: sha256(readFileSync(tarball)) };
}

type RawTarEntry = { name: string; type?: "0" | "2" | "5"; link?: string; body?: string };

function makeRawTarArtifact(dir: string, entries: RawTarEntry[]): { tarball: string; sha: string } {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const tarball = join(dir, `raw-${Math.random().toString(16).slice(2)}.tar.gz`);
  const compressed = gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
  writeFileSync(tarball, compressed);
  return { tarball, sha: sha256(compressed) };
}

function writeManifest(
  dir: string,
  artifact: { tarball: string; sha: string },
  overrides: Record<string, unknown> = {},
): string {
  const manifest = {
    manifestVersion: 2,
    runtimeVersion: VERSION,
    releaseRepository: "tetsuo-ai/agenc-core",
    releaseTag: `agenc-v${VERSION}`,
    artifacts: [
      {
        platform: "linux",
        arch: "x64",
        runtimeVersion: VERSION,
        nodeMajor: Number(process.versions.node.split(".")[0]),
        nodeModuleAbi: NODE_ABI,
        nodeApiVersion: process.versions.napi,
        libcFamily: "glibc",
        minimumGlibcVersion: "2.28",
        minimumGlibcxxVersion: "3.4.25",
        minimumCxxAbiVersion: "1.3.11",
        url: pathToFileURL(artifact.tarball).href,
        sha256: artifact.sha,
        bytes: statSync(artifact.tarball).size,
        bins: { agenc: BIN_REL },
        ...overrides,
      },
    ],
  };
  const file = join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

function remoteManifest(
  artifact: { tarball: string; sha: string },
  platform: "linux" | "win",
  _artifactUrl: string,
  releaseRepository = "test/mirror",
): Record<string, any> {
  const runtime = process.version;
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const artifactName =
    `agenc-runtime-${VERSION}-${platform}-x64-node${nodeMajor}-abi${NODE_ABI}.tar.gz`;
  const artifactUrl =
    `https://github.com/${releaseRepository}/releases/download/agenc-v${VERSION}/` +
    artifactName;
  const attestation = Buffer.from("{}");
  return {
    manifestVersion: 2,
    runtimeVersion: VERSION,
    releaseRepository,
    releaseTag: `agenc-v${VERSION}`,
    build: {
      sourceCommit: "a".repeat(40),
      sourceRef: `refs/tags/agenc-v${VERSION}`,
      sourceDateEpoch: 1,
      lockfileSha256: "b".repeat(64),
      nodeVersion: runtime,
      nodeMajor,
      nodeModuleAbi: NODE_ABI,
      nodeApiVersion: process.versions.napi,
      npmVersion: "11.17.0",
      artifactProfile: "release",
    },
    artifacts: [{
      platform,
      arch: "x64",
      runtimeVersion: VERSION,
      nodeMajor,
      nodeModuleAbi: NODE_ABI,
      nodeApiVersion: process.versions.napi,
      ...(platform === "linux" ? {
        libcFamily: "glibc",
        minimumGlibcVersion: "2.28",
        minimumGlibcxxVersion: "3.4.25",
        minimumCxxAbiVersion: "1.3.11",
      } : {}),
      url: artifactUrl,
      sha256: artifact.sha,
      bytes: statSync(artifact.tarball).size,
      attestationUrl: `${artifactUrl}.sigstore.json`,
      attestationSha256: sha256(attestation),
      attestationBytes: attestation.length,
      bins: { agenc: BIN_REL },
    }],
  };
}

function replaceExactlyOnce(source: string, needle: string, replacement: string): string {
  const first = source.indexOf(needle);
  if (first === -1 || source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`expected exactly one installer test patch target: ${needle}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

/**
 * Fault tests need Node instrumentation. Patch only a private test copy; the
 * shipped installer has no environment-controlled bypass for its preload scrub.
 */
function writeInstrumentedInstallSh(dir: string, pinnedGhArchive?: string): string {
  const target = join(dir, "instrumented-install.sh");
  let source = replaceExactlyOnce(
    readFileSync(INSTALL_SH, "utf8"),
    "unset NODE_OPTIONS",
    ": # test copy only: retain NODE_OPTIONS for fault instrumentation",
  );
  if (pinnedGhArchive !== undefined) {
    source = replaceExactlyOnce(
      source,
      "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60",
      sha256(readFileSync(pinnedGhArchive)),
    );
  }
  writeFileSync(target, source, { mode: 0o755 });
  return target;
}

function writeInstrumentedInstallPs1(dir: string): string {
  const target = join(dir, "instrumented-install.ps1");
  const source = replaceExactlyOnce(
    readFileSync(INSTALL_PS1, "utf8"),
    '[Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")',
    '# test copy only: retain NODE_OPTIONS for fault instrumentation',
  );
  writeFileSync(target, source);
  return target;
}

function writeGithubArtifactFetchRewrite(dir: string): string {
  const preload = join(dir, "rewrite-github-artifact-fetch.cjs");
  writeFileSync(preload, `
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const source = input instanceof Request ? input.url : String(input);
  const parsed = new URL(source);
  if (process.env.AGENC_INSTALL_TEST_FETCH_LOG) {
    require("node:fs").appendFileSync(process.env.AGENC_INSTALL_TEST_FETCH_LOG, source + "\\n");
  }
  if (parsed.hostname === "github.com") {
    let replacement;
    if (parsed.pathname.endsWith("/agenc-runtime-manifest-v2.json")) {
      replacement = process.env.AGENC_INSTALL_TEST_GITHUB_MANIFEST_URL;
    } else if (parsed.pathname.endsWith(".sigstore.json")) {
      replacement = process.env.AGENC_INSTALL_TEST_GITHUB_BUNDLE_URL;
    } else if (parsed.pathname.includes("/cli/cli/releases/download/")) {
      replacement = process.env.AGENC_INSTALL_TEST_GH_ARCHIVE_URL;
    } else if (parsed.pathname.includes("/releases/download/") && parsed.pathname.endsWith(".tar.gz")) {
      replacement = process.env.AGENC_INSTALL_TEST_GITHUB_ARTIFACT_URL;
    }
    if (replacement) return originalFetch(replacement, init);
  }
  return originalFetch(input, init);
};
`);
  return preload;
}

function makeFakeGhArchive(dir: string): string {
  const rootName = "gh_2.96.0_linux_amd64";
  const binDir = join(dir, "fake-gh", rootName, "bin");
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, "gh");
  writeFileSync(binary, `#!/bin/sh
printf '%s\\n' "$@" > "$AGENC_INSTALL_TEST_GH_LOG"
if [ -n "\${AGENC_INSTALL_TEST_GH_ENV_LOG:-}" ]; then
  {
    printf 'GH_CONFIG_DIR=%s\\n' "\${GH_CONFIG_DIR:-}"
    printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN:-}"
    printf 'GITHUB_TOKEN=%s\\n' "\${GITHUB_TOKEN:-}"
    printf 'HTTPS_PROXY=%s\\n' "\${HTTPS_PROXY:-}"
    printf 'GH_TELEMETRY=%s\\n' "\${GH_TELEMETRY:-}"
    printf 'DO_NOT_TRACK=%s\\n' "\${DO_NOT_TRACK:-}"
    printf 'GH_NO_UPDATE_NOTIFIER=%s\\n' "\${GH_NO_UPDATE_NOTIFIER:-}"
    printf 'GH_SPINNER_DISABLED=%s\\n' "\${GH_SPINNER_DISABLED:-}"
  } > "$AGENC_INSTALL_TEST_GH_ENV_LOG"
fi
exit "\${AGENC_INSTALL_TEST_GH_EXIT:-0}"
`);
  chmodSync(binary, 0o755);
  const archive = join(dir, "fake-gh.tar.gz");
  const result = spawnSync("tar", ["-czf", archive, "-C", join(dir, "fake-gh"), rootName]);
  expect(result.status, result.stderr?.toString()).toBe(0);
  const content = readFileSync(archive);
  const pinnedBytes = 14_652_560;
  expect(content.length).toBeLessThan(pinnedBytes);
  // GNU/BSD tar tolerate zero trailer blocks. Padding lets the fixture exercise
  // the production exact-byte pin while the digest fault seam remains confined
  // to the private instrumented installer copy.
  writeFileSync(archive, Buffer.concat([content, Buffer.alloc(pinnedBytes - content.length)]));
  return archive;
}

function writeLocalSwapPreload(dir: string): string {
  const preload = join(dir, "swap-local-resource.cjs");
  writeFileSync(preload, `
const fs = require("node:fs");
const original = fs.lstatSync;
let swapped = false;
fs.lstatSync = (path, ...args) => {
  const metadata = original(path, ...args);
  if (!swapped && String(path) === process.env.AGENC_INSTALL_TEST_SWAP_TARGET) {
    swapped = true;
    fs.renameSync(path, process.env.AGENC_INSTALL_TEST_SWAP_BACKUP);
    fs.renameSync(process.env.AGENC_INSTALL_TEST_SWAP_REPLACEMENT, path);
  }
  return metadata;
};
`);
  return preload;
}

function writeDurabilityPreload(dir: string): string {
  const preload = join(dir, "trace-installer-durability.cjs");
  writeFileSync(preload, `
const fs = require("node:fs");
const { resolve } = require("node:path");
const root = resolve(process.env.AGENC_INSTALL_TEST_DURABILITY_ROOT);
const logPath = process.env.AGENC_INSTALL_TEST_DURABILITY_LOG;
const append = fs.appendFileSync.bind(fs);
const descriptors = new Map();
const within = (path) => {
  const absolute = resolve(String(path));
  return absolute === root || absolute.startsWith(root + require("node:path").sep);
};
const log = (line) => append(logPath, line + "\\n");
const originalOpen = fs.openSync;
fs.openSync = (path, ...args) => {
  const descriptor = originalOpen(path, ...args);
  if (within(path)) descriptors.set(descriptor, resolve(String(path)));
  return descriptor;
};
const originalClose = fs.closeSync;
fs.closeSync = (descriptor) => {
  try { return originalClose(descriptor); }
  finally { descriptors.delete(descriptor); }
};
const originalFsync = fs.fsyncSync;
fs.fsyncSync = (descriptor) => {
  const path = descriptors.get(descriptor);
  if (path) {
    log("fsync " + path);
    const suffix = process.env.AGENC_INSTALL_TEST_FAIL_FSYNC_SUFFIX;
    if (suffix && path.endsWith(suffix)) throw new Error("injected fsync failure for " + path);
  }
  return originalFsync(descriptor);
};
const originalRename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (within(from) || within(to)) log("rename " + resolve(String(from)) + " -> " + resolve(String(to)));
  return originalRename(from, to);
};
const originalRemove = fs.rmSync;
fs.rmSync = (path, ...args) => {
  if (within(path)) log("remove " + resolve(String(path)));
  return originalRemove(path, ...args);
};
`);
  return preload;
}

function trustArtifactRoute(manifestName: string): string | undefined {
  if (manifestName === "short-manifest.json") return "/short.tar.gz";
  if (manifestName === "overrun-manifest.json") return "/overrun.tar.gz";
  if (manifestName === "length-manifest.json") return "/length.tar.gz";
  return undefined;
}

type HttpsRoute = {
  bodyText?: string;
  bodyBase64?: string;
  contentLength?: number;
  omitContentLength?: boolean;
  status?: number;
  location?: string;
  delayMs?: number;
  stallHeaders?: boolean;
  stallBody?: boolean;
};

function startHttpsFixture(
  dir: string,
  routes: Record<string, HttpsRoute>,
): { baseUrl: string; ca: string; stop: () => void } {
  const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
  if (openssl.status !== 0) throw new Error("openssl is required for installer HTTPS tests");
  const key = join(dir, "https-key.pem");
  const cert = join(dir, "https-cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  const config = join(dir, "https-routes.json");
  const ready = join(dir, "https-port");
  const server = join(dir, "https-server.cjs");
  writeFileSync(config, JSON.stringify(routes));
  writeFileSync(server, `
const https = require("node:https");
const { readFileSync, writeFileSync } = require("node:fs");
const [key, cert, config, ready] = process.argv.slice(2);
const routes = JSON.parse(readFileSync(config, "utf8"));
const sockets = new Set();
const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const route = routes[new URL(req.url, "https://localhost").pathname];
  if (!route) { res.writeHead(404); res.end(); return; }
  if (route.stallHeaders) return;
  const port = server.address().port;
  const body = route.bodyBase64 === undefined
    ? Buffer.from((route.bodyText || "").replaceAll("__PORT__", String(port)))
    : Buffer.from(route.bodyBase64, "base64");
  const headers = { "content-type": "application/octet-stream" };
  if (route.contentLength !== undefined) headers["content-length"] = String(route.contentLength);
  else if (!route.omitContentLength) headers["content-length"] = String(body.length);
  if (route.location !== undefined) {
    headers.location = route.location.replaceAll("__PORT__", String(port));
  }
  const respond = () => {
    res.writeHead(route.status || 200, headers);
    if (body.length > 0) res.write(route.stallBody ? body.subarray(0, 1) : body);
    if (!route.stallBody) res.end();
  };
  if (route.delayMs) setTimeout(respond, route.delayMs);
  else respond();
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.listen(0, "127.0.0.1", () => writeFileSync(ready, String(server.address().port)));
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
`);
  const child = spawn(process.execPath, [server, key, cert, config, ready], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const deadline = Date.now() + 5_000;
  while (!existsSync(ready) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!existsSync(ready)) {
    child.kill("SIGTERM");
    throw new Error("HTTPS fixture did not start");
  }
  const port = readFileSync(ready, "utf8").trim();
  return {
    baseUrl: `https://127.0.0.1:${port}`,
    ca: cert,
    stop: () => { if (!child.killed) child.kill("SIGTERM"); },
  };
}

function startConnectProxy(
  dir: string,
): { proxyUrl: string; log: string; stop: () => void } {
  const ready = join(dir, "proxy-port");
  const log = join(dir, "proxy-connect.log");
  const server = join(dir, "connect-proxy.cjs");
  writeFileSync(server, `
const http = require("node:http");
const net = require("node:net");
const { appendFileSync, writeFileSync } = require("node:fs");
const [ready, log] = process.argv.slice(2);
const sockets = new Set();
const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
proxy.on("connect", (req, client, head) => {
  appendFileSync(log, req.url + "\\n");
  const split = req.url.lastIndexOf(":");
  const host = req.url.slice(0, split);
  const port = Number(req.url.slice(split + 1));
  const upstream = net.connect(port, host, () => {
    client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  }
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
proxy.listen(0, "127.0.0.1", () => writeFileSync(ready, String(proxy.address().port)));
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  proxy.close(() => process.exit(0));
});
`);
  const child = spawn(process.execPath, [server, ready, log], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const deadline = Date.now() + 5_000;
  while (!existsSync(ready) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!existsSync(ready)) {
    child.kill("SIGTERM");
    throw new Error("CONNECT proxy fixture did not start");
  }
  return {
    proxyUrl: `http://127.0.0.1:${readFileSync(ready, "utf8").trim()}`,
    log,
    stop: () => { if (!child.killed) child.kill("SIGTERM"); },
  };
}

function trustBoundaryRoutes(
  artifact: { tarball: string; sha: string },
  platform: "linux" | "win",
): Record<string, HttpsRoute> {
  const artifactBytes = readFileSync(artifact.tarball);
  const manifestFor = (artifactPath: string): Record<string, any> =>
    remoteManifest(artifact, platform, `https://127.0.0.1:__PORT__${artifactPath}`);
  const json = (value: unknown): string => JSON.stringify(value);
  const short = manifestFor("/short.tar.gz");
  const overrun = manifestFor("/overrun.tar.gz");
  const length = manifestFor("/length.tar.gz");
  const duplicate = manifestFor("/unused.tar.gz");
  duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
  const missingTag = manifestFor("/unused.tar.gz");
  delete missingTag.releaseTag;
  const missingProvenance = manifestFor("/unused.tar.gz");
  delete missingProvenance.build;
  const detachedArtifact = manifestFor("/unused.tar.gz");
  detachedArtifact.artifacts[0].url = "https://mirror.example.invalid/runtime.tar.gz";
  const crossScheme = manifestFor("/unused.tar.gz");
  crossScheme.artifacts[0].url = pathToFileURL(artifact.tarball).href;
  const artifactCeiling = manifestFor("/unused.tar.gz");
  artifactCeiling.artifacts[0].bytes = 256 * 1024 * 1024 + 1;
  return {
    "/oversized-manifest.json": {
      bodyText: "x".repeat(1024 * 1024 + 1),
      omitContentLength: true,
    },
    "/manifest-length.json": { bodyText: "{}", contentLength: 1024 * 1024 + 1 },
    "/invalid-utf8.json": { bodyBase64: Buffer.from([0xff]).toString("base64") },
    "/short-manifest.json": { bodyText: json(short) },
    "/overrun-manifest.json": { bodyText: json(overrun) },
    "/length-manifest.json": { bodyText: json(length) },
    "/duplicate-manifest.json": { bodyText: json(duplicate) },
    "/missing-tag-manifest.json": { bodyText: json(missingTag) },
    "/missing-provenance-manifest.json": { bodyText: json(missingProvenance) },
    "/detached-artifact-manifest.json": { bodyText: json(detachedArtifact) },
    "/cross-scheme-manifest.json": { bodyText: json(crossScheme) },
    "/artifact-ceiling-manifest.json": { bodyText: json(artifactCeiling) },
    "/short.tar.gz": {
      bodyBase64: artifactBytes.subarray(0, Math.max(0, artifactBytes.length - 1)).toString("base64"),
      omitContentLength: true,
    },
    "/overrun.tar.gz": {
      bodyBase64: Buffer.concat([artifactBytes, Buffer.from("x")]).toString("base64"),
      omitContentLength: true,
    },
    "/length.tar.gz": {
      bodyBase64: artifactBytes.toString("base64"),
      contentLength: artifactBytes.length + 1,
    },
  };
}

function expectFailedInstallCleanup(home: string): void {
  const versionDir = join(home, ".agenc", "runtime", VERSION);
  if (existsSync(versionDir)) {
    expect(
      readdirSync(versionDir).filter((name) =>
        (name.includes("-sha256-") && !name.endsWith(".agenc-lock.sqlite")) ||
        name.includes(".install-") || name.includes(".old-")),
    ).toEqual([]);
  }
  const temporary = join(home, "tmp");
  if (existsSync(temporary)) {
    expect(readdirSync(temporary).filter((name) => name.startsWith("agenc-install-"))).toEqual([]);
  }
}

type RunResult = { status: number; stdout: string; stderr: string };

function runInstaller(opts: {
  home: string;
  agencHome?: string;
  cwd?: string;
  args?: string[];
  manifest?: string;
  manifestUrl?: string;
  repoDerived?: boolean;
  pathPrepend?: string[];
  envOverrides?: Record<string, string>;
  installerPath?: string;
}): RunResult {
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  chmodSync(opts.home, 0o700);
  const env = {
    HOME: opts.home,
    AGENC_HOME: opts.agencHome ?? join(opts.home, ".agenc"),
    TMPDIR: join(opts.home, "tmp"),
    PATH: [...(opts.pathPrepend ?? []), process.env.PATH ?? ""].join(":"),
    // Deterministic platform selection regardless of the host machine.
    AGENC_INSTALL_PLATFORM: "linux",
    AGENC_INSTALL_ARCH: "x64",
    AGENC_INSTALL_LIBC_FAMILY: "glibc",
    AGENC_INSTALL_GLIBC_VERSION: "2.39",
    AGENC_INSTALL_GLIBCXX_VERSION: "3.4.33",
    AGENC_INSTALL_CXXABI_VERSION: "1.3.15",
    ...opts.envOverrides,
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const res = spawnSync(
    "sh",
    [
      opts.installerPath ?? INSTALL_SH,
      ...(opts.repoDerived
        ? []
        : ["--manifest-url", opts.manifestUrl ?? pathToFileURL(opts.manifest!).href]),
      "--prefix",
      join(opts.home, ".local"),
      ...(opts.args ?? []),
    ],
    { env, encoding: "utf8", ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) },
  );
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function runInstallerAsync(opts: {
  home: string;
  manifest: string;
  args?: string[];
}): Promise<RunResult> {
  if (existsSync(opts.home)) chmodSync(opts.home, 0o700);
  const env = {
    HOME: opts.home,
    AGENC_HOME: join(opts.home, ".agenc"),
    TMPDIR: join(opts.home, "tmp"),
    PATH: process.env.PATH ?? "",
    AGENC_INSTALL_PLATFORM: "linux",
    AGENC_INSTALL_ARCH: "x64",
    AGENC_INSTALL_LIBC_FAMILY: "glibc",
    AGENC_INSTALL_GLIBC_VERSION: "2.39",
    AGENC_INSTALL_GLIBCXX_VERSION: "3.4.33",
    AGENC_INSTALL_CXXABI_VERSION: "1.3.15",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  return new Promise((resolveRun) => {
    const child = spawn(
      "sh",
      [
        INSTALL_SH,
        "--manifest-url",
        pathToFileURL(opts.manifest).href,
        "--prefix",
        join(opts.home, ".local"),
        "--no-daemon",
        ...(opts.args ?? []),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ status: code ?? -1, stdout, stderr }));
  });
}

describe.skipIf(process.platform === "win32")("install.sh", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "agenc-install-test-"));
  });
  afterEach(() => {
    removePersistentWrapperLocks(work);
    rmSync(work, { recursive: true, force: true });
  });

  function paths(home: string, artifactSha = "") {
    const installDir = join(
      home,
      ".agenc",
      "runtime",
      VERSION,
      `linux-x64-glibc-node-abi-${NODE_ABI}${artifactSha === "" ? "" : `-sha256-${artifactSha}`}`,
    );
    return {
      installDir,
      marker: join(installDir, ".agenc-runtime-ok"),
      provenanceReceipt: join(installDir, ".agenc-runtime-provenance-v1.json"),
      wrapper: join(home, ".local", "bin", "agenc"),
    };
  }

  test("fresh install: downloads, verifies, extracts, writes marker + working wrapper", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const res = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(res.stderr).toContain("checksum verified");
    expect(res.status).toBe(0);

    const { marker, wrapper } = paths(home, artifact.sha);
    expect(readFileSync(marker, "utf8")).toBe(artifact.sha);
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);
    // The created AGENC_HOME must be owner-only regardless of umask — a
    // stranger-install container test caught mkdir -p leaving it 755.
    expect(statSync(join(home, ".agenc")).mode & 0o777).toBe(0o700);
    const homeIdentity = statSync(join(home, ".agenc"), { bigint: true });
    expect(existsSync(resolve(`${homeIdentity.dev}:${homeIdentity.ino}`))).toBe(false);
    expect(existsSync(join(home, ".agenc", "runtime", ".activation-lock.sqlite"))).toBe(true);
    // The wrapper actually launches the installed runtime bin.
    const out = execFileSync(wrapper, ["--version"], { encoding: "utf8" });
    expect(out).toContain("ok --version");
  });

  test("production installer ignores ambient Node preload and TLS-disable controls", () => {
    const home = join(work, "preload-scrub-home");
    const sentinel = join(work, "ambient-preload-ran");
    const preload = join(work, "hostile-preload.cjs");
    writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran");\n`);
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);
    const result = runInstaller({
      home,
      manifest,
      args: ["--no-daemon"],
      envOverrides: {
        NODE_OPTIONS: `--require=${preload}`,
        NODE_PATH: join(work, "hostile-node-path"),
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("HTTPS downloads traverse the configured enterprise CONNECT proxy", () => {
    const fixture = startHttpsFixture(work, { "/manifest": { bodyText: "{}" } });
    const proxy = startConnectProxy(work);
    try {
      const result = runInstaller({
        home: join(work, "proxy-home"),
        manifestUrl: `${fixture.baseUrl}/manifest`,
        args: ["--no-daemon"],
        envOverrides: {
          HTTPS_PROXY: proxy.proxyUrl,
          NO_PROXY: "",
          NODE_EXTRA_CA_CERTS: fixture.ca,
          NODE_USE_ENV_PROXY: "0",
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported runtime manifest version");
      expect(readFileSync(proxy.log, "utf8")).toContain(
        new URL(fixture.baseUrl).host,
      );
    } finally {
      proxy.stop();
      fixture.stop();
    }
  });

  test("durability barriers commit payloads before promotion and journals around wrapper replacement", () => {
    const home = join(work, "durable-home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);
    const preload = writeDurabilityPreload(work);
    const trace = join(work, "durability.log");
    const result = runInstaller({
      home,
      manifest,
      args: ["--no-daemon"],
      installerPath: writeInstrumentedInstallSh(work),
      envOverrides: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim(),
        AGENC_INSTALL_TEST_DURABILITY_ROOT: home,
        AGENC_INSTALL_TEST_DURABILITY_LOG: trace,
      },
    });
    expect(result.status, result.stderr).toBe(0);

    const events = readFileSync(trace, "utf8").trim().split("\n");
    const { installDir, wrapper } = paths(home, artifact.sha);
    const versionDir = dirname(installDir);
    const runtimeRoot = join(home, ".agenc", "runtime");
    const journal = join(runtimeRoot, ".activation-transaction.json");
    const markerSync = events.findIndex(
      (event) => event.startsWith("fsync ") && event.endsWith("/.agenc-runtime-ok"),
    );
    const promotion = events.findIndex((event) => event.endsWith(` -> ${installDir}`));
    expect(markerSync).toBeGreaterThanOrEqual(0);
    expect(promotion).toBeGreaterThan(markerSync);
    expect(events.slice(promotion + 1)).toContain(`fsync ${versionDir}`);

    const journalSync = events.findIndex(
      (event) => event.startsWith(`fsync ${journal}.agenc-activate-`),
    );
    const journalRename = events.findIndex(
      (event) => event.startsWith("rename ") && event.endsWith(` -> ${journal}`),
    );
    expect(journalSync).toBeGreaterThanOrEqual(0);
    expect(journalRename).toBeGreaterThan(journalSync);
    expect(events.slice(journalRename + 1)).toContain(`fsync ${runtimeRoot}`);

    const wrapperSync = events.findIndex(
      (event) => event.startsWith(`fsync ${wrapper}.agenc-activate-`),
    );
    const wrapperRename = events.findIndex(
      (event) => event.startsWith("rename ") && event.endsWith(` -> ${wrapper}`),
    );
    expect(wrapperSync).toBeGreaterThanOrEqual(0);
    expect(wrapperRename).toBeGreaterThan(wrapperSync);
    const journalRemoval = events.findIndex((event) => event === `remove ${journal}`);
    expect(journalRemoval).toBeGreaterThan(wrapperRename);
    expect(events.slice(journalRemoval + 1)).toContain(`fsync ${runtimeRoot}`);
  });

  test("a marker flush failure aborts before runtime promotion and cleans staging residue", () => {
    const home = join(work, "failed-flush-home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);
    const preload = writeDurabilityPreload(work);
    const result = runInstaller({
      home,
      manifest,
      args: ["--no-daemon"],
      installerPath: writeInstrumentedInstallSh(work),
      envOverrides: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim(),
        AGENC_INSTALL_TEST_DURABILITY_ROOT: home,
        AGENC_INSTALL_TEST_DURABILITY_LOG: join(work, "failed-durability.log"),
        AGENC_INSTALL_TEST_FAIL_FSYNC_SUFFIX: ".agenc-runtime-ok",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("injected fsync failure");
    expect(existsSync(paths(home, artifact.sha).installDir)).toBe(false);
    expectFailedInstallCleanup(home);
  });

  test("rejects relative AGENC_HOME before cwd can become persistent identity", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const res = runInstaller({
      home,
      agencHome: "relative-home",
      cwd: work,
      manifest,
      args: ["--no-daemon"],
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("AGENC_HOME must be an absolute path");
    expect(existsSync(join(work, "relative-home"))).toBe(false);
  });

  test("canonicalizes an existing AGENC_HOME symlink before install and wrapper rendering", () => {
    const home = join(work, "home");
    const canonicalHome = join(home, "canonical-agenc-home");
    const aliasHome = join(home, "agenc-home-alias");
    mkdirSync(canonicalHome, { recursive: true, mode: 0o700 });
    symlinkSync(canonicalHome, aliasHome, "dir");
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const res = runInstaller({
      home,
      agencHome: aliasHome,
      manifest,
      args: ["--no-daemon"],
    });

    expect(res.status, res.stderr).toBe(0);
    const wrapper = join(home, ".local", "bin", "agenc");
    expect(parseInstallShWrapper(wrapper)).toMatchObject({ agencHome: canonicalHome });
    expect(
      existsSync(join(
        canonicalHome,
        "runtime",
        VERSION,
        `linux-x64-glibc-node-abi-${NODE_ABI}-sha256-${artifact.sha}`,
      )),
    ).toBe(true);
  });

  test("checksum mismatch: aborts nonzero, installs nothing", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact, {
      sha256: "0".repeat(64),
    });

    const res = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("checksum mismatch");

    const { installDir, wrapper } = paths(home);
    expect(existsSync(installDir)).toBe(false);
    expect(existsSync(wrapper)).toBe(false);
  });

  test("idempotent: verified marker short-circuits the download entirely", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const first = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(first.status).toBe(0);

    // Remove the artifact: a second run can only succeed via the marker path.
    rmSync(artifact.tarball);
    const second = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(second.status).toBe(0);
    expect(second.stderr).toContain("already installed");
  });

  test.each(["symlinked", "writable"] as const)(
    "refuses a %s runtime ancestor before cache fast-path reuse",
    (kind) => {
      const home = join(work, `unsafe-cache-${kind}`);
      const artifact = makeSyntheticArtifact(join(work, kind));
      const manifest = writeManifest(join(work, kind), artifact);
      expect(runInstaller({ home, manifest, args: ["--no-daemon"] }).status).toBe(0);
      const runtimeRoot = join(home, ".agenc", "runtime");
      if (kind === "symlinked") {
        const canonicalRuntime = join(home, ".agenc", "runtime-canonical");
        renameSync(runtimeRoot, canonicalRuntime);
        symlinkSync(canonicalRuntime, runtimeRoot, "dir");
      } else {
        chmodSync(runtimeRoot, 0o777);
      }
      rmSync(artifact.tarball);

      const reused = runInstaller({ home, manifest, args: ["--no-daemon"] });
      expect(reused.status).not.toBe(0);
      expect(reused.stderr).not.toContain("already installed");
      expect(reused.stderr).toMatch(/canonical path|protected directory chain/);
    },
  );

  test("preserves a custom wrapper that only contains the historical generated marker", () => {
    const home = join(work, "home");
    const wrapperDir = join(home, ".local", "bin");
    mkdirSync(wrapperDir, { recursive: true, mode: 0o700 });
    for (const path of [home, join(home, ".local"), wrapperDir]) chmodSync(path, 0o700);
    const wrapper = join(wrapperDir, "agenc");
    const custom = [
      "#!/bin/sh",
      "# Generated by AgenC install.sh — rewritten on every install/upgrade.",
      "echo user-owned-wrapper",
      "",
    ].join("\n");
    writeFileSync(wrapper, custom, { mode: 0o755 });
    chmodSync(wrapper, 0o755);
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const result = runInstaller({ home, manifest, args: ["--no-daemon"] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to replace a wrapper not generated by AgenC");
    expect(readFileSync(wrapper, "utf8")).toBe(custom);
  });

  test("a verified promotion backup is restored before artifact download", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);
    expect(runInstaller({ home, manifest, args: ["--no-daemon"] }).status).toBe(0);
    const { installDir, marker } = paths(home, artifact.sha);
    const backup = `${installDir}.old-crash`;
    renameSync(installDir, backup);
    rmSync(artifact.tarball);

    const recovered = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(artifact.sha);
    expect(existsSync(backup)).toBe(false);
    expect(recovered.stderr).toContain("already installed");
  });

  test("a prepared stage wins over invalid promotion residue without network I/O", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);
    expect(runInstaller({ home, manifest, args: ["--no-daemon"] }).status).toBe(0);
    const { installDir } = paths(home, artifact.sha);
    const base = installDir.split(/[\\/]/).at(-1)!;
    const stage = join(dirname(installDir), `.${base}.install-crash`);
    renameSync(installDir, stage);
    mkdirSync(installDir);
    writeFileSync(join(installDir, ".agenc-runtime-ok"), "invalid");
    cpSync(installDir, `${installDir}.old-invalid`, { recursive: true });
    rmSync(artifact.tarball);

    const recovered = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(join(installDir, BIN_REL), "utf8")).toContain("console.log");
    expect(
      readdirSync(dirname(installDir)).filter((name) => name.includes(".install-") || name.includes(".old-")),
    ).toEqual([]);
  });

  test("a valid marker with a missing runtime entrypoint is repaired", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);
    expect(runInstaller({ home, manifest, args: ["--no-daemon"] }).status).toBe(0);

    const { installDir } = paths(home, artifact.sha);
    rmSync(join(installDir, BIN_REL));
    const repaired = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(repaired.status).toBe(0);
    expect(readFileSync(join(installDir, BIN_REL), "utf8")).toContain("console.log");
  });

  test("rejects byte-count tampering before extraction", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact, {
      bytes: statSync(artifact.tarball).size + 1,
    });
    const result = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("byte count mismatch");
    expect(existsSync(paths(home).installDir)).toBe(false);
  });

  test("embedded runtime install preserves primary and cleanup failures in order", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeRawTarArtifact(work, [
      { name: "node_modules/", type: "5" },
      { name: "node_modules/placeholder.txt", body: "missing runtime entrypoint\n" },
    ]);
    const manifest = writeManifest(work, artifact);

    const result = runInstaller({
      home,
      manifest,
      args: ["--no-daemon"],
      envOverrides: {
        AGENC_INSTALL_TEST_FAIL_STAGING_CLEANUP: "1",
        AGENC_INSTALL_TEST_FAIL_RELEASE_CLEANUP: "1",
      },
    });

    expect(result.status).not.toBe(0);
    const primary = result.stderr.indexOf("runtime entrypoint is not a contained regular file");
    const staging = result.stderr.indexOf("injected staging cleanup failure");
    const release = result.stderr.indexOf("injected release cleanup failure");
    expect(primary, result.stderr).toBeGreaterThanOrEqual(0);
    expect(staging).toBeGreaterThan(primary);
    expect(release).toBeGreaterThan(staging);
    const versionDir = join(home, ".agenc", "runtime", VERSION);
    expect(readdirSync(versionDir).some((name) => name.startsWith("."))).toBe(false);
  });

  test.each([
    ["traversal", { name: "../escape", body: "owned" }, /unsafe runtime archive path/],
    ["escaping symlink", { name: "node_modules/link", type: "2", link: "../../escape" }, /runtime archive link escapes/],
  ] as const)("rejects an unsafe %s archive before tar extraction", (_label, malicious, error) => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeRawTarArtifact(work, [
      { name: "node_modules/", type: "5" },
      malicious,
    ]);
    const manifest = writeManifest(work, artifact);
    const result = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(error);
    expect(existsSync(join(work, "escape"))).toBe(false);
    expect(existsSync(paths(home).installDir)).toBe(false);
  });

  test("rejects duplicate matching artifacts and path-bearing identity tampering", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.artifacts.push({ ...manifest.artifacts[0] });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const duplicate = runInstaller({ home, manifest: manifestPath, args: ["--no-daemon"] });
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("duplicate runtime manifest artifact");

    manifest.artifacts.length = 1;
    manifest.artifacts[0].bins.agenc = "../../escape";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const pathTamper = runInstaller({ home, manifest: manifestPath, args: ["--no-daemon"] });
    expect(pathTamper.status).not.toBe(0);
    expect(pathTamper.stderr).toContain("manifest artifact identity is invalid");
  });

  test("rejects HTTP artifacts and a manifest that disagrees with --version", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact, { url: "http://example.invalid/runtime.tar.gz" });
    const insecure = runInstaller({ home, manifest: manifestPath, args: ["--no-daemon"] });
    expect(insecure.status).not.toBe(0);
    expect(insecure.stderr).toContain("explicit local manifests may only use canonical file artifact URLs");

    writeManifest(work, artifact);
    const mismatchedPin = runInstaller({
      home,
      manifest: manifestPath,
      args: ["--version", "1.2.3", "--no-daemon"],
    });
    expect(mismatchedPin.status).not.toBe(0);
    expect(mismatchedPin.stderr).toContain("does not match pinned version");
  });

  test("rejects authority, UNC, device-namespace, and drive-relative local artifact URLs", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const invalidUrls = [
      `file://localhost${new URL(pathToFileURL(artifact.tarball).href).pathname}`,
      "file:////server/share/runtime.tar.gz",
      "file:///%5C%5C%3F%5CC:%5Cruntime.tar.gz",
      "file:///C:runtime.tar.gz",
    ];
    for (const [index, url] of invalidUrls.entries()) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.artifacts[0].url = url;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = runInstaller({
        home,
        manifest: manifestPath,
        args: ["--no-daemon"],
      });
      expect(result.status, `${index}: ${result.stderr}`).not.toBe(0);
      expect(result.stderr).toContain(
        "explicit local manifests may only use canonical file artifact URLs",
      );
    }
  });

  test.each(["attestationUrl", "attestationSha256", "attestationBytes"])(
    "explicit-local manifests reject a declared %s even when it is null",
    (field) => {
      const fixtureRoot = join(work, `local-attestation-${field}`);
      const home = join(fixtureRoot, "home");
      mkdirSync(home, { recursive: true });
      const artifact = makeSyntheticArtifact(fixtureRoot);
      const manifest = writeManifest(fixtureRoot, artifact, { [field]: null });
      const result = runInstaller({ home, manifest, args: ["--no-daemon"] });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "explicit local runtime artifacts must not declare remote attestations",
      );
      expectFailedInstallCleanup(home);
    },
  );

  test("rejects a local resource swapped between metadata validation and descriptor open", () => {
    const home = join(work, "home");
    const replacementDir = join(work, "replacement");
    mkdirSync(home, { recursive: true });
    mkdirSync(replacementDir);
    const artifact = makeSyntheticArtifact(work);
    const replacement = makeSyntheticArtifact(replacementDir);
    const manifest = writeManifest(work, artifact);
    const preload = writeLocalSwapPreload(work);
    const backup = `${artifact.tarball}.before-swap`;

    const result = runInstaller({
      home,
      manifest,
      args: ["--no-daemon"],
      installerPath: writeInstrumentedInstallSh(work),
      envOverrides: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim(),
        AGENC_INSTALL_TEST_SWAP_TARGET: artifact.tarball,
        AGENC_INSTALL_TEST_SWAP_BACKUP: backup,
        AGENC_INSTALL_TEST_SWAP_REPLACEMENT: replacement.tarball,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local resource changed while it was opened");
    expect(existsSync(backup)).toBe(true);
    expectFailedInstallCleanup(home);
  });

  test("one monotonic download deadline covers stalled headers, bodies, and redirect chains", () => {
    const fixture = startHttpsFixture(work, {
      "/stall-headers": { stallHeaders: true },
      "/stall-body": { bodyText: "{}", contentLength: 32, stallBody: true },
      "/slow-redirect-one": {
        status: 302,
        location: "/slow-redirect-two",
        delayMs: 90,
      },
      "/slow-redirect-two": {
        status: 302,
        location: "/never-reached",
        delayMs: 90,
      },
      "/never-reached": { bodyText: "{}" },
      "/redirect-loop": { status: 302, location: "/redirect-loop" },
    });
    try {
      for (const route of ["stall-headers", "stall-body", "slow-redirect-one"]) {
        const home = join(work, `deadline-${route}`);
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const started = Date.now();
        const result = runInstaller({
          home,
          manifestUrl: `${fixture.baseUrl}/${route}`,
          args: ["--no-daemon"],
          envOverrides: {
            NODE_EXTRA_CA_CERTS: fixture.ca,
            AGENC_INSTALL_TEST_DOWNLOAD_TIMEOUT_MS: "150",
          },
        });
        expect(result.status, `${route}: ${result.stderr}`).not.toBe(0);
        expect(result.stderr, route).toContain("download deadline exceeded after 150ms");
        expect(Date.now() - started).toBeLessThan(5_000);
        expectFailedInstallCleanup(home);
      }
      const redirectHome = join(work, "deadline-redirect-count");
      const redirectResult = runInstaller({
        home: redirectHome,
        manifestUrl: `${fixture.baseUrl}/redirect-loop`,
        args: ["--no-daemon"],
        envOverrides: {
          NODE_EXTRA_CA_CERTS: fixture.ca,
          AGENC_INSTALL_TEST_DOWNLOAD_TIMEOUT_MS: "2000",
        },
      });
      expect(redirectResult.status).not.toBe(0);
      expect(redirectResult.stderr).toContain("too many HTTPS redirects");
      expectFailedInstallCleanup(redirectHome);
    } finally {
      fixture.stop();
    }
  }, 15_000);

  test("repo-derived manifests bind releaseRepository while explicit manifest URLs remain explicit trust", () => {
    const artifact = makeSyntheticArtifact(work);
    const manifest = remoteManifest(artifact, "linux", "unused");
    const fixture = startHttpsFixture(work, {
      "/repo-manifest.json": { bodyText: JSON.stringify(manifest) },
      "/repo-artifact.tar.gz": { bodyBase64: readFileSync(artifact.tarball).toString("base64") },
    });
    const fetchRewrite = writeGithubArtifactFetchRewrite(work);
    const installerPath = writeInstrumentedInstallSh(work);
    const common = {
      NODE_EXTRA_CA_CERTS: fixture.ca,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${fetchRewrite}`.trim(),
      AGENC_INSTALL_TEST_GITHUB_MANIFEST_URL: `${fixture.baseUrl}/repo-manifest.json`,
      AGENC_INSTALL_TEST_GITHUB_ARTIFACT_URL: `${fixture.baseUrl}/repo-artifact.tar.gz`,
    };
    try {
      const matchingHome = join(work, "repo-matching");
      const matching = runInstaller({
        home: matchingHome,
        repoDerived: true,
        args: ["--repo", "test/mirror", "--no-daemon"],
        installerPath,
        envOverrides: common,
      });
      expect(matching.status, matching.stderr).toBe(0);

      const mismatchHome = join(work, "repo-mismatch");
      const mismatch = runInstaller({
        home: mismatchHome,
        repoDerived: true,
        args: ["--repo", "requested/repository", "--no-daemon"],
        installerPath,
        envOverrides: common,
      });
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain(
        "releaseRepository test/mirror does not match requested requested/repository",
      );
      expectFailedInstallCleanup(mismatchHome);

      const explicitHome = join(work, "repo-explicit-url");
      const explicit = runInstaller({
        home: explicitHome,
        manifestUrl: `${fixture.baseUrl}/repo-manifest.json`,
        args: ["--no-daemon"],
        installerPath,
        envOverrides: common,
      });
      expect(explicit.status, explicit.stderr).toBe(0);
    } finally {
      fixture.stop();
    }
  }, 30_000);

  test("official manifests require a complete canonical attestation identity", () => {
    const artifact = makeSyntheticArtifact(work);
    const base = remoteManifest(
      artifact,
      "linux",
      "unused",
      "tetsuo-ai/agenc-releases",
    );
    const cases: Array<[string, (manifest: Record<string, any>) => void, string]> = [
      ["missing-url", (manifest) => { delete manifest.artifacts[0].attestationUrl; }, "attestation URL"],
      ["missing-sha", (manifest) => { delete manifest.artifacts[0].attestationSha256; }, "attestation digest"],
      ["missing-bytes", (manifest) => { delete manifest.artifacts[0].attestationBytes; }, "attestation size"],
      ["wrong-url", (manifest) => { manifest.artifacts[0].attestationUrl = "https://example.invalid/bundle"; }, "attestation URL"],
      ["wrong-sha", (manifest) => { manifest.artifacts[0].attestationSha256 = "A".repeat(64); }, "attestation digest"],
      ["oversized", (manifest) => { manifest.artifacts[0].attestationBytes = 4 * 1024 * 1024 + 1; }, "attestation size"],
    ];
    const routes = Object.fromEntries(cases.map(([name, mutate]) => {
      const manifest = structuredClone(base);
      mutate(manifest);
      return [`/${name}.json`, { bodyText: JSON.stringify(manifest) }];
    }));
    const fixture = startHttpsFixture(work, routes);
    const rewrite = writeGithubArtifactFetchRewrite(work);
    const installerPath = writeInstrumentedInstallSh(work);
    try {
      for (const [name, _mutate, expected] of cases) {
        const result = runInstaller({
          home: join(work, `official-${name}`),
          repoDerived: true,
          args: ["--no-daemon"],
          installerPath,
          envOverrides: {
            NODE_EXTRA_CA_CERTS: fixture.ca,
            NODE_OPTIONS: `--require=${rewrite}`,
            AGENC_INSTALL_TEST_GITHUB_MANIFEST_URL: `${fixture.baseUrl}/${name}.json`,
          },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr, name).toContain(expected);
      }
    } finally {
      fixture.stop();
    }
  }, 30_000);

  test("official v2 installs verify the canonical Sigstore bundle with a fresh pinned gh", () => {
    const artifact = makeSyntheticArtifact(work);
    const manifest = remoteManifest(
      artifact,
      "linux",
      "unused",
      "tetsuo-ai/agenc-releases",
    );
    const fakeGh = makeFakeGhArchive(work);
    const fixture = startHttpsFixture(work, {
      "/official-manifest.json": { bodyText: JSON.stringify(manifest) },
      "/official-runtime.tar.gz": { bodyBase64: readFileSync(artifact.tarball).toString("base64") },
      "/official-runtime.sigstore.json": { bodyText: "{}" },
      "/fake-gh.tar.gz": { bodyBase64: readFileSync(fakeGh).toString("base64") },
      "/oversized-bundle": { bodyText: "{}", contentLength: 4 * 1024 * 1024 + 1 },
    });
    const fetchRewrite = writeGithubArtifactFetchRewrite(work);
    const installerPath = writeInstrumentedInstallSh(work, fakeGh);
    const fetchLog = join(work, "official-fetches.log");
    const ghLog = join(work, "verified-gh-args.log");
    const ghEnvLog = join(work, "verified-gh-env.log");
    const ambientLog = join(work, "ambient-gh.log");
    const ambientTarLog = join(work, "ambient-tar.log");
    const ambientBin = join(work, "ambient-bin");
    mkdirSync(ambientBin);
    writeFileSync(join(ambientBin, "gh"), `#!/bin/sh\nprintf ambient > "${ambientLog}"\nexit 99\n`);
    chmodSync(join(ambientBin, "gh"), 0o755);
    writeFileSync(join(ambientBin, "tar"), `#!/bin/sh\nprintf ambient > "${ambientTarLog}"\nexit 99\n`);
    chmodSync(join(ambientBin, "tar"), 0o755);
    const common = {
      NODE_EXTRA_CA_CERTS: fixture.ca,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${fetchRewrite}`.trim(),
      AGENC_INSTALL_TEST_GITHUB_MANIFEST_URL: `${fixture.baseUrl}/official-manifest.json`,
      AGENC_INSTALL_TEST_GITHUB_ARTIFACT_URL: `${fixture.baseUrl}/official-runtime.tar.gz`,
      AGENC_INSTALL_TEST_GITHUB_BUNDLE_URL: `${fixture.baseUrl}/official-runtime.sigstore.json`,
      AGENC_INSTALL_TEST_GH_ARCHIVE_URL: `${fixture.baseUrl}/fake-gh.tar.gz`,
      AGENC_INSTALL_TEST_FETCH_LOG: fetchLog,
      AGENC_INSTALL_TEST_GH_LOG: ghLog,
      AGENC_INSTALL_TEST_GH_ENV_LOG: ghEnvLog,
      GH_TOKEN: "ambient-gh-secret",
      GITHUB_TOKEN: "ambient-github-secret",
      HTTPS_PROXY: "http://enterprise-proxy.invalid:8443",
      NO_PROXY: "127.0.0.1,localhost",
    };
    try {
      const home = join(work, "official-success");
      const result = runInstaller({
        home,
        repoDerived: true,
        args: ["--no-daemon"],
        installerPath,
        pathPrepend: [ambientBin],
        envOverrides: common,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("source-workflow provenance verified");
      expect(existsSync(ambientLog)).toBe(false);
      expect(existsSync(ambientTarLog)).toBe(false);
      const ghArgs = readFileSync(ghLog, "utf8");
      expect(ghArgs).toContain("attestation\nverify\n");
      expect(ghArgs).toContain("--repo\ntetsuo-ai/agenc-core\n");
      expect(ghArgs).toContain(
        "--signer-workflow\ntetsuo-ai/agenc-core/.github/workflows/release-runtime.yml\n",
      );
      expect(ghArgs).toContain(`--source-digest\n${"a".repeat(40)}\n`);
      expect(ghArgs).toContain(`--signer-digest\n${"a".repeat(40)}\n`);
      expect(ghArgs).toContain(`--source-ref\nrefs/tags/agenc-v${VERSION}\n`);
      expect(ghArgs).toContain("--hostname\ngithub.com\n");
      expect(ghArgs).toContain(
        "--cert-oidc-issuer\nhttps://token.actions.githubusercontent.com\n",
      );
      expect(ghArgs).toContain("--predicate-type\nhttps://slsa.dev/provenance/v1\n");
      expect(ghArgs).toContain("--deny-self-hosted-runners\n");
      const ghEnvironment = readFileSync(ghEnvLog, "utf8");
      expect(ghEnvironment).toContain("GH_CONFIG_DIR=");
      expect(ghEnvironment).toContain("/gh-config\n");
      expect(ghEnvironment).toContain("GH_TOKEN=\n");
      expect(ghEnvironment).toContain("GITHUB_TOKEN=\n");
      expect(ghEnvironment).toContain(
        "HTTPS_PROXY=http://enterprise-proxy.invalid:8443\n",
      );
      expect(ghEnvironment).toContain("GH_TELEMETRY=0\n");
      expect(ghEnvironment).toContain("DO_NOT_TRACK=1\n");
      expect(ghEnvironment).toContain("GH_NO_UPDATE_NOTIFIER=1\n");
      expect(ghEnvironment).toContain("GH_SPINNER_DISABLED=1\n");
      const fetched = readFileSync(fetchLog, "utf8");
      expect(fetched).toContain(`${manifest.artifacts[0].url}.sigstore.json`);
      expect(fetched).toContain(
        "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_amd64.tar.gz",
      );

      const receiptPath = paths(home, artifact.sha).provenanceReceipt;
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
        schema: "agenc-runtime-provenance/v1",
        artifactSha256: artifact.sha,
        artifactUrl: manifest.artifacts[0].url,
        sourceRepository: "tetsuo-ai/agenc-core",
        sourceWorkflow: "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml",
        sourceCommit: "a".repeat(40),
        sourceRef: `refs/tags/agenc-v${VERSION}`,
        attestationUrl: manifest.artifacts[0].attestationUrl,
        attestationSha256: sha256(Buffer.from("{}")),
        attestationBytes: Buffer.byteLength("{}"),
        verificationPolicy: {
          hostname: "github.com",
          certOidcIssuer: "https://token.actions.githubusercontent.com",
          predicateType: "https://slsa.dev/provenance/v1",
          denySelfHostedRunners: true,
        },
      });

      // A SHA-only cache from before provenance receipts existed must be
      // migrated through a fresh official download and verification.
      rmSync(receiptPath);
      rmSync(fetchLog, { force: true });
      const migrated = runInstaller({
        home,
        repoDerived: true,
        args: ["--no-daemon"],
        installerPath,
        pathPrepend: [ambientBin],
        envOverrides: common,
      });
      expect(migrated.status, migrated.stderr).toBe(0);
      expect(migrated.stderr).toContain("source-workflow provenance verified");
      expect(existsSync(receiptPath)).toBe(true);
      expect(readFileSync(fetchLog, "utf8")).toContain(
        `${manifest.artifacts[0].url}.sigstore.json`,
      );

      // The versioned policy receipt restores safe content-addressed reuse.
      rmSync(fetchLog, { force: true });
      const cached = runInstaller({
        home,
        repoDerived: true,
        args: ["--no-daemon"],
        installerPath,
        pathPrepend: [ambientBin],
        envOverrides: {
          ...common,
          AGENC_INSTALL_TEST_GITHUB_ARTIFACT_URL: `${fixture.baseUrl}/missing-artifact`,
          AGENC_INSTALL_TEST_GITHUB_BUNDLE_URL: `${fixture.baseUrl}/missing-bundle`,
          AGENC_INSTALL_TEST_GH_ARCHIVE_URL: `${fixture.baseUrl}/missing-gh`,
        },
      });
      expect(cached.status, cached.stderr).toBe(0);
      expect(cached.stderr).toContain("already installed (verified marker)");
      const cachedFetches = readFileSync(fetchLog, "utf8");
      expect(cachedFetches).not.toContain(manifest.artifacts[0].url);
      expect(cachedFetches).not.toContain(".sigstore.json");
      expect(cachedFetches).not.toContain("/cli/cli/releases/download/");

      for (const [field, value] of [
        ["attestationUrl", `${manifest.artifacts[0].url}.tampered`],
        ["attestationSha256", "0".repeat(64)],
        ["attestationBytes", 1],
      ] as const) {
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        receipt[field] = value;
        writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
        rmSync(fetchLog, { force: true });
        const repaired = runInstaller({
          home,
          repoDerived: true,
          args: ["--no-daemon"],
          installerPath,
          pathPrepend: [ambientBin],
          envOverrides: common,
        });
        expect(repaired.status, `${field}: ${repaired.stderr}`).toBe(0);
        expect(repaired.stderr).toContain("source-workflow provenance verified");
        expect(readFileSync(fetchLog, "utf8")).toContain(
          manifest.artifacts[0].attestationUrl,
        );
      }

      const rejectedHome = join(work, "official-rejected-provenance");
      const rejected = runInstaller({
        home: rejectedHome,
        repoDerived: true,
        args: ["--no-daemon"],
        installerPath,
        envOverrides: { ...common, AGENC_INSTALL_TEST_GH_EXIT: "1" },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("official runtime provenance verification failed");
      expectFailedInstallCleanup(rejectedHome);

      const oversizedHome = join(work, "official-oversized-bundle");
      const oversized = runInstaller({
        home: oversizedHome,
        repoDerived: true,
        args: ["--no-daemon"],
        installerPath,
        envOverrides: {
          ...common,
          AGENC_INSTALL_TEST_GITHUB_BUNDLE_URL: `${fixture.baseUrl}/oversized-bundle`,
        },
      });
      expect(oversized.status).not.toBe(0);
      expect(oversized.stderr).toContain("Content-Length exceeds 4194304 byte limit");
      expectFailedInstallCleanup(oversizedHome);
    } finally {
      fixture.stop();
    }
  }, 45_000);

  test("official provenance fails closed when the downloaded gh digest drifts", () => {
    const artifact = makeSyntheticArtifact(work);
    const manifest = remoteManifest(
      artifact,
      "linux",
      "unused",
      "tetsuo-ai/agenc-releases",
    );
    const fakeGh = makeFakeGhArchive(work);
    const fixture = startHttpsFixture(work, {
      "/manifest": { bodyText: JSON.stringify(manifest) },
      "/artifact": { bodyBase64: readFileSync(artifact.tarball).toString("base64") },
      "/bundle": { bodyText: "{}" },
      "/gh": { bodyBase64: readFileSync(fakeGh).toString("base64") },
    });
    const rewrite = writeGithubArtifactFetchRewrite(work);
    const installerPath = writeInstrumentedInstallSh(work);
    try {
      const home = join(work, "official-gh-drift");
      const result = runInstaller({
        home,
        repoDerived: true,
        args: ["--no-daemon"],
        installerPath,
        envOverrides: {
          NODE_EXTRA_CA_CERTS: fixture.ca,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${rewrite}`.trim(),
          AGENC_INSTALL_TEST_GITHUB_MANIFEST_URL: `${fixture.baseUrl}/manifest`,
          AGENC_INSTALL_TEST_GITHUB_ARTIFACT_URL: `${fixture.baseUrl}/artifact`,
          AGENC_INSTALL_TEST_GITHUB_BUNDLE_URL: `${fixture.baseUrl}/bundle`,
          AGENC_INSTALL_TEST_GH_ARCHIVE_URL: `${fixture.baseUrl}/gh`,
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("GitHub CLI checksum mismatch");
      expectFailedInstallCleanup(home);
    } finally {
      fixture.stop();
    }
  }, 30_000);

  test("bounded HTTPS trust rejects malformed manifests and truncated/overrun artifacts without residue", () => {
    const artifact = makeSyntheticArtifact(work);
    const fixture = startHttpsFixture(work, trustBoundaryRoutes(artifact, "linux"));
    const fetchRewrite = writeGithubArtifactFetchRewrite(work);
    const installerPath = writeInstrumentedInstallSh(work);
    try {
      const cases = [
        ["oversized-manifest.json", "download exceeds 1048576 byte limit"],
        ["manifest-length.json", "Content-Length exceeds 1048576 byte limit"],
        ["invalid-utf8.json", "runtime manifest is not valid UTF-8"],
        ["short-manifest.json", "download byte count mismatch"],
        ["overrun-manifest.json", "download exceeds declared"],
        ["length-manifest.json", "Content-Length mismatch"],
        ["duplicate-manifest.json", "duplicate runtime manifest artifact"],
        ["missing-tag-manifest.json", "runtime manifest release identity is invalid"],
        ["missing-provenance-manifest.json", "runtime manifest build provenance is invalid"],
        ["detached-artifact-manifest.json", "manifest artifact URL is not canonical"],
        ["cross-scheme-manifest.json", "remote manifests may only reference HTTPS artifacts"],
        ["artifact-ceiling-manifest.json", "manifest artifact identity is invalid"],
      ] as const;
      for (const [name, expected] of cases) {
        const home = join(work, `shell-${name}`);
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const result = runInstaller({
          home,
          manifestUrl: `${fixture.baseUrl}/${name}`,
          args: ["--no-daemon"],
          installerPath,
          envOverrides: {
            NODE_EXTRA_CA_CERTS: fixture.ca,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${fetchRewrite}`.trim(),
            AGENC_INSTALL_TEST_GITHUB_ARTIFACT_URL:
              trustArtifactRoute(name) === undefined
                ? ""
                : `${fixture.baseUrl}${trustArtifactRoute(name)}`,
          },
        });
        expect(result.status, `${name}: ${result.stderr}`).not.toBe(0);
        expect(result.stderr, name).toContain(expected);
        expectFailedInstallCleanup(home);
      }
    } finally {
      fixture.stop();
    }
  }, 30_000);

  test("four concurrent installers converge on one complete tree", async () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runInstallerAsync({ home, manifest })),
    );
    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0]);
    const { installDir, marker } = paths(home, artifact.sha);
    expect(readFileSync(marker, "utf8")).toBe(artifact.sha);
    expect(readFileSync(join(installDir, BIN_REL), "utf8")).toContain("console.log");
    const versionDir = dirname(installDir);
    expect(
      readdirSync(versionDir).filter((name) => name.includes(".install-") || name.includes(".old-") || name.endsWith(".lock")),
    ).toEqual([]);
  });

  test("a SIGKILL while holding the SQLite install lock is recovered immediately", async () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);
    const { installDir } = paths(home, artifact.sha);
    const versionDir = dirname(installDir);
    mkdirSync(versionDir, { recursive: true, mode: 0o700 });
    for (const privateDir of [
      join(home, ".agenc"),
      join(home, ".agenc", "runtime"),
      versionDir,
    ]) chmodSync(privateDir, 0o700);
    const embedded = readFileSync(INSTALL_SH, "utf8").match(
      /<<'AGENC_RUNTIME_INSTALLER'\n([\s\S]*?)\nAGENC_RUNTIME_INSTALLER/,
    )?.[1];
    expect(embedded).toBeTruthy();
    const helper = join(work, "runtime-installer-crash.cjs");
    writeFileSync(helper, embedded!);
    const holder = spawn(
      process.execPath,
      [helper, "recover", "", installDir, BIN_REL, artifact.sha, "linux"],
      {
        env: { ...process.env, AGENC_INSTALL_TEST_HOLD_RUNTIME_LOCK_MS: "5000" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const holderExit = new Promise<void>((resolveExit) => holder.once("exit", () => resolveExit()));
    const lockDatabase = `${installDir}.agenc-lock.sqlite`;
    const deadline = Date.now() + 2_000;
    while (!existsSync(lockDatabase) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(existsSync(lockDatabase)).toBe(true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    holder.kill("SIGKILL");
    await holderExit;

    const started = Date.now();
    const result = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(result.status, result.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readFileSync(join(installDir, ".agenc-runtime-ok"), "utf8")).toBe(artifact.sha);
  });

  test("an unpinned older installer cannot replace a newer active wrapper", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const makeVersion = (version: string, subdir: string) => {
      const dir = join(work, subdir);
      mkdirSync(dir);
      const artifact = makeSyntheticArtifact(dir);
      const manifestPath = writeManifest(dir, artifact);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.runtimeVersion = version;
      manifest.releaseTag = `agenc-v${version}`;
      manifest.artifacts[0].runtimeVersion = version;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      return { artifact, manifestPath };
    };
    const high = makeVersion("10.0.0", "high");
    const low = makeVersion("9.0.0", "low");
    const wrapper = join(home, ".local", "bin", "agenc");

    expect(runInstaller({ home, manifest: high.manifestPath, args: ["--no-daemon"] }).status).toBe(0);
    expect(readFileSync(wrapper, "utf8")).toContain(join("runtime", "10.0.0"));
    const retained = runInstaller({ home, manifest: low.manifestPath, args: ["--no-daemon"] });
    expect(retained.status, retained.stderr).toBe(0);
    expect(retained.stderr).toContain("kept newer active wrapper (10.0.0)");
    expect(readFileSync(wrapper, "utf8")).toContain(join("runtime", "10.0.0"));

    const pinned = runInstaller({
      home,
      manifest: low.manifestPath,
      args: ["--version", "9.0.0", "--no-daemon"],
    });
    expect(pinned.status, pinned.stderr).toBe(0);
    expect(readFileSync(wrapper, "utf8")).toContain(join("runtime", "9.0.0"));
  });

  test("the embedded activation lock makes a waiting older version re-read the winner", async () => {
    const embedded = readFileSync(INSTALL_SH, "utf8").match(
      /<<'AGENC_RUNTIME_INSTALLER'\n([\s\S]*?)\nAGENC_RUNTIME_INSTALLER/,
    )?.[1];
    expect(embedded).toBeTruthy();
    const helper = join(work, "runtime-installer.cjs");
    writeFileSync(helper, embedded!);
    const agencHome = join(work, "activation-home");
    mkdirSync(agencHome, { recursive: true, mode: 0o700 });
    const wrapper = join(work, "activation-bin", "agenc");
    mkdirSync(dirname(wrapper), { recursive: true });
    chmodSync(dirname(wrapper), 0o700);
    const runtimeBin = (version: string) =>
      join(agencHome, "runtime", version, `linux-x64-glibc-node-abi-${NODE_ABI}`, BIN_REL);
    const wrapperText = (version: string) => renderInstallShWrapper({
      nodeBin: process.execPath,
      runtimeBin: runtimeBin(version),
      agencHome,
    });
    writeFileSync(wrapper, wrapperText("8.0.0"));
    chmodSync(wrapper, 0o755);
    const highDesired = join(work, "high-wrapper");
    const lowDesired = join(work, "low-wrapper");
    writeFileSync(highDesired, wrapperText("10.0.0"));
    writeFileSync(lowDesired, wrapperText("9.0.0"));

    const runActivation = (
      desired: string,
      version: string,
      env: NodeJS.ProcessEnv,
    ): Promise<RunResult> => new Promise((resolveRun) => {
      const child = spawn(
        process.execPath,
        [helper, "activate", desired, wrapper, agencHome, version, "false"],
        { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolveRun({ status: code ?? -1, stdout, stderr }));
    });

    const high = runActivation(highDesired, "10.0.0", {
      AGENC_INSTALL_TEST_HOLD_ACTIVATION_LOCK_MS: "300",
    });
    const activationLock = join(agencHome, "runtime", ".activation-lock.sqlite");
    const deadline = Date.now() + 2_000;
    while (!existsSync(activationLock) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(existsSync(activationLock)).toBe(true);
    const low = runActivation(lowDesired, "9.0.0", {
      AGENC_INSTALL_TEST_AFTER_ACTIVATION_READ_MS: "500",
    });
    const [highResult, lowResult] = await Promise.all([high, low]);

    expect(highResult.status, highResult.stderr).toBe(0);
    expect(lowResult.status, lowResult.stderr).toBe(0);
    expect(highResult.stdout.trim()).toBe("activated");
    expect(lowResult.stdout.trim()).toBe("retained 10.0.0");
    expect(readFileSync(wrapper, "utf8")).toBe(wrapperText("10.0.0"));
  });

  test("cross-home activations share the OS-account registry despite mutable HOME variables", async () => {
    const embedded = readFileSync(INSTALL_SH, "utf8").match(
      /<<'AGENC_RUNTIME_INSTALLER'\n([\s\S]*?)\nAGENC_RUNTIME_INSTALLER/,
    )?.[1];
    expect(embedded).toBeTruthy();
    const helper = join(work, "cross-home-runtime-installer.cjs");
    writeFileSync(helper, embedded!);
    const firstHome = join(work, "first-agenc-home");
    const secondHome = join(work, "second-agenc-home");
    mkdirSync(firstHome, { recursive: true, mode: 0o700 });
    mkdirSync(secondHome, { recursive: true, mode: 0o700 });
    const wrapper = join(work, "shared-bin", "agenc");
    mkdirSync(dirname(wrapper), { recursive: true });
    chmodSync(dirname(wrapper), 0o700);
    const desired = (home: string, version: string, name: string) => {
      const path = join(work, name);
      writeFileSync(path, renderInstallShWrapper({
        nodeBin: process.execPath,
        runtimeBin: join(
          home,
          "runtime",
          version,
          `linux-x64-glibc-node-abi-${NODE_ABI}`,
          BIN_REL,
        ),
        agencHome: home,
      }));
      return path;
    };
    const firstDesired = desired(firstHome, "10.0.0", "first-desired-wrapper");
    const secondDesired = desired(secondHome, "11.0.0", "second-desired-wrapper");
    const spawnActivation = (
      desiredPath: string,
      home: string,
      version: string,
      env: NodeJS.ProcessEnv,
    ): { child: ReturnType<typeof spawn>; result: Promise<RunResult> } => {
      const child = spawn(
        process.execPath,
        [helper, "activate", desiredPath, wrapper, home, version, "false"],
        { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
      );
      const result = new Promise<RunResult>((resolveRun) => {
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.on("close", (code) => resolveRun({ status: code ?? -1, stdout, stderr }));
      });
      return { child, result };
    };

    const first = spawnActivation(firstDesired, firstHome, "10.0.0", {
      HOME: join(work, "mutable-home-a"),
      LOCALAPPDATA: join(work, "mutable-local-app-data-a"),
      AGENC_INSTALL_TEST_HOLD_ACTIVATION_LOCK_MS: "400",
    });
    const firstHomeLock = join(firstHome, "runtime", ".activation-lock.sqlite");
    const deadline = Date.now() + 2_000;
    while (!existsSync(firstHomeLock) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(existsSync(firstHomeLock)).toBe(true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    const second = spawnActivation(secondDesired, secondHome, "11.0.0", {
      HOME: join(work, "mutable-home-b"),
      LOCALAPPDATA: join(work, "mutable-local-app-data-b"),
    });
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status).not.toBe(0);
    expect(secondResult.stderr).toContain("wrapper belongs to a different AGENC_HOME");
    expect(parseInstallShWrapper(wrapper)).toMatchObject({ agencHome: firstHome });
  });

  test("daemon: writes a systemd user unit pointing at the wrapper and enables it", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    // Stub systemctl that records its argv lines.
    const stubDir = join(work, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const callLog = join(work, "systemctl-calls.log");
    writeFileSync(
      join(stubDir, "systemctl"),
      `#!/bin/sh\necho "$@" >> "${callLog}"\nexit 0\n`,
    );
    chmodSync(join(stubDir, "systemctl"), 0o755);

    const res = runInstaller({ home, manifest, pathPrepend: [stubDir] });
    expect(res.status).toBe(0);

    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "agenc-daemon.service"),
      "utf8",
    );
    const { wrapper } = paths(home);
    expect(unit).toContain(`ExecStart=:"${wrapper}" daemon start --foreground`);
    expect(unit).toContain("WantedBy=default.target");

    const calls = readFileSync(callLog, "utf8");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain("--user enable --now agenc-daemon.service");
  });

  test("--no-daemon skips service installation", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const res = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("daemon installation skipped");
    expect(
      existsSync(join(home, ".config", "systemd", "user", "agenc-daemon.service")),
    ).toBe(false);
  });

  test("unsupported architecture override is rejected before it can become a path component", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const env = {
      HOME: home,
      AGENC_HOME: join(home, ".agenc"),
      PATH: process.env.PATH ?? "",
      AGENC_INSTALL_PLATFORM: "linux",
      AGENC_INSTALL_ARCH: "riscv64",
    };
    const res = spawnSync(
      "sh",
      [INSTALL_SH, "--manifest-url", pathToFileURL(manifest).href, "--no-daemon"],
      { env, encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("unsupported Node.js architecture override: riscv64");
    expect(res.stderr).not.toContain("fetching release manifest");
  });

  test("default release repo is the PUBLIC releases repo", () => {
    // agenc-core is private: defaulting the manifest fetch to it 404s for
    // every stranger. The public binary repo is the only valid default.
    const sh = readFileSync(INSTALL_SH, "utf8");
    expect(sh).toContain('AGENC_INSTALL_REPO:-tetsuo-ai/agenc-releases}');
    expect(sh).not.toContain("agenc-core/releases");
    const ps1 = readFileSync(INSTALL_PS1, "utf8");
    expect(ps1).toContain('"tetsuo-ai/agenc-releases"');
    expect(ps1).not.toContain("agenc-core/releases");
  });

  test("standalone installers key native artifacts from the selected Node binary", () => {
    const sh = readFileSync(INSTALL_SH, "utf8");
    expect(sh).toContain("node -p 'process.platform'");
    expect(sh).toContain("node -p 'process.arch'");
    expect(sh).toContain("minimumGlibcVersion");
    expect(sh).toContain("${a.platform}-${a.arch}-${libc}-node-abi-${a.nodeModuleAbi}");
    expect(sh).not.toContain('case "$(uname -m)"');

    const ps1 = readFileSync(INSTALL_PS1, "utf8");
    expect(ps1).toContain("process.stdout.write(process.platform)");
    expect(ps1).toContain("process.stdout.write(process.arch)");
    expect(ps1).toContain('"win-$arch-native-node-abi-$nodeModuleAbi"');
    expect(ps1).not.toContain("PROCESSOR_ARCHITECTURE");
  });

  test("node version gate: refuses Node outside the supported 25.9 bridge", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    // Stub node reporting major version 20 for any invocation.
    const stubDir = join(work, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "node"), '#!/bin/sh\nprintf "20"\n');
    chmodSync(join(stubDir, "node"), 0o755);

    const res = runInstaller({
      home,
      manifest,
      args: ["--no-daemon"],
      pathPrepend: [stubDir],
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Node.js >=25.9 <26 required");
  });

  test("install.ps1 parses under pwsh (skipped when pwsh is absent)", () => {
    const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
    });
    if (pwsh.status !== 0) return; // pwsh not available on this machine
    const res = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `$null = [scriptblock]::Create((Get-Content -Raw '${INSTALL_PS1}')); 'parsed'`,
      ],
      { encoding: "utf8" },
    );
    expect(res.stdout).toContain("parsed");
    expect(res.status).toBe(0);
  });
});

test("standalone installers embed the exact same archive/install validator", () => {
  const shell = readFileSync(INSTALL_SH, "utf8").match(
    /<<'AGENC_RUNTIME_INSTALLER'[\s\S]*?\n(const \{ spawnSync \}[\s\S]*?)\nAGENC_RUNTIME_INSTALLER/,
  )?.[1];
  const powershell = readFileSync(INSTALL_PS1, "utf8").match(
    /\$RuntimeInstaller = @'\n([\s\S]*?)\n'@/,
  )?.[1];
  expect(shell).toBeTruthy();
  expect(powershell).toBe(shell);
  expect(shell).toContain("loadActivationLockIdentityModule()");
  expect(shell).toContain("resolveActivationLockRegistry()");
  expect(shell).not.toContain("function windowsAccountLockRegistry");
  expect(shell).not.toContain("/run/user/");
  expect(shell).not.toContain("process.env.LOCALAPPDATA");
});

test("official standalone paths pin gh and bind Sigstore verification to the source workflow", () => {
  const shell = readFileSync(INSTALL_SH, "utf8");
  const powershell = readFileSync(INSTALL_PS1, "utf8");
  const githubCli = JSON.parse(readFileSync(RELEASE_TOOLCHAIN, "utf8")).githubCli;
  for (const value of [
    "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60",
    "06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909",
    "4bd449df9ad639391bc62b8032546f0fe9edcd8526e06682a4f88abd8c5d163c",
    "f23a0c37d963aacc3bed703ccbd59b41c5ca22101fab7f00eb2b7cad23aba463",
  ]) expect(shell).toContain(value);
  expect(powershell).toContain(
    "c2d6acc935cd2f00e2144d7e036d5cd82e6b6bd5594e8c75aa75ef2a4ed6aac3",
  );
  expect(shell).toContain(githubCli.version);
  const expandedShellPins = shell.replaceAll("${GH_VERSION}", githubCli.version);
  for (const platform of ["linuxX64", "linuxArm64", "macosX64", "macosArm64"]) {
    expect(expandedShellPins).toContain(githubCli[platform].file);
    expect(shell).toContain(githubCli[platform].sha256);
  }
  expect(powershell).toContain(githubCli.version);
  expect(powershell.replaceAll("${ghVersion}", githubCli.version)).toContain(
    githubCli.windowsX64.file,
  );
  expect(powershell).toContain(githubCli.windowsX64.sha256);
  for (const installer of [shell, powershell]) {
    expect(installer).toContain("2.96.0");
    expect(installer).toContain(".sigstore.json");
    expect(installer).toContain("--repo");
    expect(installer).toContain("--signer-workflow");
    expect(installer).toContain("--source-digest");
    expect(installer).toContain("--signer-digest");
    expect(installer).toContain("--source-ref");
    expect(installer).toContain("--hostname");
    expect(installer).toContain("--cert-oidc-issuer");
    expect(installer).toContain("--predicate-type");
    expect(installer).toContain("--deny-self-hosted-runners");
    expect(installer).toContain("agenc-runtime-provenance/v1");
    expect(installer).toContain("attestationSha256");
  }
  expect(shell).toContain("GH_TELEMETRY=0");
  expect(shell).toContain("DO_NOT_TRACK=1");
  expect(shell).toContain("GH_SPINNER_DISABLED=1");
  expect(powershell).toContain('$env:GH_TELEMETRY = "0"');
  expect(powershell).toContain('$env:DO_NOT_TRACK = "1"');
  expect(powershell).toContain('$env:GH_SPINNER_DISABLED = "1"');
  expect(shell).not.toContain("command -v gh");
  expect(shell).toContain("file.nlink !== 1");
  expect(shell).toContain("(file.mode & 0o022) !== 0");
  expect(powershell).not.toContain("Get-Command gh");
});

describe.skipIf(spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status !== 0)(
  "install.ps1 behavior",
  () => {
    let work: string;
    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "agenc-install-ps-test-"));
    });
    afterEach(() => {
      removePersistentWrapperLocks(work);
      rmSync(work, { recursive: true, force: true });
    });

    function runPowerShell(
      home: string,
      manifest: string | undefined,
      agencHome = join(home, ".agenc"),
      envOverrides: Record<string, string> = {},
      installerPath = INSTALL_PS1,
    ): RunResult {
      if (existsSync(home)) chmodSync(home, 0o700);
      const temporary = join(home, "tmp");
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, "local-app-data"),
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
        AGENC_HOME: agencHome,
        AGENC_INSTALL_PREFIX: join(home, "prefix"),
        AGENC_INSTALL_MANIFEST_URL: manifest ?? "",
        AGENC_INSTALL_PLATFORM: "win32",
        AGENC_INSTALL_ARCH: "x64",
        ...envOverrides,
      };
      const result = spawnSync("pwsh", ["-NoProfile", "-File", installerPath], {
        env,
        encoding: "utf8",
      });
      return {
        status: result.status ?? -1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    }

    function windowsPaths(home: string, artifactSha = "") {
      const installDir = join(
        home,
        ".agenc",
        "runtime",
        VERSION,
        `win-x64-native-node-abi-${NODE_ABI}${artifactSha === "" ? "" : `-sha256-${artifactSha}`}`,
      );
      return {
        installDir,
        marker: join(installDir, ".agenc-runtime-ok"),
        bin: join(installDir, BIN_REL),
      };
    }

    test("PowerShell rejects a reparse temporary parent before child mutation", () => {
      const home = join(work, "reparse-parent-home");
      const agencHome = join(home, ".agenc");
      const target = join(work, "reparse-parent-target");
      const parentAlias = join(agencHome, ".installer-tmp");
      mkdirSync(agencHome, { recursive: true, mode: 0o700 });
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(target, "sentinel"), "preserve\n");
      symlinkSync(target, parentAlias, "dir");

      const result = runPowerShell(home, join(work, "must-not-be-read.json"));

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "private installer temporary parent is not a real",
      );
      expect(lstatSync(parentAlias).isSymbolicLink()).toBe(true);
      expect(readdirSync(target)).toEqual(["sentinel"]);
      expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("preserve\n");
    });

    test("PowerShell preserves a pre-existing private temporary parent", () => {
      const home = join(work, "existing-parent-home");
      const agencHome = join(home, ".agenc");
      const workParent = join(agencHome, ".installer-tmp");
      mkdirSync(workParent, { recursive: true, mode: 0o700 });
      const artifact = makeSyntheticArtifact(work);
      const manifest = writeManifest(work, artifact, {
        platform: "win",
        arch: "x64",
      });

      const result = runPowerShell(home, manifest);

      expect(result.status, result.stderr).toBe(0);
      expect(lstatSync(workParent).isDirectory()).toBe(true);
      expect(lstatSync(workParent).isSymbolicLink()).toBe(false);
      expect(readdirSync(workParent)).toEqual([]);
    });

    test("PowerShell restores caller Node environment controls after an installer failure", () => {
      const home = join(work, "environment-restore-home");
      mkdirSync(home, { recursive: true });
      const wrapper = join(work, "environment-restore.ps1");
      writeFileSync(
        wrapper,
        [
          "$ErrorActionPreference = 'Stop'",
          "$env:NODE_OPTIONS = '--trace-warnings'",
          "$env:NODE_PATH = 'agenc-node-path-sentinel'",
          "$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'",
          "$env:NODE_USE_ENV_PROXY = 'agenc-proxy-sentinel'",
          "$env:AGENC_HOME = 'relative-home-must-fail'",
          `try { . '${INSTALL_PS1.replaceAll("'", "''")}' } catch { }`,
          "$result = [ordered]@{",
          "  NODE_OPTIONS = $env:NODE_OPTIONS",
          "  NODE_PATH = $env:NODE_PATH",
          "  NODE_TLS_REJECT_UNAUTHORIZED = $env:NODE_TLS_REJECT_UNAUTHORIZED",
          "  NODE_USE_ENV_PROXY = $env:NODE_USE_ENV_PROXY",
          "}",
          "Write-Output ('AGENC_ENV_AFTER=' + ($result | ConvertTo-Json -Compress))",
          "",
        ].join("\n"),
      );
      const temporary = join(home, "tmp");
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      const result = spawnSync("pwsh", ["-NoProfile", "-File", wrapper], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, "local-app-data"),
          TMPDIR: temporary,
          TEMP: temporary,
          TMP: temporary,
          AGENC_INSTALL_PREFIX: join(home, "prefix"),
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const record = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("AGENC_ENV_AFTER="));
      expect(record).toBeTruthy();
      expect(JSON.parse(record!.slice("AGENC_ENV_AFTER=".length))).toEqual({
        NODE_OPTIONS: "--trace-warnings",
        NODE_PATH: "agenc-node-path-sentinel",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NODE_USE_ENV_PROXY: "agenc-proxy-sentinel",
      });
    });

    test("PowerShell restores caller Node environment controls after a successful iex-style install", () => {
      const home = join(work, "environment-restore-success-home");
      mkdirSync(home, { recursive: true });
      chmodSync(home, 0o700);
      const artifact = makeSyntheticArtifact(work);
      const manifest = writeManifest(work, artifact, {
        platform: "win",
        arch: "x64",
      });
      const wrapper = join(work, "environment-restore-success.ps1");
      writeFileSync(
        wrapper,
        [
          "$ErrorActionPreference = 'Stop'",
          "$env:NODE_OPTIONS = '--trace-warnings'",
          "$env:NODE_PATH = 'agenc-node-path-sentinel'",
          "$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'",
          "$env:NODE_USE_ENV_PROXY = 'agenc-proxy-sentinel'",
          `. '${INSTALL_PS1.replaceAll("'", "''")}'`,
          "$result = [ordered]@{",
          "  NODE_OPTIONS = $env:NODE_OPTIONS",
          "  NODE_PATH = $env:NODE_PATH",
          "  NODE_TLS_REJECT_UNAUTHORIZED = $env:NODE_TLS_REJECT_UNAUTHORIZED",
          "  NODE_USE_ENV_PROXY = $env:NODE_USE_ENV_PROXY",
          "}",
          "Write-Output ('AGENC_ENV_AFTER=' + ($result | ConvertTo-Json -Compress))",
          "",
        ].join("\n"),
      );
      const temporary = join(home, "tmp");
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      const result = spawnSync("pwsh", ["-NoProfile", "-File", wrapper], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, "local-app-data"),
          TMPDIR: temporary,
          TEMP: temporary,
          TMP: temporary,
          AGENC_HOME: join(home, ".agenc"),
          AGENC_INSTALL_PREFIX: join(home, "prefix"),
          AGENC_INSTALL_MANIFEST_URL: manifest,
          AGENC_INSTALL_PLATFORM: "win32",
          AGENC_INSTALL_ARCH: "x64",
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const record = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("AGENC_ENV_AFTER="));
      expect(record).toBeTruthy();
      expect(JSON.parse(record!.slice("AGENC_ENV_AFTER=".length))).toEqual({
        NODE_OPTIONS: "--trace-warnings",
        NODE_PATH: "agenc-node-path-sentinel",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NODE_USE_ENV_PROXY: "agenc-proxy-sentinel",
      });
      expect(existsSync(windowsPaths(home, artifact.sha).marker)).toBe(true);
    });

    test("fresh and idempotent PowerShell installs use the complete-tree marker contract", () => {
      const home = join(work, "home");
      mkdirSync(home, { recursive: true });
      const artifact = makeSyntheticArtifact(work);
      const manifest = writeManifest(work, artifact, {
        platform: "win",
        arch: "x64",
      });
      const first = runPowerShell(home, manifest);
      expect(first.status, first.stderr).toBe(0);
      const paths = windowsPaths(home, artifact.sha);
      expect(readFileSync(paths.marker, "utf8")).toBe(artifact.sha);
      expect(readFileSync(paths.bin, "utf8")).toContain("console.log");
      const homeIdentity = statSync(join(home, ".agenc"), { bigint: true });
      expect(existsSync(resolve(`${homeIdentity.dev}:${homeIdentity.ino}`))).toBe(false);
      expect(existsSync(join(home, ".agenc", "runtime", ".activation-lock.sqlite"))).toBe(true);

      const backup = `${paths.installDir}.old-crash`;
      renameSync(paths.installDir, backup);
      rmSync(artifact.tarball);
      const second = runPowerShell(home, manifest);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("already installed");
      expect(existsSync(backup)).toBe(false);
    });

    test("PowerShell rejects relative AGENC_HOME before resolving the manifest install path", () => {
      const home = join(work, "home");
      mkdirSync(home, { recursive: true });
      const artifact = makeSyntheticArtifact(work);
      const manifest = writeManifest(work, artifact, {
        platform: "win",
        arch: "x64",
      });

      const result = runPowerShell(home, manifest, "relative-home");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("AGENC_HOME must be an absolute path");
      expect(result.stdout).not.toContain("fetching release manifest");
    });

    test("PowerShell repo-derived manifests bind releaseRepository", () => {
      const home = join(work, "repo-derived-home");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const artifact = makeSyntheticArtifact(work);
      const manifest = remoteManifest(artifact, "win", "unused");
      const fixture = startHttpsFixture(work, {
        "/manifest": { bodyText: JSON.stringify(manifest) },
      });
      const rewrite = writeGithubArtifactFetchRewrite(work);
      try {
        const result = runPowerShell(home, undefined, join(home, ".agenc"), {
          AGENC_INSTALL_REPO: "requested/repository",
          NODE_EXTRA_CA_CERTS: fixture.ca,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${rewrite}`.trim(),
          AGENC_INSTALL_TEST_GITHUB_MANIFEST_URL: `${fixture.baseUrl}/manifest`,
        }, writeInstrumentedInstallPs1(work));
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toContain("releaseRepository test/mirror");
        expect(output).toContain("does not match requested requested/repository");
        expectFailedInstallCleanup(home);
      } finally {
        fixture.stop();
      }
    });

    test("PowerShell bounded fetch aborts a stalled response on its total deadline", () => {
      const home = join(work, "deadline-home");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const fixture = startHttpsFixture(work, {
        "/stall": { bodyText: "{}", contentLength: 32, stallBody: true },
      });
      try {
        const started = Date.now();
        const result = runPowerShell(home, `${fixture.baseUrl}/stall`, join(home, ".agenc"), {
          NODE_EXTRA_CA_CERTS: fixture.ca,
          AGENC_INSTALL_TEST_DOWNLOAD_TIMEOUT_MS: "150",
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toContain("download deadline exceeded after 150ms");
        expect(Date.now() - started).toBeLessThan(5_000);
        expectFailedInstallCleanup(home);
      } finally {
        fixture.stop();
      }
    });

    test("PowerShell local reads reject a path swap between lstat and descriptor open", () => {
      const home = join(work, "swap-home");
      const replacementDir = join(work, "swap-replacement");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mkdirSync(replacementDir);
      const artifact = makeSyntheticArtifact(work);
      const replacement = makeSyntheticArtifact(replacementDir);
      const manifest = writeManifest(work, artifact, { platform: "win", arch: "x64" });
      const preload = writeLocalSwapPreload(work);
      const result = runPowerShell(home, manifest, join(home, ".agenc"), {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim(),
        AGENC_INSTALL_TEST_SWAP_TARGET: artifact.tarball,
        AGENC_INSTALL_TEST_SWAP_BACKUP: `${artifact.tarball}.before-swap`,
        AGENC_INSTALL_TEST_SWAP_REPLACEMENT: replacement.tarball,
      }, writeInstrumentedInstallPs1(work));
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("local resource changed while it was opened");
      expectFailedInstallCleanup(home);
    });

    test("PowerShell rejects ambiguous and Windows-special local artifact URLs", () => {
      const home = join(work, "home");
      mkdirSync(home, { recursive: true });
      const artifact = makeSyntheticArtifact(work);
      const manifestPath = writeManifest(work, artifact, {
        platform: "win",
        arch: "x64",
      });
      const invalidUrls = [
        `file://localhost${new URL(pathToFileURL(artifact.tarball).href).pathname}`,
        "file:////server/share/runtime.tar.gz",
        "file:///%5C%5C%3F%5CC:%5Cruntime.tar.gz",
        "file:///C:runtime.tar.gz",
      ];
      for (const [index, url] of invalidUrls.entries()) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.artifacts[0].url = url;
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const result = runPowerShell(home, manifestPath);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status, `${index}: ${output}`).not.toBe(0);
        expect(output).toMatch(
          /local artifact URL|manifest artifact URL is invalid/,
        );
      }
    });

    test("PowerShell rejects Windows ADS paths before invoking tar", () => {
      const home = join(work, "home");
      mkdirSync(home, { recursive: true });
      const artifact = makeRawTarArtifact(work, [
        { name: "node_modules/", type: "5" },
        { name: "node_modules/pkg/file:stream", body: "owned" },
      ]);
      const manifest = writeManifest(work, artifact, {
        platform: "win",
        arch: "x64",
      });
      const result = runPowerShell(home, manifest);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("unsafe runtime archive path for win");
      expect(existsSync(windowsPaths(home).installDir)).toBe(false);
    });

    test("PowerShell bounded HTTPS trust rejects malformed manifests and truncated/overrun artifacts without residue", () => {
      const artifact = makeSyntheticArtifact(work);
      const fixture = startHttpsFixture(work, trustBoundaryRoutes(artifact, "win"));
      const fetchRewrite = writeGithubArtifactFetchRewrite(work);
      try {
        const cases = [
          ["oversized-manifest.json", "download exceeds 1048576 byte limit"],
          ["manifest-length.json", "Content-Length exceeds 1048576 byte limit"],
          ["invalid-utf8.json", "runtime manifest is not valid UTF-8"],
          ["short-manifest.json", "download byte count mismatch"],
          ["overrun-manifest.json", "download exceeds declared"],
          ["length-manifest.json", "Content-Length mismatch"],
          ["duplicate-manifest.json", "duplicate runtime manifest artifact"],
          ["missing-tag-manifest.json", "runtime manifest release identity is invalid"],
          ["missing-provenance-manifest.json", "runtime manifest build provenance is invalid"],
          ["detached-artifact-manifest.json", "manifest artifact URL is not canonical"],
          ["cross-scheme-manifest.json", "remote manifests may only reference HTTPS artifacts"],
          ["artifact-ceiling-manifest.json", "manifest artifact identity is invalid"],
        ] as const;
        for (const [name, expected] of cases) {
          const home = join(work, `powershell-${name}`);
          mkdirSync(home, { recursive: true, mode: 0o700 });
          const result = runPowerShell(
            home,
            `${fixture.baseUrl}/${name}`,
            join(home, ".agenc"),
            {
              NODE_EXTRA_CA_CERTS: fixture.ca,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${fetchRewrite}`.trim(),
              AGENC_INSTALL_TEST_GITHUB_ARTIFACT_URL:
                trustArtifactRoute(name) === undefined
                  ? ""
                  : `${fixture.baseUrl}${trustArtifactRoute(name)}`,
            },
            writeInstrumentedInstallPs1(work),
          );
          const output = `${result.stdout}\n${result.stderr}`;
          expect(result.status, `${name}: ${output}`).not.toBe(0);
          expect(output, name).toContain(expected);
          expectFailedInstallCleanup(home);
        }
      } finally {
        fixture.stop();
      }
    }, 30_000);

    test("PowerShell preserves a custom CMD shim containing only the historical marker", () => {
      const home = join(work, "home");
      const wrapperDir = join(home, "prefix", "bin");
      mkdirSync(wrapperDir, { recursive: true, mode: 0o700 });
      for (const path of [home, join(home, "prefix"), wrapperDir]) chmodSync(path, 0o700);
      const wrapper = join(wrapperDir, "agenc.cmd");
      const custom = [
        "@echo off",
        "rem Generated by AgenC install.ps1 - rewritten on every install/upgrade.",
        "echo user-owned-wrapper",
        "",
      ].join("\r\n");
      writeFileSync(wrapper, custom, { mode: 0o644 });
      chmodSync(wrapper, 0o644);
      const artifact = makeSyntheticArtifact(work);
      const manifest = writeManifest(work, artifact, {
        platform: "win",
        arch: "x64",
      });

      const result = runPowerShell(home, manifest);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`)
        .toContain("refusing to replace a wrapper not generated by AgenC");
      expect(readFileSync(wrapper, "utf8")).toBe(custom);
    });
  },
);
