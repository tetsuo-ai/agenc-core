import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DockerContainerRunner } from "../../src/eval-executor/container-runner.js";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";

const workspaces = createTempWorkspaceFixture("agenc-eval-literal-env-");
const handle = { id: "test-container", imageDigest: "test-image", workdir: "/testbed" };

describe.runIf(process.platform !== "win32")("literal container environment", () => {
  let root: string;
  let argvLog: string;

  beforeEach(async () => {
    root = await workspaces.create();
    argvLog = path.join(root, "argv.json");
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "docker"), [
      `#!${process.execPath}`,
      'const { writeFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      'const args = process.argv.slice(2);',
      `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));`,
      'const env = { PATH: process.env.PATH };',
      'for (let index = 1; index < args.indexOf("bash"); index++) {',
      '  if (args[index] === "-e") { const name = args[++index]; env[name] = process.env[name]; }',
      '}',
      'const result = spawnSync("bash", args.slice(args.indexOf("bash") + 1), { env, encoding: "utf8" });',
      'process.stdout.write(result.stdout ?? "");',
      'process.stderr.write(result.stderr ?? "");',
      'process.exit(result.status ?? 1);',
    ].join("\n"), { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await workspaces.cleanup();
  });

  test.each([
    "https://api.example.invalid/v1?api-version=2026-09&value=a+b%20c",
    "https://api.example.invalid/$(true)",
    "https://api.example.invalid/`true`",
    "https://api.example.invalid/'\";printf injected>&2\nnext",
  ])("delivers %j as a literal value through a real shell", async (baseUrl) => {
    const runner = new DockerContainerRunner();
    const request = {
      script: 'printf "%s" "$OPENAI_COMPATIBLE_BASE_URL"',
      env: { OPENAI_COMPATIBLE_BASE_URL: baseUrl },
    };
    const result = await runner.exec(handle, request);
    expect(result).toMatchObject({ exitCode: 0, stdout: baseUrl, stderr: "", timedOut: false });
    const args: string[] = JSON.parse(await readFile(argvLog, "utf8"));
    expect(args).toContain("OPENAI_COMPATIBLE_BASE_URL");
    expect(args).not.toContain(baseUrl);
    expect(args.join(" ")).not.toContain("OPENAI_COMPATIBLE_BASE_URL=");
  });

  test("isolates concurrent values and retains secret name-only passthrough", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "unchanged-host-value");
    vi.stubEnv("AGENC_TEST_PROVIDER_KEY", "test-only-secret-1234567890");
    const runner = new DockerContainerRunner();
    const results = await Promise.all(["first", "second"].map((value) => runner.exec(handle, {
      script: 'printf "%s:%s" "$OPENAI_COMPATIBLE_BASE_URL" "$AGENC_TEST_PROVIDER_KEY"',
      env: { OPENAI_COMPATIBLE_BASE_URL: value },
      envPassthrough: ["AGENC_TEST_PROVIDER_KEY"],
    })));
    expect(results.map((result) => result.stdout)).toEqual([
      "first:test-only-secret-1234567890", "second:test-only-secret-1234567890",
    ]);
    expect(process.env.OPENAI_COMPATIBLE_BASE_URL).toBe("unchanged-host-value");
    expect(await readFile(argvLog, "utf8")).not.toContain("test-only-secret-1234567890");
  });

  test.each(["BAD=value", "BAD NAME", "-e", ""])("rejects environment name %j before spawning", async (name) => {
    const request = { script: "true", env: { [name]: "value" } };
    await expect(new DockerContainerRunner().exec(handle, request)).rejects.toThrow(/invalid env/u);
    await expect(readFile(argvLog)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects NUL in environment values before spawning", async () => {
    const request = { script: "true", env: { SAFE_NAME: "bad\0value" } };
    await expect(new DockerContainerRunner().exec(handle, request)).rejects.toThrow(/invalid env/u);
    await expect(readFile(argvLog)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
