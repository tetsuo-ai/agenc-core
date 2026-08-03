import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CsvOutputRootCapability,
  createCsvOutputRootCapability,
  recoverCsvOutputIntents,
  writeCsvOutput,
  type CsvOutputIntentStore,
} from "./csv-output.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-csv-output-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeCsvOutput", () => {
  it("publishes a default output atomically with a digest", async () => {
    const capability = createCsvOutputRootCapability(root);
    const artifact = await writeCsvOutput({
      capability,
      jobId: "job/unsafe",
      headers: ["id", "value"],
      rows: [["one", 'comma,quote"\nline']],
    });
    const output = await readFile(artifact.path, "utf8");
    expect(output).toBe('id,value\none,"comma,quote""\nline"\n');
    expect(artifact.sha256).toBe(
      createHash("sha256").update(output).digest("hex"),
    );
    expect(artifact.bytes).toBe(Buffer.byteLength(output, "utf8"));
    expect(dirname(artifact.path)).toBe(join(root, ".agenc-csv-job-output"));
  });

  it("preserves an existing target when output exceeds its bound", async () => {
    const target = join(root, "result.csv");
    await writeFile(target, "prior\n", { mode: 0o600 });
    await expect(
      writeCsvOutput({
        capability: createCsvOutputRootCapability(root),
        jobId: "bounded",
        requestedPath: target,
        headers: ["value"],
        rows: [["too-large"]],
        maxBytes: 6,
      }),
    ).rejects.toThrow(/before publication/u);
    expect(await readFile(target, "utf8")).toBe("prior\n");
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".agenc-csv.tmp")),
    ).toEqual([]);
  });

  it("refuses to overwrite an existing target changed during staging", async () => {
    const target = join(root, "result.csv");
    await writeFile(target, "prior\n", { mode: 0o600 });
    function* rows(): IterableIterator<ReadonlyArray<string>> {
      appendFileSync(target, "concurrent\n", "utf8");
      yield ["replacement"];
    }

    await expect(
      writeCsvOutput({
        capability: createCsvOutputRootCapability(root),
        jobId: "concurrent-target",
        requestedPath: target,
        headers: ["value"],
        rows: rows(),
      }),
    ).rejects.toThrow(/target identity changed before publication/u);
    expect(await readFile(target, "utf8")).toBe("prior\nconcurrent\n");
  });

  it("rejects out-of-root, symlink, hardlink, and create-new collisions", async () => {
    const capability = createCsvOutputRootCapability(root);
    const outside = join(dirname(root), "outside.csv");
    await expect(
      writeCsvOutput({
        capability,
        jobId: "outside",
        requestedPath: outside,
        headers: ["id"],
        rows: [["one"]],
      }),
    ).rejects.toThrow(/outside/u);

    const source = join(root, "source.csv");
    const linked = join(root, "linked.csv");
    await writeFile(source, "prior\n", { mode: 0o600 });
    await link(source, linked);
    await expect(
      writeCsvOutput({
        capability,
        jobId: "hardlink",
        requestedPath: linked,
        headers: ["id"],
        rows: [["one"]],
      }),
    ).rejects.toThrow(/single-link regular file/u);

    const symbolic = join(root, "symbolic.csv");
    await symlink(source, symbolic);
    await expect(
      writeCsvOutput({
        capability,
        jobId: "symlink",
        requestedPath: symbolic,
        headers: ["id"],
        rows: [["one"]],
      }),
    ).rejects.toThrow(/single-link regular file/u);

    await expect(
      writeCsvOutput({
        capability,
        jobId: "create",
        requestedPath: source,
        mode: "create_new",
        headers: ["id"],
        rows: [["one"]],
      }),
    ).rejects.toThrow(/already exists/u);
  });

  it("rejects forged capabilities and aborts before touching the target", async () => {
    expect(
      () =>
        new CsvOutputRootCapability(Symbol("forged"), root, {
          dev: 0n,
          ino: 0n,
        } as never),
    ).toThrow(/cannot be constructed/u);
    const controller = new AbortController();
    controller.abort(new Error("test abort"));
    const target = join(root, "aborted.csv");
    await expect(
      writeCsvOutput({
        capability: createCsvOutputRootCapability(root),
        jobId: "abort",
        requestedPath: target,
        headers: ["id"],
        rows: [["one"]],
        signal: controller.signal,
      }),
    ).rejects.toThrow(/test abort/u);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stops a multi-page recovery at the probe abort reason", async () => {
    const controller = new AbortController();
    const abortReason = new Error("recovery probe aborted");
    const claim = vi.fn(async () => {
      controller.abort(abortReason);
      return { intents: [], hasMore: true };
    });
    const intentStore: CsvOutputIntentStore = {
      beginCsvOutputIntent: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: claim,
      finishCsvOutputIntentRecovery: vi.fn(),
      deferCsvOutputIntentRecovery: vi.fn(),
    };

    await expect(
      recoverCsvOutputIntents(
        createCsvOutputRootCapability(root),
        intentStore,
        { signal: controller.signal },
      ),
    ).rejects.toBe(abortReason);
    expect(claim).toHaveBeenCalledOnce();
  });

  it("does not finish an intent aborted during final-page filesystem I/O", async () => {
    const controller = new AbortController();
    const abortReason = new Error("final page filesystem abort");
    const temporaryPath = join(root, ".final-abort.agenc-csv.tmp");
    await writeFile(temporaryPath, "partial", { mode: 0o600 });
    const stats = await lstat(temporaryPath, { bigint: true });
    const finish = vi.fn();
    const defer = vi.fn();
    const intent = {
      intentId: "final-abort-intent",
      ownerGeneration: "final-abort-generation",
      priorState: "abandoned" as const,
      targetPath: join(root, "final-abort.csv"),
      get temporaryPath(): string {
        controller.abort(abortReason);
        return temporaryPath;
      },
      temporaryDev: stats.dev.toString(),
      temporaryIno: stats.ino.toString(),
    };
    const claim = vi.fn(async () => ({
      intents: [intent],
      hasMore: false,
    }));
    const intentStore: CsvOutputIntentStore = {
      beginCsvOutputIntent: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: claim,
      finishCsvOutputIntentRecovery: finish,
      deferCsvOutputIntentRecovery: defer,
    };

    await expect(
      recoverCsvOutputIntents(
        createCsvOutputRootCapability(root),
        intentStore,
        { signal: controller.signal },
      ),
    ).rejects.toBe(abortReason);
    expect(claim).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
    await expect(readFile(temporaryPath, "utf8")).resolves.toBe("partial");
  });
});
