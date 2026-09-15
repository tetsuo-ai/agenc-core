import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeProcessBrokerPayload } from "../../src/utils/process-broker-protocol.js";

describe("process broker private protocol", () => {
  it("bounds bytes and string counts, rejecting invalid OS strings before spawn", () => {
    expect(() => serializeProcessBrokerPayload("/bin/true", ["x".repeat(2 * 1024 * 1024)], { env: {} })).toThrow(/exceeds/);
    expect(() => serializeProcessBrokerPayload("/bin/true", new Array(65536).fill(""), { env: {} })).toThrow(/invalid/);
    expect(() => serializeProcessBrokerPayload("/bin/true", ["bad\0arg"], { env: {} })).toThrow(/invalid/);
    expect(() => serializeProcessBrokerPayload("/bin/true", [], { env: { "bad=name": "value" } })).toThrow(/invalid/);
  });
});

describe.runIf(process.platform === "linux")("native broker handoff", () => {
  let directory: string;
  let broker: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "agenc-broker-protocol-test-"));
    broker = join(directory, "agenc-process-broker");
    execFileSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
      new URL("../../native/agenc-process-broker.c", import.meta.url).pathname, "-o", broker]);
  });
  afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

  async function run(payload: Buffer, stdin: Buffer = Buffer.alloc(0)) {
    const child = spawn(broker, [], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const status: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdio[3]!.on("data", (chunk: Buffer) => status.push(chunk));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    const bootstrap = child.stdio[4] as Writable;
    bootstrap.on("error", () => {});
    child.stdin!.on("error", () => {});
    bootstrap.end(payload);
    child.stdin!.end(stdin);
    return { ...await closed, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString(), status: Buffer.concat(status).toString() };
  }

  it("keeps target argv out of the broker and preserves argv0, environment, binary stdin, Unicode, and EOF", async () => {
    const marker = "workload-name-雪-2477";
    const script = `const fs = require('node:fs');
      process.stdout.write(JSON.stringify({argv: process.argv.slice(1), argv0: process.argv0, env: process.env,
        brokerArgv: fs.readFileSync('/proc/' + process.ppid + '/cmdline').toString(),
        stdin: fs.readFileSync(0).toString('base64')}));`;
    const stdin = Buffer.from([0, 255, 128, 10, 240]);
    const environment = { PATH: "/usr/bin:/bin", UNICODE: "value 雪\n", EMPTY: "" };
    const result = await run(serializeProcessBrokerPayload(process.execPath, ["-e", script, marker, "", "a\nb"], {
      argv0: "exact-argv0", env: environment,
    }), stdin);
    expect(result.code, result.stderr).toBe(0);
    expect(result.status).toBe("SC");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      argv: [marker, "", "a\nb"], argv0: "exact-argv0", env: environment,
      brokerArgv: broker + "\0", stdin: stdin.toString("base64"),
    });
  });

  it("rejects malformed and truncated frames before readiness or task execution", async () => {
    const valid = serializeProcessBrokerPayload("/bin/echo", ["TASK-EXECUTED"], { env: {} });
    const oversized = Buffer.from(valid);
    oversized.writeUInt32BE(0xffffffff, 4);
    const badCount = Buffer.from(valid);
    badCount.writeUInt32BE(0, 8);
    const missingTerminator = Buffer.from(valid);
    missingTerminator[missingTerminator.length - 1] = 1;
    const badMagic = Buffer.from(valid);
    badMagic[0] = 0;
    for (const frame of [Buffer.alloc(0), valid.subarray(0, 10), valid.subarray(0, -1), oversized, badCount, missingTerminator, badMagic]) {
      const result = await run(frame);
      expect(result.code).toBe(125);
      expect(result.stdout.length).toBe(0);
      expect(result.status).toBe("");
    }
  });

  it("retains cleanup proof when a workload finds and kills itself through /proc cmdline matching", async () => {
    // This is argv-hygiene coverage within the disposable test namespace.
    // Arbitrary signals still require an execution environment outside the
    // controller's PID namespace; local execution does not provide that.
    const marker = "agenc-filename-cleanup-regression-2477";
    const script = `const fs = require('node:fs');
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(entry)) continue;
        let cmdline;
        try { cmdline = fs.readFileSync('/proc/' + entry + '/cmdline').toString(); } catch { continue; }
        if (cmdline.includes(${JSON.stringify(marker)})) process.kill(Number(entry), 'SIGKILL');
      }
      process.exit(99);`;
    const killed = await run(serializeProcessBrokerPayload(process.execPath, ["-e", script], { env: {} }));
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    expect(killed.status).toBe("SC");
    const next = await run(serializeProcessBrokerPayload("/bin/echo", ["subsequent call survived"], { env: {} }));
    expect(next.code, next.stderr).toBe(0);
    expect(next.stdout.toString()).toBe("subsequent call survived\n");
  });
});
