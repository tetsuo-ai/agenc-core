import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const DOTTED_VERSION = /^\d+\.\d+(?:\.\d+)?$/;

export function compareDottedVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function maximumSymbolVersion(path, namespace) {
  const bytes = readFileSync(path).toString("latin1");
  const pattern = new RegExp(`\\b${namespace}_(\\d+\\.\\d+(?:\\.\\d+)?)\\b`, "g");
  let maximum;
  for (const match of bytes.matchAll(pattern)) {
    if (maximum === undefined || compareDottedVersions(match[1], maximum) > 0) {
      maximum = match[1];
    }
  }
  return maximum;
}

export function currentRuntimeCompatibility({
  platform = process.platform,
  arch = process.arch,
  nodeMajor = Number(process.versions.node.split(".")[0]),
  nodeModuleAbi = process.versions.modules,
  report = process.report?.getReport(),
} = {}) {
  const base = { platform: platform === "win32" ? "win" : platform, arch, nodeMajor, nodeModuleAbi };
  if (base.platform === "darwin") {
    const result = spawnSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
    });
    return {
      ...base,
      ...(result.status === 0 ? { macosVersion: result.stdout.trim() } : {}),
    };
  }
  if (base.platform !== "linux") return base;
  const glibcVersion = report?.header?.glibcVersionRuntime;
  const libstdcxx = report?.sharedObjects?.find(
    (path) => basename(path).startsWith("libstdc++.so.6"),
  );
  if (typeof glibcVersion !== "string" || !DOTTED_VERSION.test(glibcVersion)) {
    return { ...base, libcFamily: "unknown" };
  }
  if (typeof libstdcxx !== "string") {
    return { ...base, libcFamily: "glibc", glibcVersion };
  }
  return {
    ...base,
    libcFamily: "glibc",
    glibcVersion,
    glibcxxVersion: maximumSymbolVersion(libstdcxx, "GLIBCXX"),
    cxxAbiVersion: maximumSymbolVersion(libstdcxx, "CXXABI"),
  };
}

function requireDotted(value, label) {
  if (typeof value !== "string" || !DOTTED_VERSION.test(value)) {
    throw new Error(`agenc: runtime artifact has invalid ${label}`);
  }
  return value;
}

export function assertArtifactCompatible(artifact, runtime) {
  if (artifact.nodeMajor !== runtime.nodeMajor) {
    throw new Error(
      `agenc: runtime artifact requires Node ${artifact.nodeMajor}.x; current Node is ${runtime.nodeMajor}.x`,
    );
  }
  if (artifact.nodeModuleAbi !== runtime.nodeModuleAbi) {
    throw new Error(
      `agenc: runtime artifact requires native ABI ${artifact.nodeModuleAbi}; current ABI is ${runtime.nodeModuleAbi}`,
    );
  }
  if (runtime.platform === "darwin") {
    const minimum = requireDotted(
      artifact.minimumMacosVersion,
      "minimum macOS version",
    );
    if (
      typeof runtime.macosVersion !== "string" ||
      !DOTTED_VERSION.test(runtime.macosVersion)
    ) {
      throw new Error("agenc: could not determine host macOS compatibility");
    }
    if (compareDottedVersions(runtime.macosVersion, minimum) < 0) {
      throw new Error(
        `agenc: runtime requires macOS ${minimum} or newer; host provides ${runtime.macosVersion}`,
      );
    }
    return artifact;
  }
  if (runtime.platform !== "linux") return artifact;
  if (artifact.libcFamily !== "glibc") {
    throw new Error("agenc: Linux runtime artifact does not declare the required glibc family");
  }
  if (runtime.libcFamily !== "glibc") {
    throw new Error("agenc: Linux runtime requires glibc; musl/unknown libc is unsupported");
  }
  const requirements = [
    [requireDotted(artifact.minimumGlibcVersion, "minimum glibc version"), runtime.glibcVersion, "glibc"],
    [requireDotted(artifact.minimumGlibcxxVersion, "minimum GLIBCXX version"), runtime.glibcxxVersion, "GLIBCXX"],
    [requireDotted(artifact.minimumCxxAbiVersion, "minimum CXXABI version"), runtime.cxxAbiVersion, "CXXABI"],
  ];
  for (const [minimum, current, label] of requirements) {
    if (typeof current !== "string" || !DOTTED_VERSION.test(current)) {
      throw new Error(`agenc: could not determine host ${label} compatibility`);
    }
    if (compareDottedVersions(current, minimum) < 0) {
      throw new Error(
        `agenc: Linux runtime requires ${label} ${minimum} or newer; host provides ${current}`,
      );
    }
  }
  return artifact;
}

export function runtimeArtifactKey(artifact) {
  const platform = artifact?.platform;
  const arch = artifact?.arch;
  const abi = artifact?.nodeModuleAbi;
  if (!/^(linux|darwin|win)$/.test(platform ?? "")) {
    throw new Error(`agenc: invalid runtime platform ${platform ?? "missing"}`);
  }
  if (!/^(x64|arm64)$/.test(arch ?? "") || !/^\d+$/.test(abi ?? "")) {
    throw new Error("agenc: invalid runtime architecture or native module ABI");
  }
  const libc = platform === "linux"
    ? artifact.libcFamily === "glibc" ? "glibc" : "unknown-libc"
    : "native";
  return `${platform}-${arch}-${libc}-node-abi-${abi}`;
}
