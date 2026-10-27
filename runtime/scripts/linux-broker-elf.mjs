import { execFileSync } from "node:child_process";

function compareVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); ++i) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

export function assertLinuxBrokerElf(output, maximumGlibc) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(maximumGlibc)) throw new Error("Invalid GLIBC ceiling");
  const needs = output.indexOf("Version needs section");
  const versions = needs < 0 ? [] : [...output.slice(needs).matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b/g)].map(match => match[1]);
  if (versions.length === 0) throw new Error("Broker has no inspectable GLIBC requirements");
  const minimumGlibc = versions.reduce((a, b) => compareVersions(a, b) > 0 ? a : b);
  if (compareVersions(minimumGlibc, maximumGlibc) > 0) {
    throw new Error(`Broker needs GLIBC ${minimumGlibc}, above portable ceiling ${maximumGlibc}`);
  }
  if (!/Type:\s+DYN\b/.test(output) || !/\(FLAGS_1\)[^\n]*\bPIE\b/.test(output)) throw new Error("Broker must be PIE");
  if (!/GNU_RELRO/.test(output) || !/\bBIND_NOW\b/.test(output)) throw new Error("Broker must have full RELRO");
  if (!/GNU_STACK[^\n]*\bRW\b/.test(output) || /GNU_STACK[^\n]*\bRWE\b/.test(output)) throw new Error("Broker stack must be non-executable");
  if (!/\b__stack_chk_fail\b/.test(output)) throw new Error("Broker must retain stack protection");
  return { minimumGlibc, maximumGlibc, pie: true, fullRelro: true, nxStack: true, stackProtection: true };
}

export function inspectLinuxBroker(path, maximumGlibc) {
  const output = execFileSync("readelf", ["--wide", "--file-header", "--program-headers", "--dynamic", "--dyn-syms", "--version-info", path],
    { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" }, timeout: 10_000 });
  return assertLinuxBrokerElf(output, maximumGlibc);
}
