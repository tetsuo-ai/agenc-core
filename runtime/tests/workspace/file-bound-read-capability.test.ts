import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import {
  __setWorkspaceBoundReadNoFollowForTests,
  __setWorkspaceBoundReadWorkerSourceTransformForTests,
  __workspaceBoundHelperLaunchPlanForTests,
  __workspaceBoundSourceBootstrapForTests,
  bindWorkspaceDirectoryReadCapability,
  bindWorkspaceFileReadCapability,
  captureWorkspaceFilePathTransactionGuard,
  MAX_BOUND_HELPER_WINDOWS_LAUNCH_UTF16_CODE_UNITS,
} from "../../src/workspace/file-mutation-transaction.js";

async function runSourceBootstrap(
  args: readonly string[],
  source: Buffer,
): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, args, {
    env: { NODE_OPTIONS: "", NODE_PATH: "" },
    stdio: ["ignore", "pipe", "pipe", "overlapped"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const sourcePipe = child.stdio[3] as Writable | null;
  if (sourcePipe === null) {
    child.kill();
    throw new Error("source bootstrap pipe was not created");
  }
  sourcePipe.on("error", () => undefined);
  const closed = once(child, "close") as Promise<
    [number | null, NodeJS.Signals | null]
  >;
  sourcePipe.end(source);
  const [exitCode, signal] = await closed;
  return {
    exitCode,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

describe("descriptor-bound file reads", () => {
  let root = "";

  afterEach(async () => {
    __setWorkspaceBoundReadNoFollowForTests(undefined);
    __setWorkspaceBoundReadWorkerSourceTransformForTests(undefined);
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("keeps the production helper launch plan below Windows process boundaries", () => {
    const plan = __workspaceBoundHelperLaunchPlanForTests({
      executable: String.raw`C:\Program Files\nodejs\node.exe`,
      platform: "win32",
      processEnvironment: {
        PATH: "ignored-path".repeat(10_000),
        XAI_API_KEY: "ignored-secret",
        SystemRoot: String.raw`C:\Windows`,
        WINDIR: String.raw`C:\Windows`,
      },
    });

    expect(plan.directoryCommandLineUtf16CodeUnits).toBeLessThanOrEqual(
      MAX_BOUND_HELPER_WINDOWS_LAUNCH_UTF16_CODE_UNITS,
    );
    expect(plan.workerCommandLineUtf16CodeUnits).toBeLessThanOrEqual(
      MAX_BOUND_HELPER_WINDOWS_LAUNCH_UTF16_CODE_UNITS,
    );
    expect(plan.environmentUtf16CodeUnits).toBeLessThanOrEqual(
      MAX_BOUND_HELPER_WINDOWS_LAUNCH_UTF16_CODE_UNITS,
    );
    expect(plan.environment).toEqual({
      NODE_OPTIONS: "",
      NODE_PATH: "",
      AGENC_BOUND_READ_USE_NOFOLLOW: "1",
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
    });
    expect(plan.directoryArgs.join("\n")).not.toContain(
      "const createStructuredRipgrepLimiter",
    );
    expect(plan.workerArgs.join("\n")).not.toContain(
      "const createStructuredRipgrepLimiter",
    );
  });

  test("authenticates the exact source frame before importing it", async () => {
    const transport = __workspaceBoundSourceBootstrapForTests(
      'process.stdout.write("authenticated-source-ok");',
    );
    const result = await runSourceBootstrap(transport.args, transport.bytes);

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: "authenticated-source-ok",
      stderr: "",
    });
  });

  test.each([
    {
      name: "digest mismatch",
      mutate: (bytes: Buffer) => {
        const changed = Buffer.from(bytes);
        changed[0] ^= 1;
        return changed;
      },
      expected: /digest mismatch/iu,
    },
    {
      name: "truncated frame",
      mutate: (bytes: Buffer) => bytes.subarray(0, bytes.length - 1),
      expected: /ended before its declared boundary/iu,
    },
    {
      name: "trailing bytes",
      mutate: (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("x")]),
      expected: /exceeds its declared boundary/iu,
    },
  ])("rejects a $name", async ({ mutate, expected }) => {
    const transport = __workspaceBoundSourceBootstrapForTests(
      'process.stdout.write("must-not-import");',
    );
    const result = await runSourceBootstrap(
      transport.args,
      mutate(transport.bytes),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("must-not-import");
    expect(result.stderr).toMatch(expected);
  });

  test("rejects an oversized helper source before spawn", () => {
    const maximum =
      __workspaceBoundSourceBootstrapForTests("export {};").maximumSourceBytes;
    expect(() =>
      __workspaceBoundSourceBootstrapForTests("x".repeat(maximum + 1)),
    ).toThrowError(/maximum/iu);
  });

  test.each([
    {
      name: "corrupted",
      transform: (source: Buffer) => {
        const changed = Buffer.from(source);
        changed[0] ^= 1;
        return changed;
      },
    },
    {
      name: "truncated",
      transform: (source: Buffer) => source.subarray(0, source.length - 1),
    },
  ])(
    "rejects a $name fd4 worker frame before helper readiness",
    async ({ transform }) => {
      root = await mkdtemp(join(tmpdir(), "agenc-bound-read-fd4-"));
      __setWorkspaceBoundReadWorkerSourceTransformForTests(transform);

      await expect(bindWorkspaceDirectoryReadCapability(root)).rejects.toThrow(
        /helper|capability|source/iu,
      );
    },
  );

  test("portable no-O_NOFOLLOW fallback rejects a replaced leaf", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-"));
    const target = join(root, "target.txt");
    const displaced = join(root, "target-inside.txt");
    const outside = join(root, "outside.txt");
    await writeFile(target, "inside-portable-proof\n", "utf8");
    await writeFile(outside, "outside-portable-secret\n", "utf8");
    __setWorkspaceBoundReadNoFollowForTests(false);
    const capability = await bindWorkspaceFileReadCapability(target);

    try {
      const admitted = await capability.readFile(4096);
      expect(admitted.content.toString("utf8")).toBe("inside-portable-proof\n");
      expect(typeof admitted.stats.dev).toBe("string");
      expect(typeof admitted.stats.ino).toBe("string");

      await rename(target, displaced);
      if (process.platform === "win32") {
        // Creating a file symlink can require Developer Mode/admin on Windows;
        // an outside hardlink still proves admitted-identity enforcement.
        await link(outside, target);
      } else {
        // O_NOFOLLOW is deliberately disabled above. The pre-open regular-file
        // proof must reject this link before any outside descriptor is read.
        await symlink(outside, target, "file");
      }

      await expect(capability.readFile(4096)).rejects.toThrow();
    } finally {
      await capability.dispose();
    }
  });

  test("reads a text window while preserving the bounded binary sample", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-window-"));
    const target = join(root, "target.txt");
    const content = Array.from(
      { length: 2_000 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");
    await writeFile(target, content, "utf8");
    const capability = await bindWorkspaceFileReadCapability(target);

    try {
      const result = await capability.readTextWindow(2, 2, 4_096);

      expect(result.content).toBe("line-2\nline-3");
      expect(result.binarySample).toEqual(
        Buffer.from(content, "utf8").subarray(0, 8_192),
      );
      expect(result.stats.size).toBe(Buffer.byteLength(content, "utf8"));
      expect(result).toMatchObject({
        startLine: 2,
        endLine: 3,
        numLines: 2,
        isPartial: true,
      });
    } finally {
      await capability.dispose();
    }
  });

  test.runIf(process.platform === "linux")(
    "keeps NFC and NFD siblings distinct on a normalization-sensitive Darwin mount",
    async () => {
      root = await mkdtemp(join(tmpdir(), "agenc-bound-read-unicode-"));
      const nfcDirectory = join(root, "caf\u00e9");
      const nfdDirectory = join(root, "cafe\u0301");
      const nfcFile = join(nfcDirectory, "value.txt");
      const nfdFile = join(nfdDirectory, "value.txt");
      await mkdir(nfcDirectory);
      await mkdir(nfdDirectory);
      await writeFile(nfcFile, "nfc-sibling\n", "utf8");
      await writeFile(nfdFile, "nfd-target\n", "utf8");
      const platformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      if (platformDescriptor?.configurable !== true) {
        throw new Error("process.platform is not configurable for this test");
      }
      let directoryCapability:
        | Awaited<ReturnType<typeof bindWorkspaceDirectoryReadCapability>>
        | undefined;
      let fileCapability:
        Awaited<ReturnType<typeof bindWorkspaceFileReadCapability>> | undefined;
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "darwin",
      });
      try {
        directoryCapability =
          await bindWorkspaceDirectoryReadCapability(nfdDirectory);
        fileCapability = await bindWorkspaceFileReadCapability(nfdFile);
        const directoryRead = await directoryCapability.readRelativeFile(
          "value.txt",
          4096,
        );
        const fileRead = await fileCapability.readFile(4096);
        expect(directoryRead.content.toString("utf8")).toBe("nfd-target\n");
        expect(fileRead.content.toString("utf8")).toBe("nfd-target\n");
      } finally {
        try {
          try {
            await fileCapability?.dispose();
          } finally {
            await directoryCapability?.dispose();
          }
        } finally {
          Object.defineProperty(process, "platform", platformDescriptor);
        }
      }
    },
  );

  test.runIf(process.platform === "linux")(
    "captures an NFD mutation target exactly on a normalization-sensitive Darwin mount",
    async () => {
      root = await mkdtemp(join(tmpdir(), "agenc-bound-mutation-unicode-"));
      const nfcFile = join(root, "caf\u00e9.txt");
      const nfdFile = join(root, "cafe\u0301.txt");
      await writeFile(nfcFile, "nfc-sibling\n", "utf8");
      await writeFile(nfdFile, "nfd-target\n", "utf8");
      const platformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      if (platformDescriptor?.configurable !== true) {
        throw new Error("process.platform is not configurable for this test");
      }
      let guard:
        | Awaited<ReturnType<typeof captureWorkspaceFilePathTransactionGuard>>
        | undefined;
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "darwin",
      });
      try {
        guard = await captureWorkspaceFilePathTransactionGuard(nfdFile);
        expect(guard.path).toBe(nfdFile);
        expect(guard.backupContent?.toString("utf8")).toBe("nfd-target\n");
        await expect(guard.assertOriginalState()).resolves.toBeUndefined();
        const observed = await guard.observeState();
        expect(observed.kind).toBe("content");
        if (observed.kind === "content") {
          expect(observed.content.toString("utf8")).toBe("nfd-target\n");
        }
      } finally {
        try {
          await guard?.dispose();
        } finally {
          Object.defineProperty(process, "platform", platformDescriptor);
        }
      }
    },
  );

  test("bound subprocess timeout is reported and leaves the helper reusable", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-timeout-"));
    const target = join(root, "target.txt");
    const stall = join(root, "stall.mjs");
    await writeFile(target, "still-readable\n", "utf8");
    await writeFile(stall, "setInterval(() => {}, 1_000);\n", "utf8");
    const capability = await bindWorkspaceDirectoryReadCapability(root);

    try {
      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [stall],
        env: {},
        timeoutMs: 50,
        maxOutputBytes: 4096,
      });

      expect(result.stopReason).toBe("timeout");
      expect(result.aborted).toBe(false);
      const read = await capability.readRelativeFile("target.txt", 4096);
      expect(read.content.toString("utf8")).toBe("still-readable\n");
    } finally {
      await capability.dispose();
    }
  });

  test("bound subprocess abort terminates promptly and disposes cleanly", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-abort-"));
    const stall = join(root, "stall.mjs");
    await writeFile(stall, "setInterval(() => {}, 1_000);\n", "utf8");
    const capability = await bindWorkspaceDirectoryReadCapability(root);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 25);

    try {
      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [stall],
        env: {},
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
        signal: controller.signal,
      });

      expect(result.aborted).toBe(true);
      expect(result.stopReason).toBe("aborted");
    } finally {
      clearTimeout(abortTimer);
      await expect(capability.dispose()).resolves.toBeUndefined();
    }
  });

  test.each([
    { label: "directory helper", relativeInputPath: undefined },
    { label: "authenticated read worker", relativeInputPath: "target.txt" },
  ])(
    "forwards transformed argv0 and environment through the $label transport",
    async ({ relativeInputPath }) => {
      root = await mkdtemp(join(tmpdir(), "agenc-bound-read-argv0-"));
      await writeFile(join(root, "target.txt"), "worker input\n", "utf8");
      const capability = await bindWorkspaceDirectoryReadCapability(root);
      const argv0 = "agenc-transformed-ripgrep";
      const sentinel = "transformed-environment";

      try {
        const result = await capability.runRipgrep({
          program: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({ argv0: process.argv0, cwd: process.cwd(), sentinel: process.env.AGENC_BOUND_SENTINEL }));",
          ],
          argv0,
          env: { AGENC_BOUND_SENTINEL: sentinel },
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
          ...(relativeInputPath === undefined ? {} : { relativeInputPath }),
        });

        expect(result.spawnError).toBeUndefined();
        expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({
          argv0,
          cwd: root,
          sentinel,
        });
      } finally {
        await capability.dispose();
      }
    },
  );

  test("structured line limiting preserves one fragmented JSON record", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-structured-"));
    const producer = join(root, "fragmented-json.mjs");
    const path = { text: "target.txt" };
    const begin = JSON.stringify({ type: "begin", data: { path } });
    const first = JSON.stringify({
      type: "match",
      data: {
        path,
        lines: { text: "first\n" },
        line_number: 1,
        absolute_offset: 0,
        submatches: [{ match: { text: "first" }, start: 0, end: 5 }],
      },
    });
    const second = JSON.stringify({
      type: "match",
      data: {
        path,
        lines: { text: "second\n" },
        line_number: 2,
        absolute_offset: 6,
        submatches: [{ match: { text: "second" }, start: 0, end: 6 }],
      },
    });
    const end = JSON.stringify({ type: "end", data: { path } });
    const summary = JSON.stringify({ type: "summary", data: {} });
    await writeFile(
      producer,
      [
        `process.stdout.write(${JSON.stringify(`${begin}\n`)});`,
        `const first = ${JSON.stringify(`${first}\n`)};`,
        "for (let index = 0; index < first.length; index += 7) {",
        "  process.stdout.write(first.slice(index, index + 7));",
        "  await new Promise((resolve) => setImmediate(resolve));",
        "}",
        `process.stdout.write(${JSON.stringify(`${second}\n${end}\n${summary}\n`)});`,
      ].join("\n"),
      "utf8",
    );
    const capability = await bindWorkspaceDirectoryReadCapability(root);

    try {
      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [producer],
        env: {},
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
        structuredLineLimit: {
          outputMode: "content",
          maximumLines: 1,
          maximumRecordBytes: 1024,
        },
      });

      expect(result.spawnError).toBeUndefined();
      expect(result.killedAfterLimit).toBe(true);
      expect(result.stdout.toString("utf8")).toBe(`${begin}\n${first}\n`);
    } finally {
      await capability.dispose();
    }
  });

  test("structured limiting rejects a fragmented oversized record early", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-record-cap-"));
    const target = join(root, "target.txt");
    const producer = join(root, "oversized-record.mjs");
    await writeFile(target, "still-readable\n", "utf8");
    await writeFile(
      producer,
      [
        "for (let index = 0; index < 20; index += 1) {",
        '  process.stdout.write("x".repeat(128));',
        "  await new Promise((resolve) => setImmediate(resolve));",
        "}",
      ].join("\n"),
      "utf8",
    );
    const capability = await bindWorkspaceDirectoryReadCapability(root);

    try {
      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [producer],
        env: {},
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
        structuredLineLimit: {
          outputMode: "content",
          maximumLines: 1,
          maximumRecordBytes: 1024,
        },
      });

      expect(result.killedAfterLimit).toBe(false);
      expect(result.spawnError?.message).toContain(
        "structured ripgrep record exceeds 1024 bytes",
      );
      expect(result.stdout.byteLength).toBeLessThanOrEqual(1024);
      const read = await capability.readRelativeFile("target.txt", 4096);
      expect(read.content.toString("utf8")).toBe("still-readable\n");
    } finally {
      await capability.dispose();
    }
  });

  test.each([
    {
      label: "invalid UTF-8 paths remain byte-distinct from U+FFFD exclusions",
      outputMode: "files_with_matches" as const,
      wire: Buffer.concat([
        Buffer.from([0xff, 0]),
        Buffer.from("clean.txt\0", "utf8"),
      ]),
      excludedPaths: ["\ufffd"],
      reason: undefined,
      expectedStdout: Buffer.from([0xff, 0]),
    },
    {
      label: "invalid counts on excluded paths",
      outputMode: "count" as const,
      wire: Buffer.from("dirty.txt\x00not-decimal\nclean.txt\x001\n", "utf8"),
      excludedPaths: ["dirty.txt"],
      reason: "INVALID_COUNT",
      expectedStdout: undefined,
    },
    {
      label: "invalid JSON ordering before an offset",
      outputMode: "content" as const,
      wire: Buffer.from(
        `${JSON.stringify({
          type: "match",
          data: {
            path: { text: "skipped.txt" },
            lines: { text: "needle\n" },
            line_number: 1,
            absolute_offset: 0,
            submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
          },
        })}\n${JSON.stringify({ type: "summary", data: {} })}\n`,
        "utf8",
      ),
      excludedPaths: [],
      reason: "INVALID_JSON_RECORD_ORDER",
      expectedStdout: undefined,
    },
  ])(
    "validates $label",
    async ({ outputMode, wire, excludedPaths, reason, expectedStdout }) => {
      root = await mkdtemp(join(tmpdir(), "agenc-bound-read-wire-validation-"));
      const producer = join(root, "wire-producer.mjs");
      await writeFile(
        producer,
        `process.stdout.write(Buffer.from(${JSON.stringify(wire.toString("base64"))}, "base64"));\n`,
        "utf8",
      );
      const capability = await bindWorkspaceDirectoryReadCapability(root);

      try {
        const result = await capability.runRipgrep({
          program: process.execPath,
          args: [producer],
          env: {},
          timeoutMs: 5_000,
          maxOutputBytes: 4096,
          structuredLineLimit: {
            outputMode,
            maximumLines: 1,
            maximumRecordBytes: 1024,
            skipLines: outputMode === "content" ? 1 : 0,
            excludedPaths,
          },
        });

        if (reason === undefined) {
          expect(result.spawnError).toBeUndefined();
          expect(result.killedAfterLimit).toBe(true);
          expect(result.stdout).toEqual(expectedStdout);
        } else {
          expect(result.killedAfterLimit).toBe(false);
          expect(result.spawnError?.message).toContain(`[${reason}]`);
        }
      } finally {
        await capability.dispose();
      }
    },
  );

  test("normalizes Windows aliases and preserves POSIX path bytes when excluding dirty paths", async () => {
    const transactionSource = await readFile(
      new URL(
        "../../src/workspace/file-mutation-transaction.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const limiterSourcePrefix =
      "const STRUCTURED_RIPGREP_LIMITER_SOURCE = String.raw`\n";
    const limiterSourceSuffix = "\n`;\n\nconst BOUND_READ_WORKER_SOURCE";
    const limiterSourceStart = transactionSource.indexOf(limiterSourcePrefix);
    const limiterSourceEnd = transactionSource.indexOf(
      limiterSourceSuffix,
      limiterSourceStart + limiterSourcePrefix.length,
    );
    if (limiterSourceStart < 0 || limiterSourceEnd < 0) {
      throw new Error("structured ripgrep limiter source was not found");
    }
    const limiterSource = transactionSource.slice(
      limiterSourceStart + limiterSourcePrefix.length,
      limiterSourceEnd,
    );
    const createLimiter = Function(
      `${limiterSource}\nreturn createStructuredRipgrepLimiter;`,
    )() as (value: {
      readonly outputMode: "files_with_matches";
      readonly maximumLines: number;
      readonly maximumRecordBytes: number;
      readonly excludedPaths: readonly string[];
    }) => {
      readonly consume: (chunk: Buffer) => {
        readonly captureParts: readonly Buffer[];
        readonly reached: boolean;
      };
    };
    const wire = Buffer.from(".\\CAF\u00c9\\Dirty.ts\0clean.ts\0", "utf8");
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    if (platformDescriptor?.configurable !== true) {
      throw new Error("process.platform is not configurable for this test");
    }
    try {
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "win32",
      });
      const result = createLimiter({
        outputMode: "files_with_matches",
        maximumLines: 1,
        maximumRecordBytes: 1_024,
        excludedPaths: ["caf\u00e9/dirty.ts"],
      }).consume(wire);

      expect(result.reached).toBe(true);
      expect(Buffer.concat(result.captureParts)).toEqual(
        Buffer.from("clean.ts\0", "utf8"),
      );

      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "darwin",
      });
      const darwinResult = createLimiter({
        outputMode: "files_with_matches",
        maximumLines: 1,
        maximumRecordBytes: 1_024,
        excludedPaths: ["caf\u00e9/dirty.ts"],
      }).consume(Buffer.from("./cafe\u0301/dirty.ts\0clean.ts\0", "utf8"));

      expect(darwinResult.reached).toBe(true);
      expect(Buffer.concat(darwinResult.captureParts)).toEqual(
        Buffer.from("./cafe\u0301/dirty.ts\0", "utf8"),
      );
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  test("excluded structured records still consume the helper work budget", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-work-budget-"));
    const producer = join(root, "wire-producer.mjs");
    await writeFile(
      producer,
      'process.stdout.write("dirty-one.txt\\0dirty-two.txt\\0clean.txt\\0");\n',
      "utf8",
    );
    const capability = await bindWorkspaceDirectoryReadCapability(root);

    try {
      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [producer],
        env: {},
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
        structuredLineLimit: {
          outputMode: "files_with_matches",
          maximumLines: 1,
          maximumRecordBytes: 1_024,
          maximumWorkUnits: 2,
          excludedPaths: ["dirty-one.txt", "dirty-two.txt"],
        },
      });

      expect(result.killedAfterLimit).toBe(false);
      expect(result.spawnError?.message).toContain("[RESULT_LIMIT]");
      expect(result.stdout).toEqual(Buffer.alloc(0));
    } finally {
      await capability.dispose();
    }
  });

  test("excluded structured bytes still consume the raw wire-output budget", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-wire-budget-"));
    const producer = join(root, "wire-producer.mjs");
    await writeFile(
      producer,
      'process.stdout.write("dirty.txt\\0".repeat(10));\n',
      "utf8",
    );
    const capability = await bindWorkspaceDirectoryReadCapability(root);

    try {
      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [producer],
        env: {},
        timeoutMs: 5_000,
        maxOutputBytes: 10,
        structuredLineLimit: {
          outputMode: "files_with_matches",
          maximumLines: 1,
          maximumRecordBytes: 1_024,
          maximumWorkUnits: 100,
          excludedPaths: ["dirty.txt"],
        },
      });

      expect(result.stopReason).toBe("output_limit");
      expect(result.stdout).toEqual(Buffer.alloc(0));
    } finally {
      await capability.dispose();
    }
  });
});
