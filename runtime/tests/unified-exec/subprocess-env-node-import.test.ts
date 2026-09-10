import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it("loads subprocess temp authority in plain Node without bundled feature shims", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module", "--eval",
    `import { register } from 'tsx/esm/api';
     register({ tsconfig: false });
     const { registerBenchmarkModuleCompatibility } = await import('./benchmarks/fnd/module-compatibility.mjs');
     registerBenchmarkModuleCompatibility();
     const { withChildTempAuthority } = await import('./src/utils/subprocessEnv.ts');
     process.stdout.write(JSON.stringify(withChildTempAuthority({}, process.cwd())));`,
  ], {
    cwd: runtimeRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const environment = JSON.parse(result.stdout) as Record<string, string>;
  expect(environment.AGENC_TMPDIR).toBe(runtimeRoot);
  expect(environment.TMPPREFIX).toMatch(/\/zsh$/u);
});
