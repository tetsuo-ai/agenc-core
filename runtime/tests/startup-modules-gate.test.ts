import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import {
  FORBIDDEN_BEFORE_FIRST_REQUEST,
  addBundledStartupSources,
  findStartupOffenders,
  parseStartupTrace,
  traceImportOption,
} from "../scripts/check-startup-modules/runner.mjs";

const NM = "file:///opt/agenc/node_modules";
const runnerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "check-startup-modules",
  "runner.mjs",
);

describe("startup-modules gate", () => {
  test("parses the trace header and load lines", () => {
    const trace = parseStartupTrace(
      `# ["/opt/agenc/runtime/bin/agenc","daemon","start"]\n100 ${NM}/zod/index.js\n101 ${NM}/axios/index.js\n`,
    );
    expect(trace.argv).toBe('["/opt/agenc/runtime/bin/agenc","daemon","start"]');
    expect(trace.loads).toEqual([
      { time: 100, url: `${NM}/zod/index.js` },
      { time: 101, url: `${NM}/axios/index.js` },
    ]);
  });

  test("flags each listed package loaded before the first request, once per process", () => {
    const traces = [
      parseStartupTrace(
        `# ["daemon"]\n10 ${NM}/axios/lib/axios.js\n11 ${NM}/axios/lib/core.js\n12 ${NM}/lodash-es/lodash.js\n13 ${NM}/@modelcontextprotocol/sdk/client/index.js\n14 ${NM}/ajv/dist/ajv.js\n15 ${NM}/ajv-formats/dist/index.js\n16 ${NM}/undici/index.js\n17 bundled:../node_modules/zod/v4/core/core.js\n18 ${NM}/diff/libesm/index.js\n19 bundled:../src/services/compact/transaction.ts\n`,
      ),
    ];
    const offenders = findStartupOffenders(traces, 1000);
    expect(offenders.map((o) => o.url)).toEqual([
      `${NM}/axios/lib/axios.js`,
      `${NM}/lodash-es/lodash.js`,
      `${NM}/@modelcontextprotocol/sdk/client/index.js`,
      `${NM}/ajv/dist/ajv.js`,
      `${NM}/undici/index.js`,
      "bundled:../node_modules/zod/v4/core/core.js",
      `${NM}/diff/libesm/index.js`,
      "bundled:../src/services/compact/transaction.ts",
    ]);
    expect(offenders).toHaveLength(FORBIDDEN_BEFORE_FIRST_REQUEST.length);
  });

  test.each(["diff", "tar", "vscode-jsonrpc", "chokidar", "readdirp", "js-yaml"])(
    "flags raw and bundled %s before the first request",
    (name) => {
      for (const url of [`${NM}/${name}/index.js`, `bundled:../node_modules/${name}/index.js`]) {
        const trace = parseStartupTrace(`# ["daemon"]\n10 ${url}\n`);
        expect(findStartupOffenders([trace], 1000).map((offender) => offender.url)).toEqual([url]);
        expect(findStartupOffenders([trace], 5)).toEqual([]);
      }
    },
  );

  test("allows single lodash functions and anything loaded after the first request", () => {
    const traces = [
      parseStartupTrace(`# ["cli"]\n10 ${NM}/lodash-es/memoize.js\n2000 ${NM}/axios/lib/axios.js\n`),
    ];
    expect(findStartupOffenders(traces, 1000)).toEqual([]);
  });

  test("checks sources of early dist chunks, while allowing raw Zod and dispatcher helpers", async () => {
    const dist = mkdtempSync(path.join(tmpdir(), "startup-maps-"));
    try {
      const early = pathToFileURL(path.join(dist, "early.js")).href;
      const late = pathToFileURL(path.join(dist, "late.js")).href;
      const sources = ["../../node_modules/zod/v4/core/core.js", "../../node_modules/undici/lib/mock/mock-agent.js"];
      writeFileSync(path.join(dist, "early.js.map"), JSON.stringify({ sources }));
      // The late chunk deliberately has no map: the cutoff must be applied first.
      const trace = parseStartupTrace(`# ["daemon"]\n10 ${NM}/zod/v4/index.js\n11 ${NM}/undici/lib/dispatcher/agent.js\n12 ${NM}/undici/lib/web/fetch/body.js\n20 ${early}\n1000 ${late}\n`);
      const mapped = await addBundledStartupSources([trace], 1000, dist);
      expect(findStartupOffenders(mapped, 1000).map(o => o.url)).toEqual(sources.map(s => `bundled:${s}`));
      expect(trace.loads).toHaveLength(5);
      const postRequest = await addBundledStartupSources([trace], 20, dist);
      expect(findStartupOffenders(postRequest, 20)).toEqual([]);
      rmSync(path.join(dist, "early.js.map"));
      await expect(addBundledStartupSources([trace], 1000, dist)).rejects.toThrow();
      writeFileSync(path.join(dist, "early.js.map"), JSON.stringify({ sources: [null] }));
      await expect(addBundledStartupSources([trace], 1000, dist)).rejects.toThrow("invalid sources");
    } finally { rmSync(dist, { recursive: true, force: true }); }
  });

  test("passes the trace directory in the hook URL, not the environment", () => {
    const option = traceImportOption("/tmp/agt-x/startup-trace");
    expect(option.startsWith("--import=file://")).toBe(true);
    const url = new URL(option.slice("--import=".length));
    expect(url.pathname.endsWith("/check-startup-modules/trace-hook.mjs")).toBe(true);
    expect(url.searchParams.get("dir")).toBe("/tmp/agt-x/startup-trace");
    expect(option).not.toContain(" ");
  });
});

type Mark = { pid: number; home: string; nodeOptions?: string; execArgv?: string[] };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

/**
 * A stand-in CLI: `daemon start --foreground` records itself and, unless
 * `slowDaemon`, writes the pid file; `daemon status` reports it; `-p` records
 * itself and waits forever, like a one-shot waiting on a model.
 */
function writeFixtureCli(directory: string, marks: string, slowDaemon: boolean): string {
  const file = path.join(directory, "agenc.js");
  writeFileSync(
    file,
    [
      'import { readFileSync, rmSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      `const marks = ${JSON.stringify(marks)};`,
      "const args = process.argv.slice(2);",
      'const pidFile = path.join(process.env.AGENC_HOME, "daemon.pid");',
      "const mark = (name) => writeFileSync(path.join(marks, name), JSON.stringify({ pid: process.pid, home: process.env.HOME, nodeOptions: process.env.NODE_OPTIONS, execArgv: process.execArgv }));",
      'if (args[0] === "config") process.exit(0);',
      'if (args[0] === "daemon" && args[1] === "status") {',
      '  console.log(`AgenC daemon running (pid ${readFileSync(pidFile, "utf8").trim()})`);',
      "  process.exit(0);",
      "}",
      'if (args[0] === "daemon" && args[1] === "start") {',
      '  mark("daemon.json");',
      `  if (!${slowDaemon}) writeFileSync(pidFile, String(process.pid));`,
      '  process.on("SIGTERM", () => { rmSync(pidFile, { force: true }); process.exit(0); });',
      "} else {",
      '  mark("one-shot.json");',
      "}",
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
  );
  return file;
}

async function interruptGate(slowDaemon: boolean, waitForMark: string) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agenc-startup-gate-"));
  const marks = path.join(fixtureRoot, "marks");
  mkdirSync(marks);
  const cli = writeFixtureCli(fixtureRoot, marks, slowDaemon);
  const driver = [
    `import { runStartupModulesGate } from ${JSON.stringify(pathToFileURL(runnerPath).href)};`,
    `runStartupModulesGate({ binAgenc: ${JSON.stringify(cli)} }).then(`,
    "  (code) => { process.exitCode = code; },",
    "  (error) => { console.error(error); process.exitCode = 2; },",
    ");",
  ].join("\n");
  const gate = spawn(process.execPath, ["--input-type=module", "-e", driver], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  gate.stdout.on("data", (chunk) => (output += chunk));
  gate.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    gate.once("close", (code, signal) => resolve({ code, signal })),
  );
  const pids: number[] = [];
  try {
    const markPath = path.join(marks, waitForMark);
    expect(await waitFor(() => existsSync(markPath), 30_000), output).toBe(true);
    const read = (name: string): Mark | undefined =>
      existsSync(path.join(marks, name))
        ? (JSON.parse(readFileSync(path.join(marks, name), "utf8")) as Mark)
        : undefined;
    const daemon = read("daemon.json");
    const oneShot = read("one-shot.json");
    for (const mark of [daemon, oneShot]) if (mark !== undefined) pids.push(mark.pid);
    gate.kill("SIGTERM");
    const result = await exited;
    // Checked here, before the finally block below kills any survivor.
    const allStopped = await waitFor(() => pids.every((pid) => !isAlive(pid)), 5_000);
    const homeRemoved = daemon !== undefined && !existsSync(daemon.home);
    return { result, daemon, oneShot, output, allStopped, homeRemoved };
  } finally {
    if (gate.exitCode === null && gate.signalCode === null) gate.kill("SIGKILL");
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is what the tests assert.
      }
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("startup-modules gate interruption", () => {
  test("SIGTERM during the one-shot stops the one-shot and the daemon before removing state", async () => {
    const { result, daemon, oneShot, output, allStopped, homeRemoved } = await interruptGate(
      false,
      "one-shot.json",
    );
    expect(result.code, output).toBe(143);
    expect(daemon).toBeDefined();
    expect(oneShot).toBeDefined();
    expect(oneShot!.nodeOptions).toMatch(/trace-hook\.mjs\?dir=/);
    expect(daemon!.execArgv!.some((arg) => /trace-hook\.mjs\?dir=/.test(arg))).toBe(true);
    expect(daemon!.nodeOptions).toBe("");
    expect(allStopped).toBe(true);
    expect(homeRemoved).toBe(true);
  }, 60_000);

  test("SIGTERM while the daemon is starting stops it and starts no one-shot", async () => {
    const { result, daemon, oneShot, output, allStopped, homeRemoved } = await interruptGate(
      true,
      "daemon.json",
    );
    expect(result.code, output).toBe(143);
    expect(daemon).toBeDefined();
    expect(oneShot).toBeUndefined();
    expect(allStopped).toBe(true);
    expect(homeRemoved).toBe(true);
  }, 60_000);
});
