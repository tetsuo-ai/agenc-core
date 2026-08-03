import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvAgentJobsRepositoryAuthority } from "../../src/app-server/csv-agent-jobs-authority.js";
import type { CsvAgentJobsRepository } from "../../src/state/csv-agent-jobs.js";
import type {
  StateDatabasePaths,
  StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CsvAgentJobsRepositoryAuthority", () => {
  it("shares one canonical database open when one alias waiter aborts", async () => {
    const root = await workspace("authority-alias-");
    const alias = `${root}-alias`;
    await symlink(root, alias, "dir");
    created.push(alias);
    const opened = deferred<CsvAgentJobsRepository>();
    const close = vi.fn();
    const openRepository = vi.fn(() => opened.promise);
    const authority = authorityWith({ close, openRepository });
    const firstAbort = new AbortController();
    const first = authority.withRepository(root, () => "first", {
      signal: firstAbort.signal,
    });
    const second = authority.withRepository(alias, () => "second");

    await vi.waitFor(() => expect(openRepository).toHaveBeenCalledOnce());
    const reason = new Error("first waiter cancelled");
    firstAbort.abort(reason);
    opened.resolve({} as CsvAgentJobsRepository);

    await expect(first).rejects.toBe(reason);
    await expect(second).resolves.toBe("second");
    expect(openRepository).toHaveBeenCalledOnce();
    await authority.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("abandons a sole cancelled open and permits a clean retry", async () => {
    const root = await workspace("authority-sole-abort-");
    const close = vi.fn();
    let openAttempt = 0;
    const authority = authorityWith({
      close,
      openRepository: async (_driver, { signal }) => {
        const attempt = openAttempt++;
        if (attempt === 0) await aborted(signal);
        else expect(close).toHaveBeenCalledOnce();
        return {} as CsvAgentJobsRepository;
      },
    });
    const controller = new AbortController();
    const cancelled = authority.withRepository(root, () => "unreachable", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(openAttempt).toBe(1));
    controller.abort(new Error("sole waiter cancelled"));
    await expect(cancelled).rejects.toThrow("sole waiter cancelled");

    await expect(authority.withRepository(root, () => "retried")).resolves.toBe(
      "retried",
    );
    expect(openAttempt).toBe(2);
    await authority.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("evicts a failed open instead of poisoning later access", async () => {
    const root = await workspace("authority-open-failure-");
    const close = vi.fn();
    const openRepository = vi
      .fn()
      .mockRejectedValueOnce(new Error("open failed"))
      .mockResolvedValue({} as CsvAgentJobsRepository);
    const authority = authorityWith({ close, openRepository });

    await expect(authority.withRepository(root, () => "first")).rejects.toThrow(
      "open failed",
    );
    await expect(authority.withRepository(root, () => "second")).resolves.toBe(
      "second",
    );
    expect(openRepository).toHaveBeenCalledTimes(2);
    await authority.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("delivers a synchronous driver-open failure to the queued caller", async () => {
    const root = await workspace("authority-sync-open-failure-");
    const openError = new Error("driver open failed synchronously");
    const closeDriver = vi.fn();
    let attempts = 0;
    const authority = new CsvAgentJobsRepositoryAuthority({
      resolvePaths: fakePaths,
      openDriver: (paths) => {
        attempts += 1;
        if (attempts === 1) throw openError;
        return {
          ...paths,
          close: closeDriver,
        } as unknown as StateSqliteDriver;
      },
      openRepository: async () => ({}) as CsvAgentJobsRepository,
    });

    await expect(
      authority.withRepository(root, () => "unreachable"),
    ).rejects.toBe(openError);
    expect(attempts).toBe(1);
    await expect(authority.withRepository(root, () => "retried")).resolves.toBe(
      "retried",
    );
    expect(attempts).toBe(2);
    await authority.close();
    expect(closeDriver).toHaveBeenCalledOnce();
  });

  it("allows nested inspect and read leases while a long lease remains active", async () => {
    const root = await workspace("authority-nested-leases-");
    const authority = authorityWith({ close: vi.fn() });
    const releaseOuter = deferred<void>();
    const nestedResults = deferred<readonly string[]>();
    const outer = authority.withRepository(root, async () => {
      const results = await Promise.all([
        authority.withRepository(root, () => "inspect"),
        authority.withRepository(root, () => "read"),
      ]);
      nestedResults.resolve(results);
      await releaseOuter.promise;
    });

    try {
      await expect(settleBeforeDeadline(nestedResults.promise)).resolves.toEqual(
        ["inspect", "read"],
      );
    } finally {
      releaseOuter.resolve();
      const closing = authority.close();
      await Promise.allSettled([outer, closing]);
    }
  });

  it("cancels one active sibling lease without blocking another", async () => {
    const root = await workspace("authority-sibling-abort-");
    const authority = authorityWith({ close: vi.fn() });
    const releaseLongLease = deferred<void>();
    const longLeaseStarted = deferred<void>();
    const siblingStarted = deferred<void>();
    const longLease = authority.withRepository(root, async () => {
      longLeaseStarted.resolve();
      await releaseLongLease.promise;
    });
    await longLeaseStarted.promise;
    const siblingAbort = new AbortController();
    const sibling = authority.withRepository(
      root,
      async (_repository, signal) => {
        siblingStarted.resolve();
        await aborted(signal);
      },
      { signal: siblingAbort.signal },
    );
    const reason = new Error("cancel only the sibling");

    try {
      await expect(settleBeforeDeadline(siblingStarted.promise)).resolves.toBe(
        undefined,
      );
      siblingAbort.abort(reason);
      await expect(sibling).rejects.toBe(reason);
      releaseLongLease.resolve();
      await expect(longLease).resolves.toBeUndefined();
    } finally {
      siblingAbort.abort(reason);
      releaseLongLease.resolve();
      const closing = authority.close();
      await Promise.allSettled([longLease, sibling, closing]);
    }
  });

  it("aborts and drains every active sibling before one idempotent close", async () => {
    const root = await workspace("authority-active-close-");
    const closeDriver = vi.fn();
    const authority = authorityWith({ close: closeDriver });
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstAborted = deferred<void>();
    const secondAborted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const activeLease = (
      started: Deferred<void>,
      observedAbort: Deferred<void>,
      release: Deferred<void>,
    ) =>
      authority.withRepository(root, async (_repository, signal) => {
        started.resolve();
        signal.addEventListener("abort", () => observedAbort.resolve(), {
          once: true,
        });
        await release.promise;
        signal.throwIfAborted();
      });
    const first = activeLease(firstStarted, firstAborted, releaseFirst);
    const second = activeLease(secondStarted, secondAborted, releaseSecond);

    try {
      await expect(
        settleBeforeDeadline(
          Promise.all([firstStarted.promise, secondStarted.promise]),
        ),
      ).resolves.toEqual([undefined, undefined]);
      const firstClose = authority.close();
      const secondClose = authority.close();
      expect(secondClose).toBe(firstClose);
      await expect(
        settleBeforeDeadline(
          Promise.all([firstAborted.promise, secondAborted.promise]),
        ),
      ).resolves.toEqual([undefined, undefined]);
      expect(closeDriver).not.toHaveBeenCalled();
      releaseFirst.resolve();
      releaseSecond.resolve();
      await expect(first).rejects.toThrow(/authority is closed/u);
      await expect(second).rejects.toThrow(/authority is closed/u);
      await expect(
        authority.withRepository(root, () => "late"),
      ).rejects.toThrow(/authority is closed/u);
      await firstClose;
      expect(closeDriver).toHaveBeenCalledOnce();
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      const closing = authority.close();
      await Promise.allSettled([first, second, closing]);
    }
  });

  it("aborts and closes a driver whose repository is still opening", async () => {
    const root = await workspace("authority-opening-close-");
    const closeDriver = vi.fn();
    const started = deferred<void>();
    const authority = authorityWith({
      close: closeDriver,
      openRepository: async (_driver, { signal }) => {
        started.resolve();
        await aborted(signal);
        return {} as CsvAgentJobsRepository;
      },
    });
    const pending = authority.withRepository(root, () => "unreachable");
    await started.promise;
    const closing = authority.close();
    await expect(pending).rejects.toThrow(/authority is closed/u);
    await closing;
    expect(closeDriver).toHaveBeenCalledOnce();
  });

  it("rejects a close that lands after entry resolution but before enqueue", async () => {
    const root = await workspace("authority-close-before-enqueue-");
    const resolvedPaths = deferred<void>();
    const operation = vi.fn();
    const authority = authorityWith({
      close: vi.fn(),
      resolvePaths: (cwd) => {
        resolvedPaths.resolve();
        return fakePaths(cwd);
      },
    });
    const pending = authority.withRepository(root, operation);
    await resolvedPaths.promise;

    const closing = authority.close();

    await expect(pending).rejects.toThrow(/authority is closed/u);
    await closing;
    expect(operation).not.toHaveBeenCalled();
  });

  it("abandons an opener when the queued caller signal aborts", async () => {
    const root = await workspace("authority-abort-before-enqueue-");
    const closeDriver = vi.fn();
    const controller = new AbortController();
    const reason = new Error("caller aborted before enqueue");
    const authority = authorityWith({
      close: closeDriver,
      openRepository: async (_driver, { signal }) => {
        controller.abort(reason);
        await aborted(signal);
        return {} as CsvAgentJobsRepository;
      },
    });

    await expect(
      authority.withRepository(root, () => "unreachable", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await vi.waitFor(() => expect(closeDriver).toHaveBeenCalledOnce());
    await authority.close();
  });

  it("rejects a signal aborted during path resolution without opening", async () => {
    const root = await workspace("authority-abort-during-resolution-");
    const controller = new AbortController();
    const reason = new Error("caller aborted during path resolution");
    const openRepository = vi.fn(async () => ({}) as CsvAgentJobsRepository);
    const authority = authorityWith({
      close: vi.fn(),
      resolvePaths: (cwd) => {
        controller.abort(reason);
        return fakePaths(cwd);
      },
      openRepository,
    });

    await expect(
      authority.withRepository(root, () => "unreachable", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(openRepository).not.toHaveBeenCalled();
    await authority.close();
  });

  it("publishes one close promise before re-entrant abort listeners run", async () => {
    const root = await workspace("authority-reentrant-close-");
    const authority = authorityWith({ close: vi.fn() });
    const started = deferred<void>();
    let reentrantClose: Promise<void> | undefined;
    const active = authority.withRepository(
      root,
      async (_repository, signal) => {
        signal.addEventListener(
          "abort",
          () => {
            reentrantClose = authority.close();
          },
          { once: true },
        );
        started.resolve();
        await aborted(signal);
      },
    );
    await started.promise;

    const closing = authority.close();

    expect(reentrantClose).toBe(closing);
    await expect(active).rejects.toThrow(/authority is closed/u);
    await closing;
  });

  it("attempts every driver close and exposes a stable aggregate failure", async () => {
    const firstRoot = await workspace("authority-close-first-");
    const secondRoot = await workspace("authority-close-second-");
    const firstError = new Error("first driver close failed");
    const firstClose = vi.fn(() => {
      throw firstError;
    });
    const secondClose = vi.fn();
    const authority = new CsvAgentJobsRepositoryAuthority({
      resolvePaths: fakePaths,
      openDriver: (paths) =>
        ({
          ...paths,
          close: paths.projectDir === firstRoot ? firstClose : secondClose,
        }) as unknown as StateSqliteDriver,
      openRepository: async () => ({}) as CsvAgentJobsRepository,
    });
    await authority.withRepository(firstRoot, () => undefined);
    await authority.withRepository(secondRoot, () => undefined);

    const closing = authority.close();

    await expect(closing).rejects.toThrow(
      /one or more CSV agent jobs database drivers failed to close/u,
    );
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(authority.close()).toBe(closing);
    const repeatedError = await authority.close().catch((error) => error);
    expect(repeatedError).toBeInstanceOf(AggregateError);
    expect((repeatedError as AggregateError).errors).toContain(firstError);
    expect(firstClose).toHaveBeenCalledOnce();
  });
});

async function workspace(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

function authorityWith(options: {
  readonly close: () => void;
  readonly openRepository?: (
    driver: StateSqliteDriver,
    options: { readonly signal: AbortSignal },
  ) => Promise<CsvAgentJobsRepository>;
  readonly resolvePaths?: (cwd: string) => StateDatabasePaths;
}): CsvAgentJobsRepositoryAuthority {
  return new CsvAgentJobsRepositoryAuthority({
    resolvePaths: options.resolvePaths ?? fakePaths,
    openDriver: (paths) =>
      ({ ...paths, close: options.close }) as unknown as StateSqliteDriver,
    openRepository:
      options.openRepository ?? (async () => ({}) as CsvAgentJobsRepository),
  });
}

function fakePaths(cwd: string): StateDatabasePaths {
  return {
    projectDir: cwd,
    stateDbPath: join(cwd, "state.sqlite"),
    logsDbPath: join(cwd, "logs.sqlite"),
  };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function settleBeforeDeadline<Value>(
  promise: Promise<Value>,
): Promise<Value | symbol> {
  const deadlineExceeded = Symbol("deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof deadlineExceeded>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(deadlineExceeded), 1_000);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted();
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}
