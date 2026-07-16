import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  SandboxExecutionBroker,
  attachSandboxExecutionBroker,
  type SandboxSpawnCommand,
} from "../../src/sandbox/execution-broker.js";
import { createGlobTool } from "../../src/tools/system/glob.js";
import {
  __resetRipgrepProbeForTests,
  createGrepTool,
} from "../../src/tools/system/grep.js";
import { createOrientTool } from "../../src/tools/system/orient.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { normalizeUserPdfInput } from "../../src/prompts/attachments/user-pdf-input.js";

describe("model-controlled helper process sandbox closure", () => {
  let root = "";
  let bin = "";
  let marker = "";
  let savedPath: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-process-boundary-"));
    bin = join(root, "bin");
    marker = join(root, "spawned");
    savedPath = process.env.PATH;
    await mkdir(bin);
    const rg = join(bin, "rg");
    await writeFile(
      rg,
      `#!/bin/sh\nprintf spawned > "${marker}"\nif [ "$1" = "--version" ]; then printf 'ripgrep 99.0.0\\n'; fi\nexit 0\n`,
      "utf8",
    );
    await chmod(rg, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    __resetRipgrepProbeForTests();
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    __resetRipgrepProbeForTests();
    if (root) await rm(root, { recursive: true, force: true });
  });

  function unavailableBroker(): SandboxExecutionBroker {
    return new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      platform: "linux",
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: "linux",
        reason: "probe: forced unavailable for process-boundary test",
        remediation: "repair the test sandbox",
      }),
    });
  }

  function unavailableArgs(
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const broker = unavailableBroker();
    attachSandboxExecutionBroker(input, broker, "interactive");
    return input;
  }

  async function expectMarkerAbsent(): Promise<void> {
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }

  async function installMarkerExecutable(name: string): Promise<void> {
    const executable = join(bin, name);
    await writeFile(
      executable,
      `#!/bin/sh\nprintf spawned > "${marker}"\nexit 0\n`,
      "utf8",
    );
    await chmod(executable, 0o755);
  }

  function transformingDangerBroker(
    transform: (command: SandboxSpawnCommand) => SandboxSpawnCommand,
  ): SandboxExecutionBroker {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: root,
    });
    Object.defineProperty(broker, "prepareSpawn", {
      value: (_surface: string, command: SandboxSpawnCommand) =>
        transform(command),
    });
    return broker;
  }

  function capturedNodeCommand(params: {
    readonly original: SandboxSpawnCommand;
    readonly capturePath: string;
    readonly cwd: string;
    readonly label: string;
    readonly stdout: string;
  }): SandboxSpawnCommand {
    const sentinel = `sentinel-${params.label}`;
    const argv0 = `agenc-${params.label}`;
    const script = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(params.capturePath)}, JSON.stringify({ cwd: process.cwd(), sentinel: process.env.AGENC_TRANSFORM_SENTINEL, argv0: process.argv0 }));`,
      `process.stdout.write(${JSON.stringify(params.stdout)});`,
    ].join("\n");
    return {
      program: process.execPath,
      args: ["-e", script],
      cwd: params.cwd,
      env: {
        ...params.original.env,
        AGENC_TRANSFORM_SENTINEL: sentinel,
      },
      argv0,
    };
  }

  async function readCapture(
    capturePath: string,
  ): Promise<{ cwd: string; sentinel: string; argv0: string }> {
    return JSON.parse(await readFile(capturePath, "utf8")) as {
      cwd: string;
      sentinel: string;
      argv0: string;
    };
  }

  test("Grep rejects before probing a PATH-resolved ripgrep", async () => {
    const tool = createGrepTool({ allowedPaths: [root] });

    await expect(
      tool.execute(
        unavailableArgs({
          pattern: "needle",
          path: root,
          output_mode: "content",
        }),
      ),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "interactive",
    });
    await expectMarkerAbsent();
  });

  test("Glob rejects before launching a PATH-resolved ripgrep", async () => {
    const tool = createGlobTool({ allowedPaths: [root] });

    await expect(
      tool.execute(unavailableArgs({ pattern: "**/*.ts", path: root })),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "interactive",
    });
    await expectMarkerAbsent();
  });

  test("Orient rejects before launching its shared ripgrep enumerator", async () => {
    const tool = createOrientTool({ allowedPaths: [root] });

    await expect(
      tool.execute(unavailableArgs({ query: "where is retry logic" })),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "interactive",
    });
    await expectMarkerAbsent();
  });

  test("FileRead rejects before launching PATH-resolved PDF helpers", async () => {
    await installMarkerExecutable("pdfinfo");
    await installMarkerExecutable("pdftotext");
    const pdf = join(root, "brief.pdf");
    await writeFile(pdf, "%PDF-1.4\n", "utf8");
    const tool = createFileReadTool({ allowedPaths: [root] });

    const result = await tool.execute(
      unavailableArgs({ file_path: pdf, pages: "1" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("[sandbox_probe_failed]");
    expect(result.content).toContain("blocked interactive");
    await expectMarkerAbsent();
  });

  test("PDF mentions retain stable missing and unavailable boundary diagnostics", async () => {
    await installMarkerExecutable("pdftotext");
    const pdf = join(root, "mentioned.pdf");
    await writeFile(pdf, "%PDF-1.4\n", "utf8");

    const missing = await normalizeUserPdfInput(pdf, { cwd: root });
    expect(missing?.fallbackTextError).toContain(
      "[sandbox_surface_uncovered]",
    );
    await expectMarkerAbsent();

    const unavailable = await normalizeUserPdfInput(pdf, {
      cwd: root,
      sandboxExecutionBroker: unavailableBroker(),
    });
    expect(unavailable?.fallbackTextError).toContain("[sandbox_probe_failed]");
    expect(unavailable?.fallbackTextError).toContain("blocked tool");
    await expectMarkerAbsent();
  });

  test("tool helpers reject a missing authenticated boundary without spawning", async () => {
    await expect(
      createGrepTool({ allowedPaths: [root] }).execute({
        pattern: "needle",
        path: root,
      }),
    ).rejects.toMatchObject({
      code: "sandbox_surface_uncovered",
      surface: "tool",
    });
    await expect(
      createGlobTool({ allowedPaths: [root] }).execute({
        pattern: "**/*.ts",
        path: root,
      }),
    ).rejects.toMatchObject({
      code: "sandbox_surface_uncovered",
      surface: "tool",
    });
    await expect(
      createOrientTool({ allowedPaths: [root] }).execute({ query: "retry" }),
    ).rejects.toMatchObject({
      code: "sandbox_surface_uncovered",
      surface: "tool",
    });

    await installMarkerExecutable("pdfinfo");
    await installMarkerExecutable("pdftotext");
    const pdf = join(root, "missing-boundary.pdf");
    await writeFile(pdf, "%PDF-1.4\n", "utf8");
    const fileRead = await createFileReadTool({
      allowedPaths: [root],
    }).execute({ file_path: pdf, pages: "1" });
    expect(fileRead.isError).toBe(true);
    expect(fileRead.content).toContain("[sandbox_surface_uncovered]");
    expect(fileRead.content).toContain("blocked tool");
    await expectMarkerAbsent();
  });

  test("Grep honors transformed probe and search commands", async () => {
    const transformedCwd = join(root, "transformed-grep");
    await mkdir(transformedCwd);
    const match = join(root, "match.ts");
    await writeFile(match, "needle\n", "utf8");
    const probeCapture = join(root, "grep-probe.json");
    const searchCapture = join(root, "grep-search.json");
    const broker = transformingDangerBroker((command) => {
      const isProbe = command.args[0] === "--version";
      return capturedNodeCommand({
        original: command,
        capturePath: isProbe ? probeCapture : searchCapture,
        cwd: transformedCwd,
        label: isProbe ? "grep-probe" : "grep-search",
        stdout: isProbe ? "ripgrep 99.0.0\n" : `${match}\n`,
      });
    });
    const args = { pattern: "needle", path: root };
    attachSandboxExecutionBroker(args, broker, "interactive");

    const result = await createGrepTool({ allowedPaths: [root] }).execute(args);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("match.ts");
    await expect(readCapture(probeCapture)).resolves.toEqual({
      cwd: transformedCwd,
      sentinel: "sentinel-grep-probe",
      argv0: "agenc-grep-probe",
    });
    await expect(readCapture(searchCapture)).resolves.toEqual({
      cwd: transformedCwd,
      sentinel: "sentinel-grep-search",
      argv0: "agenc-grep-search",
    });
  });

  test("Glob honors its transformed enumerator command", async () => {
    const transformedCwd = join(root, "transformed-glob");
    await mkdir(transformedCwd);
    const match = join(root, "globbed.ts");
    await writeFile(match, "export {};\n", "utf8");
    const capture = join(root, "glob.json");
    const broker = transformingDangerBroker((command) =>
      capturedNodeCommand({
        original: command,
        capturePath: capture,
        cwd: transformedCwd,
        label: "glob",
        stdout: `${match}\n`,
      }),
    );
    const args = { pattern: "**/*.ts", path: root };
    attachSandboxExecutionBroker(args, broker, "interactive");

    const result = await createGlobTool({ allowedPaths: [root] }).execute(args);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("globbed.ts");
    await expect(readCapture(capture)).resolves.toEqual({
      cwd: transformedCwd,
      sentinel: "sentinel-glob",
      argv0: "agenc-glob",
    });
  });

  test("FileRead honors transformed PDF helper commands", async () => {
    const transformedCwd = join(root, "transformed-file-read");
    await mkdir(transformedCwd);
    const pdf = join(root, "transformed.pdf");
    await writeFile(pdf, "%PDF-1.4\n", "utf8");
    const infoCapture = join(root, "pdfinfo.json");
    const textCapture = join(root, "pdftotext.json");
    const broker = transformingDangerBroker((command) => {
      const isInfo = command.program === "pdfinfo";
      return capturedNodeCommand({
        original: command,
        capturePath: isInfo ? infoCapture : textCapture,
        cwd: transformedCwd,
        label: isInfo ? "pdfinfo" : "pdftotext",
        stdout: isInfo ? "Pages: 1\n" : "transformed PDF text\n",
      });
    });
    const args = { file_path: pdf, pages: "1" };
    attachSandboxExecutionBroker(args, broker, "interactive");

    const result = await createFileReadTool({ allowedPaths: [root] }).execute(
      args,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("transformed PDF text");
    await expect(readCapture(infoCapture)).resolves.toEqual({
      cwd: transformedCwd,
      sentinel: "sentinel-pdfinfo",
      argv0: "agenc-pdfinfo",
    });
    await expect(readCapture(textCapture)).resolves.toEqual({
      cwd: transformedCwd,
      sentinel: "sentinel-pdftotext",
      argv0: "agenc-pdftotext",
    });
  });

  test("PDF mentions honor their transformed extraction command", async () => {
    const transformedCwd = join(root, "transformed-mention");
    await mkdir(transformedCwd);
    const pdf = join(root, "transformed-mention.pdf");
    await writeFile(pdf, "%PDF-1.4\n", "utf8");
    const capture = join(root, "pdf-mention.json");
    const broker = transformingDangerBroker((command) =>
      capturedNodeCommand({
        original: command,
        capturePath: capture,
        cwd: transformedCwd,
        label: "pdf-mention",
        stdout: "mention text\n",
      }),
    );

    const result = await normalizeUserPdfInput(pdf, {
      cwd: root,
      sandboxExecutionBroker: broker,
    });

    expect(result?.fallbackText).toBe("mention text");
    await expect(readCapture(capture)).resolves.toEqual({
      cwd: transformedCwd,
      sentinel: "sentinel-pdf-mention",
      argv0: "agenc-pdf-mention",
    });
  });
});
