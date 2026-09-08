import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly completion: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

describe("cross-process media quota reservations", () => {
  let home: string;
  let usageFile: string;
  let effectsFile: string;
  let workers: Worker[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-media-process-"));
    usageFile = join(home, "usage.json");
    effectsFile = join(home, "effects.jsonl");
    workers = [];
  });

  afterEach(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill("SIGKILL");
      }
    }
    await Promise.allSettled(workers.map(worker => worker.completion));
    rmSync(home, { recursive: true, force: true });
  });

  function launch(kind: "meme" | "voice", limit: number, mode = "normal", date = "2026-09-08T00:00:00Z"): Worker {
    const runtimeRoot = join(import.meta.dirname, "../..");
    const child = spawn(process.execPath, [
      "--unhandled-rejections=strict", "--import", "tsx",
      join(import.meta.dirname, "fixtures/media-quota.mjs"),
      usageFile, effectsFile, kind, String(limit), mode, date,
    ], {
      cwd: runtimeRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(runtimeRoot, "tsconfig.json") },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    const ready = Promise.withResolvers<void>();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) ready.resolve();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const completion = new Promise<Awaited<Worker["completion"]>>((resolveCompletion, reject) => {
      child.once("error", error => {
        ready.reject(error);
        reject(error);
      });
      child.once("close", code => {
        ready.reject(new Error(`worker exited before readiness: ${code} ${stderr}`));
        resolveCompletion({ code, stdout, stderr });
      });
    });
    void completion.catch(() => undefined);
    void ready.promise.catch(() => undefined);
    const worker = { child, ready: ready.promise, completion };
    workers.push(worker);
    return worker;
  }

  async function start(group: readonly Worker[]): Promise<void> {
    await Promise.all(group.map(worker => worker.ready));
    for (const worker of group) worker.child.stdin.end("GO\n");
  }

  function effects(): unknown[] {
    return existsSync(effectsFile)
      ? readFileSync(effectsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      : [];
  }

  it.each([1, 3])("limits a synchronized six-process burst to %s provider calls", async (limit) => {
    const group = Array.from({ length: 6 }, (_, index) => launch(index % 2 === 0 ? "meme" : "voice", limit));
    await start(group);
    for (const result of await Promise.all(group.map(worker => worker.completion))) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("DONE\n");
    }
    expect(effects()).toHaveLength(limit);
    expect(JSON.parse(readFileSync(usageFile, "utf8"))).toEqual({ day: "2026-09-08", count: limit });
  }, 15_000);

  it("rolls a full previous-day ledger forward under concurrent processes", async () => {
    writeFileSync(usageFile, JSON.stringify({ day: "2026-09-07", count: 50 }), { mode: 0o600 });
    const group = [launch("meme", 1), launch("voice", 1)];
    await start(group);
    for (const result of await Promise.all(group.map(worker => worker.completion))) {
      expect(result.code, result.stderr).toBe(0);
    }
    expect(effects()).toHaveLength(1);
    expect(JSON.parse(readFileSync(usageFile, "utf8"))).toEqual({ day: "2026-09-08", count: 1 });
  }, 15_000);

  it.each(["before_provider", "after_provider"])("does not refund a crash %s", async (mode) => {
    const crashed = launch("meme", 1, mode);
    await start([crashed]);
    const crashedResult = await crashed.completion;
    expect(crashedResult.code, crashedResult.stderr).toBe(17);
    expect(JSON.parse(readFileSync(usageFile, "utf8"))).toEqual({ day: "2026-09-08", count: 1 });
    const retry = launch("voice", 1);
    await start([retry]);
    const retryResult = await retry.completion;
    expect(retryResult.code, retryResult.stderr).toBe(0);
    expect(effects()).toHaveLength(mode === "before_provider" ? 0 : 1);
  }, 15_000);
});
