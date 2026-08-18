import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __assertCsvOutputSafeSharedDirectoryForTesting,
  __setCsvOutputAfterExactUnlinkCaptureForTesting,
  __setCsvOutputAfterRecoveryReadChunkForTesting,
  __setCsvOutputAfterTargetCaptureForTesting,
  __setCsvOutputAfterTargetAnchorEstablishedForTesting,
  __setCsvOutputAfterTargetPublicationLinkForTesting,
  __setCsvOutputAfterWriterAnchorsReleasedForTesting,
  __setCsvOutputBeforeExactUnlinkCaptureForTesting,
  __setCsvOutputBeforePublicationForTesting,
  __setCsvOutputMissingBirthGenerationForTesting,
  CsvOutputRootCapability,
  createCsvOutputRootCapability,
  recoverCsvOutputIntents,
  writeCsvOutput,
  type CsvOutputIntentStore,
} from "./csv-output.js";
import {
  __csvOutputWindowsAclMasksForTesting,
  __setCsvOutputAfterFirstWriterAnchorForTesting,
  csvOutputWriterAnchorPaths,
  establishCsvOutputWriterAnchorsSync,
} from "./csv-output-writer-anchor.js";

let root: string;

beforeEach(async () => {
  __setCsvOutputAfterExactUnlinkCaptureForTesting(undefined);
  __setCsvOutputAfterRecoveryReadChunkForTesting(undefined);
  __setCsvOutputAfterTargetCaptureForTesting(undefined);
  __setCsvOutputAfterTargetAnchorEstablishedForTesting(undefined);
  __setCsvOutputAfterTargetPublicationLinkForTesting(undefined);
  __setCsvOutputAfterFirstWriterAnchorForTesting(undefined);
  __setCsvOutputAfterWriterAnchorsReleasedForTesting(undefined);
  __setCsvOutputBeforeExactUnlinkCaptureForTesting(undefined);
  __setCsvOutputBeforePublicationForTesting(undefined);
  __setCsvOutputMissingBirthGenerationForTesting(false);
  root = await mkdtemp(join(tmpdir(), "agenc-csv-output-"));
});

afterEach(async () => {
  __setCsvOutputAfterExactUnlinkCaptureForTesting(undefined);
  __setCsvOutputAfterRecoveryReadChunkForTesting(undefined);
  __setCsvOutputAfterTargetCaptureForTesting(undefined);
  __setCsvOutputAfterTargetAnchorEstablishedForTesting(undefined);
  __setCsvOutputAfterTargetPublicationLinkForTesting(undefined);
  __setCsvOutputAfterFirstWriterAnchorForTesting(undefined);
  __setCsvOutputAfterWriterAnchorsReleasedForTesting(undefined);
  __setCsvOutputBeforeExactUnlinkCaptureForTesting(undefined);
  __setCsvOutputBeforePublicationForTesting(undefined);
  __setCsvOutputMissingBirthGenerationForTesting(false);
  await rm(root, { recursive: true, force: true });
});

describe("writeCsvOutput", () => {
  it("trusts sticky writable parents only when owned by this UID or root", () => {
    const currentUid = 501;
    expect(() =>
      __assertCsvOutputSafeSharedDirectoryForTesting({
        mode: 0o1777n,
        ownerUid: BigInt(currentUid + 1),
        currentUid,
      }),
    ).toThrow(/insecurely writable/u);
    expect(() =>
      __assertCsvOutputSafeSharedDirectoryForTesting({
        mode: 0o1777n,
        ownerUid: BigInt(currentUid),
        currentUid,
      }),
    ).not.toThrow();
    expect(() =>
      __assertCsvOutputSafeSharedDirectoryForTesting({
        mode: 0o1777n,
        ownerUid: 0n,
        currentUid,
      }),
    ).not.toThrow();
  });

  it("expands generic Windows rights in read and mutation ACL masks", () => {
    expect(__csvOutputWindowsAclMasksForTesting()).toEqual({
      leafMutation: 0x500d0156,
      ancestorMutation: 0x500d0152,
      inheritedRead: 0x90000001,
    });
  });

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

  it.skipIf(process.platform === "win32")(
    "canonicalizes a root alias without following later alias changes",
    async () => {
      const aliasParent = await mkdtemp(
        join(tmpdir(), "agenc-csv-output-root-alias-"),
      );
      const actualParent = join(aliasParent, "actual-parent");
      const aliasPrefix = join(aliasParent, "alias-prefix");
      const actualRoot = join(actualParent, "root");
      const aliasRoot = join(aliasPrefix, "root");
      try {
        await mkdir(actualRoot, { recursive: true, mode: 0o700 });
        await symlink(actualParent, aliasPrefix, "dir");
        const capability = createCsvOutputRootCapability(aliasRoot);
        const artifact = await writeCsvOutput({
          capability,
          jobId: "root-alias",
          requestedPath: join(aliasRoot, "result.csv"),
          mode: "create_new",
          headers: ["value"],
          rows: [["owned"]],
        });

        expect(artifact.path).toBe(
          join(capability.canonicalRoot, "result.csv"),
        );
        await expect(readFile(artifact.path, "utf8")).resolves.toBe(
          "value\nowned\n",
        );

        const retargetParent = join(aliasParent, "retarget-parent");
        const retargetRoot = join(retargetParent, "root");
        await mkdir(retargetRoot, { recursive: true, mode: 0o700 });
        await unlink(aliasPrefix);
        await symlink(retargetParent, aliasPrefix, "dir");

        const afterRetarget = await writeCsvOutput({
          capability,
          jobId: "retargeted-root-alias",
          requestedPath: join(aliasRoot, "after-retarget.csv"),
          mode: "create_new",
          headers: ["value"],
          rows: [["still-owned"]],
        });
        expect(afterRetarget.path).toBe(
          join(capability.canonicalRoot, "after-retarget.csv"),
        );
        await expect(readFile(afterRetarget.path, "utf8")).resolves.toBe(
          "value\nstill-owned\n",
        );
        await expect(
          readFile(join(retargetRoot, "after-retarget.csv"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(aliasParent, { recursive: true, force: true });
      }
    },
  );

  it("requires durable recovery state before replacing an existing target", async () => {
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
    ).rejects.toThrow(/durable output intent store/u);
    expect(await readFile(target, "utf8")).toBe("prior\n");
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".agenc-csv.tmp")),
    ).toEqual([]);
  });

  it("refuses to overwrite an existing target changed during staging", async () => {
    const target = join(root, "result.csv");
    function* rows(): IterableIterator<ReadonlyArray<string>> {
      writeFileSync(target, "concurrent\n", { mode: 0o600 });
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
    expect(await readFile(target, "utf8")).toBe("concurrent\n");
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

  it("rejects insecure POSIX parent entries and a permissive default directory", async () => {
    if (process.platform === "win32") return;
    const capability = createCsvOutputRootCapability(root);
    await chmod(root, 0o777);
    await expect(
      writeCsvOutput({
        capability,
        jobId: "shared-parent",
        requestedPath: join(root, "shared.csv"),
        headers: ["value"],
        rows: [["owned"]],
      }),
    ).rejects.toThrow(/insecurely writable/u);

    await chmod(root, 0o700);
    const defaultDirectory = join(root, ".agenc-csv-job-output");
    await mkdir(defaultDirectory, { mode: 0o700 });
    await chmod(defaultDirectory, 0o777);
    await expect(
      writeCsvOutput({
        capability,
        jobId: "permissive-default",
        headers: ["value"],
        rows: [["owned"]],
      }),
    ).rejects.toThrow(/not private and owned/u);
  });

  it("rejects a Darwin parent with inheritable mutation ACLs", async () => {
    if (process.platform !== "darwin") return;
    await chmod(root, 0o755);
    execFileSync(
      "/bin/chmod",
      [
        "+a",
        "everyone allow delete_child,add_file,file_inherit,directory_inherit",
        root,
      ],
      { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } },
    );
    try {
      await expect(
        writeCsvOutput({
          capability: createCsvOutputRootCapability(root),
          jobId: "darwin-acl-parent",
          requestedPath: join(root, "output.csv"),
          mode: "create_new",
          headers: ["value"],
          rows: [["owned"]],
        }),
      ).rejects.toThrow(/Darwin CSV path permits ACL mutation/u);
    } finally {
      execFileSync("/bin/chmod", ["-N", root], {
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
    }
  });

  it("rejects a Darwin parent that can inherit a foreign read handle", async () => {
    if (process.platform !== "darwin") return;
    await chmod(root, 0o755);
    execFileSync(
      "/bin/chmod",
      ["+a", "everyone allow read,file_inherit", root],
      { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } },
    );
    try {
      await expect(
        writeCsvOutput({
          capability: createCsvOutputRootCapability(root),
          jobId: "darwin-inherited-read-parent",
          requestedPath: join(root, "output.csv"),
          mode: "create_new",
          headers: ["value"],
          rows: [["secret"]],
        }),
      ).rejects.toThrow(/inherited read/u);
    } finally {
      execFileSync("/bin/chmod", ["-N", root], {
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
    }
  });

  it.each([
    ["generic read", "GR", /inherited read/u],
    ["generic write", "GW", /mutation/u],
    ["generic all", "GA", /inherited read|mutation/u],
  ] as const)(
    "rejects a Windows foreign inherit-only %s ACE before temp creation",
    async (_label, genericRight, expected) => {
      if (process.platform !== "win32") return;
      const baseline = join(root, "windows-acl-baseline.csv");
      await writeCsvOutput({
        capability: createCsvOutputRootCapability(root),
        jobId: "windows-acl-baseline",
        requestedPath: baseline,
        mode: "create_new",
        headers: ["value"],
        rows: [["baseline"]],
      });
      await unlink(baseline);
      execFileSync(
        "icacls.exe",
        [root, "/grant", `*S-1-5-32-545:(OI)(CI)(IO)(${genericRight})`],
        { encoding: "buffer" },
      );
      await expect(
        writeCsvOutput({
          capability: createCsvOutputRootCapability(root),
          jobId: `windows-inherited-${genericRight}`,
          requestedPath: join(root, `windows-inherited-${genericRight}.csv`),
          mode: "create_new",
          headers: ["value"],
          rows: [["secret"]],
        }),
      ).rejects.toThrow(expected);
    },
  );

  it("revalidates the Darwin mutation boundary before recovery filesystem actions", async () => {
    if (process.platform !== "darwin") return;
    await chmod(root, 0o755);
    const capability = createCsvOutputRootCapability(root);
    const temporaryPath = join(root, ".darwin-recovery-acl.agenc-csv.tmp");
    await writeFile(temporaryPath, "private", { mode: 0o600 });
    const stats = await lstat(temporaryPath, { bigint: true });
    const defer = vi.fn();
    const intentStore: CsvOutputIntentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: vi.fn(async () => ({
        intents: [
          {
            intentId: "darwin-recovery-acl-intent",
            ownerGeneration: "darwin-recovery-acl-owner",
            priorState: "abandoned",
            targetPath: join(root, "darwin-recovery-acl.csv"),
            temporaryPath,
            temporaryDev: stats.dev.toString(),
            temporaryIno: stats.ino.toString(),
            temporaryBirthtimeNs: stats.birthtimeNs.toString(),
            writerAnchorState: "ready",
          },
        ],
        hasMore: false,
      })),
      finishCsvOutputIntentRecovery: vi.fn(),
      deferCsvOutputIntentRecovery: defer,
      retireCsvOutputIntentRecovery: vi.fn(),
    };
    execFileSync(
      "/bin/chmod",
      ["+a", "everyone allow read,file_inherit", root],
      { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } },
    );
    try {
      await expect(
        recoverCsvOutputIntents(capability, intentStore),
      ).resolves.toEqual({ recovered: 0, deferred: 1 });
      expect(defer).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringMatching(/inherited read/u),
        }),
      );
      await expect(readFile(temporaryPath, "utf8")).resolves.toBe("private");
    } finally {
      execFileSync("/bin/chmod", ["-N", root], {
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
    }
  });

  it("revalidates the Windows mutation boundary before recovery filesystem actions", async () => {
    if (process.platform !== "win32") return;
    const capability = createCsvOutputRootCapability(root);
    const temporaryPath = join(root, ".windows-recovery-acl.agenc-csv.tmp");
    await writeFile(temporaryPath, "private", { mode: 0o600 });
    const stats = await lstat(temporaryPath, { bigint: true });
    const defer = vi.fn();
    const intentStore: CsvOutputIntentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: vi.fn(async () => ({
        intents: [
          {
            intentId: "windows-recovery-acl-intent",
            ownerGeneration: "windows-recovery-acl-owner",
            priorState: "abandoned",
            targetPath: join(root, "windows-recovery-acl.csv"),
            temporaryPath,
            temporaryDev: stats.dev.toString(),
            temporaryIno: stats.ino.toString(),
            temporaryBirthtimeNs: stats.birthtimeNs.toString(),
            writerAnchorState: "ready",
          },
        ],
        hasMore: false,
      })),
      finishCsvOutputIntentRecovery: vi.fn(),
      deferCsvOutputIntentRecovery: defer,
      retireCsvOutputIntentRecovery: vi.fn(),
    };
    execFileSync(
      "icacls.exe",
      [root, "/grant", "*S-1-5-32-545:(OI)(CI)(IO)(GR)"],
      { encoding: "buffer" },
    );
    await expect(
      recoverCsvOutputIntents(capability, intentStore),
    ).resolves.toEqual({ recovered: 0, deferred: 1 });
    expect(defer).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/inherited read/u),
      }),
    );
    await expect(readFile(temporaryPath, "utf8")).resolves.toBe("private");
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

  it("honors cancellation at the final publication fence", async () => {
    const target = join(root, "abort-at-publication.csv");
    const controller = new AbortController();
    const reason = new Error("abort at publication fence");
    __setCsvOutputBeforePublicationForTesting(() => {
      controller.abort(reason);
    });

    await expect(
      writeCsvOutput({
        capability: createCsvOutputRootCapability(root),
        jobId: "abort-at-publication",
        requestedPath: target,
        headers: ["value"],
        rows: [["owned"]],
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(root)).filter(
        (name) => name.endsWith(".agenc-csv.tmp") || name.endsWith(".capture"),
      ),
    ).toEqual([]);
  });

  it("releases every page claim when cancellation arrives after claim", async () => {
    const controller = new AbortController();
    const reason = new Error("abort immediately after claim");
    const deferred = vi.fn();
    const intents = ["current", "unprocessed"].map((suffix) => ({
      intentId: `post-claim-${suffix}`,
      ownerGeneration: `post-claim-${suffix}-generation`,
      priorState: "abandoned" as const,
      targetPath: join(root, `${suffix}.csv`),
      temporaryPath: join(root, `.${suffix}.agenc-csv.tmp`),
      temporaryDev: "1",
      temporaryIno: "1",
      temporaryBirthtimeNs: "0",
      writerAnchorState: "legacy" as const,
    }));
    const intentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorsReady: vi.fn(),
      markCsvOutputIntentReplacing: vi.fn(),
      markCsvOutputIntentTargetReleasing: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryTargetReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: vi.fn(async () => {
        controller.abort(reason);
        return { intents, hasMore: false };
      }),
      finishCsvOutputIntentRecovery: vi.fn(),
      deferCsvOutputIntentRecovery: deferred,
      retireCsvOutputIntentRecovery: vi.fn(),
    } satisfies CsvOutputIntentStore;

    await expect(
      recoverCsvOutputIntents(
        createCsvOutputRootCapability(root),
        intentStore,
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(deferred).toHaveBeenCalledTimes(2);
    expect(deferred.mock.calls.map(([input]) => input.intentId).sort()).toEqual(
      ["post-claim-current", "post-claim-unprocessed"],
    );
  });

  it("stops a multi-page recovery at the probe abort reason", async () => {
    const controller = new AbortController();
    const abortReason = new Error("recovery probe aborted");
    const claim = vi.fn(async () => {
      controller.abort(abortReason);
      return { intents: [], hasMore: true };
    });
    const intentStore: CsvOutputIntentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: claim,
      finishCsvOutputIntentRecovery: vi.fn(),
      deferCsvOutputIntentRecovery: vi.fn(),
      retireCsvOutputIntentRecovery: vi.fn(),
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
      temporaryBirthtimeNs: stats.birthtimeNs.toString(),
      writerAnchorState: "legacy" as const,
    };
    const claim = vi.fn(async () => ({
      intents: [intent],
      hasMore: false,
    }));
    const intentStore: CsvOutputIntentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: claim,
      finishCsvOutputIntentRecovery: finish,
      deferCsvOutputIntentRecovery: defer,
      retireCsvOutputIntentRecovery: vi.fn(),
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

  it("never authorizes unlink from a matching stat tuple without a durable anchor", async () => {
    const temporaryPath = join(root, ".inode-aba.agenc-csv.tmp");
    await writeFile(temporaryPath, "owned", { mode: 0o600 });
    await unlink(temporaryPath);
    await writeFile(temporaryPath, "unrelated", { mode: 0o600 });
    const replacement = await lstat(temporaryPath, { bigint: true });

    const finish = vi.fn();
    const defer = vi.fn();
    const retire = vi.fn();
    const intentStore: CsvOutputIntentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: vi.fn(async () => ({
        intents: [
          {
            intentId: "inode-aba-intent",
            ownerGeneration: "inode-aba-owner",
            priorState: "abandoned",
            targetPath: join(root, "inode-aba.csv"),
            temporaryPath,
            // Model a coarse filesystem recycling the complete persisted stat
            // tuple. Without a durable anchor, even this apparent match is not
            // destructive authority.
            temporaryDev: replacement.dev.toString(),
            temporaryIno: replacement.ino.toString(),
            temporaryBirthtimeNs: replacement.birthtimeNs.toString(),
            writerAnchorState: "legacy",
          },
        ],
        hasMore: false,
      })),
      finishCsvOutputIntentRecovery: finish,
      deferCsvOutputIntentRecovery: defer,
      retireCsvOutputIntentRecovery: retire,
    };

    await expect(
      recoverCsvOutputIntents(createCsvOutputRootCapability(root), intentStore),
    ).resolves.toEqual({ recovered: 1, deferred: 0 });
    expect(finish).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledOnce();
    await expect(readFile(temporaryPath, "utf8")).resolves.toBe("unrelated");
  });

  it("defers when a ready anchor directory pathname is replaced", async () => {
    const temporaryPath = join(root, ".anchor-dir-swap.agenc-csv.tmp");
    await writeFile(temporaryPath, "owned", { mode: 0o600 });
    const owned = await lstat(temporaryPath, { bigint: true });
    const identity = {
      dev: owned.dev,
      ino: owned.ino,
      birthtimeNs: owned.birthtimeNs,
    };
    const intentId = "anchor-dir-swap-intent";
    const anchors = csvOutputWriterAnchorPaths(
      temporaryPath,
      intentId,
      identity,
    );
    establishCsvOutputWriterAnchorsSync(anchors, temporaryPath, identity);
    const displacedDirectory = `${anchors.directoryPath}.displaced`;
    await rename(anchors.directoryPath, displacedDirectory);
    await mkdir(anchors.directoryPath, { mode: 0o700 });
    const finish = vi.fn();
    const defer = vi.fn();
    const retire = vi.fn();
    const intentStore: CsvOutputIntentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: vi.fn(async () => ({
        intents: [
          {
            intentId,
            ownerGeneration: "anchor-dir-swap-owner",
            priorState: "abandoned",
            targetPath: join(root, "anchor-dir-swap.csv"),
            temporaryPath,
            temporaryDev: owned.dev.toString(),
            temporaryIno: owned.ino.toString(),
            temporaryBirthtimeNs: owned.birthtimeNs.toString(),
            writerAnchorState: "ready",
          },
        ],
        hasMore: false,
      })),
      finishCsvOutputIntentRecovery: finish,
      deferCsvOutputIntentRecovery: defer,
      retireCsvOutputIntentRecovery: retire,
    };

    await expect(
      recoverCsvOutputIntents(createCsvOutputRootCapability(root), intentStore),
    ).resolves.toEqual({ recovered: 0, deferred: 1 });
    expect(finish).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith(
      expect.objectContaining({
        reason:
          "CSV output writer anchor was exhausted before its releasing phase",
      }),
    );
    expect(await readdir(anchors.directoryPath)).toEqual([]);
    expect((await readdir(displacedDirectory)).sort()).toEqual([
      "anchor",
      "authority",
    ]);
    expect((await lstat(temporaryPath, { bigint: true })).nlink).toBe(3n);
  });

  it("captures cleanup before unlinking so a concurrent leaf swap is restored without leaks", async () => {
    const temporaryPath = join(root, ".cleanup-race.agenc-csv.tmp");
    await writeFile(temporaryPath, "owned", { mode: 0o600 });
    const owned = await lstat(temporaryPath, { bigint: true });
    const intentId = "cleanup-race-intent";
    const anchors = csvOutputWriterAnchorPaths(temporaryPath, intentId, owned);
    establishCsvOutputWriterAnchorsSync(anchors, temporaryPath, owned);
    __setCsvOutputBeforeExactUnlinkCaptureForTesting(async (path) => {
      __setCsvOutputBeforeExactUnlinkCaptureForTesting(undefined);
      expect(path).toBe(temporaryPath);
      await unlink(temporaryPath);
      await writeFile(temporaryPath, "concurrent replacement", { mode: 0o600 });
    });

    const finish = vi.fn();
    const defer = vi.fn();
    const retire = vi.fn();
    const intentStore: CsvOutputIntentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: vi.fn(async () => ({
        intents: [
          {
            intentId,
            ownerGeneration: "cleanup-race-owner",
            priorState: "abandoned",
            targetPath: join(root, "cleanup-race.csv"),
            temporaryPath,
            temporaryDev: owned.dev.toString(),
            temporaryIno: owned.ino.toString(),
            temporaryBirthtimeNs: owned.birthtimeNs.toString(),
            writerAnchorState: "ready",
          },
        ],
        hasMore: false,
      })),
      finishCsvOutputIntentRecovery: finish,
      deferCsvOutputIntentRecovery: defer,
      retireCsvOutputIntentRecovery: retire,
    };

    await expect(
      recoverCsvOutputIntents(createCsvOutputRootCapability(root), intentStore),
    ).resolves.toEqual({ recovered: 1, deferred: 0 });
    expect(finish).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledOnce();
    await expect(readFile(temporaryPath, "utf8")).resolves.toBe(
      "concurrent replacement",
    );
    expect((await lstat(temporaryPath, { bigint: true })).nlink).toBe(1n);
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".capture")),
    ).toEqual([]);
  });

  it("uses a fixed-size NAME_MAX-safe cleanup capture basename", async () => {
    let captureDirectory: string | undefined;
    __setCsvOutputAfterExactUnlinkCaptureForTesting((candidatePath) => {
      captureDirectory = dirname(candidatePath);
    });
    const target = join(root, "bounded-capture-name.csv");

    await expect(
      writeCsvOutput({
        capability: createCsvOutputRootCapability(root),
        jobId: "x".repeat(1_024),
        requestedPath: target,
        mode: "create_new",
        headers: ["value"],
        rows: [["one"]],
      }),
    ).resolves.toMatchObject({ path: target });
    expect(captureDirectory).toBeDefined();
    expect(Buffer.byteLength(basename(captureDirectory!), "utf8")).toBe(33);
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".capture")),
    ).toEqual([]);
  });

  it("derives authority from the pinned anchor across a between-links public swap", async () => {
    const temporaryPath = join(root, ".between-links.agenc-csv.tmp");
    await writeFile(temporaryPath, "owned", { mode: 0o600 });
    const owned = await lstat(temporaryPath, { bigint: true });
    const anchors = csvOutputWriterAnchorPaths(
      temporaryPath,
      "between-links-intent",
      owned,
    );
    __setCsvOutputAfterFirstWriterAnchorForTesting(() => {
      __setCsvOutputAfterFirstWriterAnchorForTesting(undefined);
      unlinkSync(temporaryPath);
      writeFileSync(temporaryPath, "unrelated", { mode: 0o600 });
    });

    expect(() =>
      establishCsvOutputWriterAnchorsSync(anchors, temporaryPath, owned),
    ).toThrow(/temporary changed while anchoring/u);
    const anchor = await lstat(anchors.anchorPath, { bigint: true });
    const authority = await lstat(anchors.authorityPath, { bigint: true });
    expect([anchor.dev, anchor.ino]).toEqual([owned.dev, owned.ino]);
    expect([authority.dev, authority.ino]).toEqual([owned.dev, owned.ino]);
    expect(anchor.nlink).toBe(2n);
    expect(authority.nlink).toBe(2n);
    await expect(readFile(temporaryPath, "utf8")).resolves.toBe("unrelated");
    expect((await lstat(temporaryPath, { bigint: true })).nlink).toBe(1n);
  });

  it.each(["create_new"] as const)(
    "publishes only the durable authority when the public temporary is swapped in %s mode",
    async (mode) => {
      const target = join(root, `publication-swap-${mode}.csv`);
      let replacementPath: string | undefined;
      __setCsvOutputBeforePublicationForTesting(async (temporaryPath) => {
        __setCsvOutputBeforePublicationForTesting(undefined);
        await unlink(temporaryPath);
        await writeFile(temporaryPath, "unrelated replacement", {
          mode: 0o600,
        });
        replacementPath = temporaryPath;
      });

      await expect(
        writeCsvOutput({
          capability: createCsvOutputRootCapability(root),
          jobId: `publication-swap-${mode}`,
          requestedPath: target,
          mode,
          headers: ["value"],
          rows: [["owned"]],
        }),
      ).resolves.toMatchObject({ path: target });
      expect(await readFile(target, "utf8")).toBe("value\nowned\n");
      expect(replacementPath).toBeDefined();
      expect(await readFile(replacementPath!, "utf8")).toBe(
        "unrelated replacement",
      );
      expect((await lstat(replacementPath!, { bigint: true })).nlink).toBe(1n);
      expect(
        (await readdir(root)).filter((name) => name.endsWith(".capture")),
      ).toEqual([]);
    },
  );

  it("retires a legacy intent with no birth generation without touching its file", async () => {
    const temporaryPath = join(root, ".no-birthtime.agenc-csv.tmp");
    await writeFile(temporaryPath, "legacy", { mode: 0o600 });
    const stats = await lstat(temporaryPath, { bigint: true });
    const finish = vi.fn();
    const defer = vi.fn();
    const retire = vi.fn();
    const intentStore: CsvOutputIntentStore = {
      reserveCsvOutputIntent: vi.fn(),
      attachCsvOutputIntentWriter: vi.fn(),
      markCsvOutputIntentAnchorReleasing: vi.fn(),
      markCsvOutputIntentRecoveryAnchorReleasing: vi.fn(),
      markCsvOutputIntentFlushed: vi.fn(),
      markCsvOutputIntentPublished: vi.fn(),
      completeCsvOutputIntent: vi.fn(),
      abandonCsvOutputIntent: vi.fn(),
      claimCsvOutputRecoveryIntents: vi.fn(async () => ({
        intents: [
          {
            intentId: "no-birthtime-intent",
            ownerGeneration: "no-birthtime-owner",
            priorState: "abandoned",
            targetPath: `${root}/nested/../no-birthtime.csv`,
            temporaryPath,
            temporaryDev: stats.dev.toString(),
            temporaryIno: stats.ino.toString(),
            temporaryBirthtimeNs: null,
            writerAnchorState: "legacy",
          },
        ],
        hasMore: false,
      })),
      finishCsvOutputIntentRecovery: finish,
      deferCsvOutputIntentRecovery: defer,
      retireCsvOutputIntentRecovery: retire,
    };

    await expect(
      recoverCsvOutputIntents(createCsvOutputRootCapability(root), intentStore),
    ).resolves.toEqual({ recovered: 1, deferred: 0 });
    expect(finish).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledWith({
      intentId: "no-birthtime-intent",
      ownerGeneration: "no-birthtime-owner",
      reason:
        "CSV output durable writer anchor proof is unavailable for a legacy identity; filesystem paths retained",
    });
    expect(defer).not.toHaveBeenCalled();
    await expect(readFile(temporaryPath, "utf8")).resolves.toBe("legacy");
  });

  it("publishes through its durable anchor when birth time is unavailable", async () => {
    __setCsvOutputMissingBirthGenerationForTesting(true);
    const target = join(root, "missing-birth-generation.csv");
    await expect(
      writeCsvOutput({
        capability: createCsvOutputRootCapability(root),
        jobId: "missing-birth-generation",
        requestedPath: target,
        mode: "create_new",
        headers: ["value"],
        rows: [["one"]],
      }),
    ).resolves.toMatchObject({ path: target });
    await expect(readFile(target, "utf8")).resolves.toBe("value\none\n");
    expect(
      (await readdir(root)).filter(
        (name) => name.endsWith(".agenc-csv.tmp") || name.endsWith(".capture"),
      ),
    ).toEqual([]);
  });
});
