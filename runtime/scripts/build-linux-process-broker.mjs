import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { inspectLinuxBroker } from "./linux-broker-elf.mjs";

export function buildLinuxProcessBroker(runtimeRoot, outputRoot = resolve(runtimeRoot, "dist"), compiler = process.env.CC?.trim() || "cc", compilerArgs = []) {
  if (process.platform !== 'linux') return;
  mkdirSync(outputRoot, { recursive: true });
  const processBrokerSource = resolve(runtimeRoot, "native/agenc-process-broker.c");
  const processBrokerDist = resolve(outputRoot, "agenc-process-broker");
  const temporary = mkdtempSync(resolve(outputRoot, '.namespace-init-build-'));
  try {
    // Older libc headers can omit SYS_close_range while the kernel supports it.
    // Preserve an existing definition, prefer the kernel's __NR alias, and use
    // the stable Linux UAPI number only on the supported native 64-bit ABIs.
    const syscallHeader = resolve(temporary, 'syscall-compat.h');
    writeFileSync(syscallHeader, `#include <sys/syscall.h>
#ifndef SYS_close_range
#ifdef __NR_close_range
#define SYS_close_range __NR_close_range
#elif (defined(__x86_64__) && !defined(__ILP32__)) || defined(__aarch64__)
#define SYS_close_range 436
#else
#error "SYS_close_range is unavailable for this build architecture"
#endif
#endif
`);
    const compatibilityArgs = [...compilerArgs, '-include', syscallHeader];
    const sessionBuild = spawnSync(compiler, [
      ...compatibilityArgs,
      '-Os', '-static', '-std=c11', '-Wall', '-Wextra', '-Werror',
      '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-Wl,-z,relro,-z,now',
      '-o', resolve(outputRoot, 'agenc-session-sandbox'),
      resolve(runtimeRoot, 'native/agenc-session-sandbox.c'),
    ], { encoding: 'utf8' });
    if (sessionBuild.error || sessionBuild.status !== 0)
      throw new Error('Session sandbox build failed: ' + sessionBuild.stderr);
    chmodSync(resolve(outputRoot, 'agenc-session-sandbox'), 0o755);
    const helper = resolve(temporary, 'namespace-init');
    const staticBuild = spawnSync(compiler, [
      ...compatibilityArgs,
      '-Os', '-static', '-std=c11', '-Wall', '-Wextra', '-Werror',
      '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-Wl,-z,relro,-z,now',
      '-o', helper, resolve(runtimeRoot, 'native/agenc-namespace-init.c'),
    ], { cwd: runtimeRoot, env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8' });
    if (staticBuild.error !== undefined || staticBuild.status !== 0) {
      throw new Error('Static Linux namespace-init build failed' +
        (staticBuild.error === undefined ? '' : `: ${staticBuild.error.message}`) +
        (staticBuild.stderr ? `\n${staticBuild.stderr.trim()}` : ''));
    }
    const image = readFileSync(helper);
    if (image.length < 64 || image.length > 2 * 1024 * 1024 ||
        image.subarray(0, 6).toString('hex') !== '7f454c460201' ||
        image.readUInt16LE(54) !== 56) {
      throw new Error('Namespace init must be a bounded, static little-endian ELF64 image');
    }
    const programOffset = image.readBigUInt64LE(32);
    const programCount = image.readUInt16LE(56);
    if (programCount < 1 || programCount > 128 ||
        programOffset + BigInt(programCount * 56) > BigInt(image.length)) {
      throw new Error('Invalid namespace-init ELF program table');
    }
    for (let i = 0; i < programCount; ++i) {
      if (image.readUInt32LE(Number(programOffset) + i * 56) === 3) {
        throw new Error('Namespace init must not contain a dynamic interpreter');
      }
    }
    const header = resolve(temporary, 'namespace-init-image.h');
    writeFileSync(header, 'static const unsigned char agenc_namespace_init_image[] = {\n' +
      Array.from(image, byte => String(byte)).join(',') + '\n};\n');
    const result = spawnSync(
      compiler,
      [
        ...compatibilityArgs,
        '-O2',
        '-fPIE',
        '-pie',
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-D_FORTIFY_SOURCE=2',
        '-fstack-protector-strong',
        '-Wl,-z,relro,-z,now',
        `-DAGENC_NAMESPACE_INIT_IMAGE_HEADER=${JSON.stringify(header)}`,
        '-o',
        processBrokerDist,
        processBrokerSource,
      ],
      {
        cwd: runtimeRoot,
        env: {
          ...process.env,
          LANG: 'C',
          LC_ALL: 'C',
        },
        encoding: 'utf8',
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        'Linux process-broker build failed' +
          (result.error === undefined ? '' : `: ${result.error.message}`) +
          (result.stderr ? `\n${result.stderr.trim()}` : ''),
      );
    }
    chmodSync(processBrokerDist, 0o755);
    writeFileSync(resolve(outputRoot, 'agenc-namespace-init-entry'),
      'AGENC_NAMESPACE_INIT_ENTRY_V1\n', { mode: 0o644 });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtimeRoot = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const outputRoot = resolve(process.argv[3] ?? resolve(runtimeRoot, "dist"));
  buildLinuxProcessBroker(runtimeRoot, outputRoot);
  const maximumGlibc = process.argv[4];
  if (maximumGlibc !== undefined) {
    const elf = inspectLinuxBroker(resolve(outputRoot, "agenc-process-broker"), maximumGlibc);
    const libc = spawnSync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8" });
    if (libc.status !== 0 || libc.stdout.trim() !== `glibc ${maximumGlibc}`) throw new Error("Unexpected portable builder libc");
    const compiler = spawnSync(process.env.CC?.trim() || "cc", ["--version"], { encoding: "utf8" });
    if (compiler.status !== 0) throw new Error("Cannot inventory portable compiler");
    const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
    const sources = ["agenc-process-broker.c", "agenc-namespace-init.c", "agenc-session-sandbox.c"];
    const artifacts = ["agenc-process-broker", "agenc-session-sandbox", "agenc-namespace-init-entry"];
    const receipt = { ...elf, buildGlibc: libc.stdout.trim(), architecture: process.arch,
      compiler: compiler.stdout.split("\n")[0],
      sourceSha256: Object.fromEntries(sources.map(name => [name, hash(resolve(runtimeRoot, "native", name))])),
      artifactSha256: Object.fromEntries(artifacts.map(name => [name, hash(resolve(outputRoot, name))])) };
    writeFileSync(resolve(outputRoot, "linux-broker-build.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o644 });
  }
}

