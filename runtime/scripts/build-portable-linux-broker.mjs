import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Native x64 Debian bullseye buildpack-deps, Node 26.5.0 and GCC 10.
// Never pull implicitly or accept an image override from the environment.
export const portableBrokerImage = "node@sha256:42ba460c07a41a9d140eba352dd24658522bd2a060e6544b7f5dfcace92097ad";

export function portableBrokerDockerArgs(runtimeRoot, outputRoot) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Portable broker builder currently requires native Linux x64; release builds retain their glibc 2.28 multi-architecture toolchain");
  const bind = (source, destination, readonly) => ["--mount", `type=bind,source=${source},target=${destination}${readonly ? ",readonly" : ""}`];
  for (const path of [runtimeRoot, outputRoot]) {
    if (path.includes(",")) throw new Error("Docker bind paths cannot contain commas");
  }
  return ["run", "--rm", "--init", "--pull=never", "--network=none", "--read-only",
    "--user", `${process.getuid()}:${process.getgid()}`, "--cpus=2", "--memory=1g", "--pids-limit=128",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,exec,mode=1777", "--env", "CC=/usr/bin/cc",
    "--env", "LANG=C", "--env", "LC_ALL=C",
    ...bind(resolve(runtimeRoot, "native"), "/source/native", true),
    ...bind(resolve(runtimeRoot, "scripts/build-linux-process-broker.mjs"), "/source/build-linux-process-broker.mjs", true),
    ...bind(resolve(runtimeRoot, "scripts/linux-broker-elf.mjs"), "/source/linux-broker-elf.mjs", true),
    ...bind(outputRoot, "/out", false), portableBrokerImage,
    "node", "/source/build-linux-process-broker.mjs", "/source", "/out", "2.31"];
}

export function buildPortableLinuxBroker(runtimeRoot) {
  runtimeRoot = resolve(runtimeRoot);
  const dist = resolve(runtimeRoot, "dist");
  mkdirSync(dist, { recursive: true });
  const temporary = mkdtempSync(resolve(dist, ".portable-broker-build-"));
  try {
    const result = spawnSync("docker", portableBrokerDockerArgs(runtimeRoot, temporary), { encoding: "utf8", timeout: 120_000 });
    if (result.error || result.status !== 0) throw new Error(`Portable Linux broker build failed. Preload ${portableBrokerImage} and ensure Docker is available. ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
    const receipt = JSON.parse(readFileSync(resolve(temporary, "linux-broker-build.json"), "utf8"));
    writeFileSync(resolve(temporary, "linux-broker-build.json"), JSON.stringify({ ...receipt, builderImage: portableBrokerImage }, null, 2) + "\n", { mode: 0o644 });
    // Install only after the complete build, GLIBC ceiling and hardening checks.
    for (const name of ["agenc-session-sandbox", "agenc-namespace-init-entry", "agenc-process-broker", "linux-broker-build.json"]) {
      renameSync(resolve(temporary, name), resolve(dist, name));
    }
    return { ...receipt, builderImage: portableBrokerImage };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtimeRoot = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  console.log(JSON.stringify(buildPortableLinuxBroker(runtimeRoot)));
}
