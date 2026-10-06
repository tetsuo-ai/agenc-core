import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build, type BuildOptions } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import runtimeBuildConfig from "../../build.config.js";

const runtimeRoot = resolve(import.meta.dirname, "../..");
const payload = "pipe-output-".repeat(50_000);
let fixtureRoot: string;
let entry: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "agenc-cli-pipe-"));
  entry = join(fixtureRoot, "bin", "agenc.mjs");
  await mkdir(join(fixtureRoot, "bin"));
  await symlink(resolve(runtimeRoot, "../node_modules"), join(fixtureRoot, "node_modules"));
  await cp(
    join(runtimeRoot, "src/utils/permissions/yolo-classifier-prompts"),
    join(fixtureRoot, "yolo-classifier-prompts"),
    { recursive: true },
  );
  // This fixture excludes the asset plugin, so stage its runtime data alongside
  // the emitted chunks just as the packaged build does.
  for (const name of ["openrouter-models.data.json", "openrouter-pricing.data.json"]) {
    await cp(join(runtimeRoot, "src/llm/registry", name), join(fixtureRoot, name));
  }
  const options: BuildOptions = {};
  runtimeBuildConfig.esbuildOptions(options);
  await build({
    ...options,
    absWorkingDir: runtimeRoot,
    entryPoints: [join(runtimeRoot, "src/bin/agenc.ts")],
    outdir: fixtureRoot,
    outbase: join(runtimeRoot, "src"),
    outExtension: { ".js": ".mjs" },
    splitting: true,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    logLevel: "silent",
    external: [...runtimeBuildConfig.external, "@tetsuo-ai/agenc-sdk"],
    plugins: [
      {
        name: "cli-pipe-test-daemon",
        setup(builder) {
          builder.onResolve({ filter: /app-server\/agent-cli\.js$/ }, (args) => {
            if (!args.importer.endsWith("/bin/run-cli.ts")) return;
            return { path: "test-daemon", namespace: "cli-pipe-test" };
          });
          builder.onLoad({ filter: /.*/, namespace: "cli-pipe-test" }, () => ({
            contents: `
              export const defaultEnsureDaemonReady = () => async () => {};
              export const createAgenCJsonLineDaemonRequestClient = () => ({
                request: async (_method, params) => {
                  const payload = ${JSON.stringify(payload)};
                  if (params.runId === "wf-error") throw new Error(payload);
                  return { runId: params.runId, payload };
                },
              });
            `,
            loader: "js",
          }));
        },
      },
      ...runtimeBuildConfig.esbuildPlugins.filter((plugin) => plugin.name !== "agenc-runtime-assets"),
    ],
  });
}, 30_000);

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe("CLI output before process exit", () => {
  it.each(["replay", "evidence", "result"])("preserves large run %s JSON through a pipe", (action) => {
    const child = spawnSync(process.execPath, [entry, "run", action, "wf-large"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", AGENC_HOME: join(fixtureRoot, "home"), AGENC_CLI_ENTRY_DISABLE: "0" },
      maxBuffer: 2_000_000,
      timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const expected = JSON.stringify({ runId: "wf-large", payload }, null, 2) + "\n";
    expect(child.stdout.length).toBe(expected.length);
    expect(child.stdout).toBe(expected);
    expect(JSON.parse(child.stdout).payload).toBe(payload);
  });

  it("preserves a large error on stderr and exits unsuccessfully", () => {
    const child = spawnSync(process.execPath, [entry, "run", "result", "wf-error"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", AGENC_HOME: join(fixtureRoot, "home"), AGENC_CLI_ENTRY_DISABLE: "0" },
      maxBuffer: 2_000_000,
      timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr.length).toBe(`agenc: ${payload}\n`.length);
    expect(child.stderr).toBe(`agenc: ${payload}\n`);
    expect(child.stdout).toBe("");
  });
});
