import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import {
  backfillPinnedRolloutFile,
  backfillRolloutFile,
  withPreparedPinnedRolloutRun,
} from "./backfill.js";
import {
  CanonicalJournalIntegrityError,
  DEFAULT_MAX_RECOVERY_EVENTS_PER_RUN,
  DEFAULT_MAX_RECOVERY_LINE_BYTES,
  DEFAULT_MAX_RECOVERY_SOURCE_BYTES,
  DEFAULT_MAX_STARTUP_RECOVERY_BYTES,
  DEFAULT_MAX_STARTUP_RECOVERY_MS,
  MAX_RECOVERY_CANONICAL_LINE_BYTES,
  MAX_RECOVERY_PINNED_DESCRIPTORS,
  MAX_RECOVERY_SOURCES_PER_RUN,
  RecoveryOperationalError,
} from "./recovery-contract.js";
import {
  RecoveryDescriptorBudget,
  DiskCanonicalIdentityRegistry,
  recoveryFileLimits,
  recoveryFailureSourcePath,
  withPinnedCanonicalJournalRun,
} from "./recovery-file.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("descriptor-pinned canonical recovery", () => {
  it("removes a partial identity registry when SQLite initialization fails", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-identity-init-failure-"));
    temporaryRoots.push(root);
    const pragmaSpy = vi
      .spyOn(Database.prototype, "pragma")
      .mockImplementation(() => {
        throw new Error("injected identity registry initialization failure");
      });
    try {
      expect(() => new DiskCanonicalIdentityRegistry(root)).toThrow(
        "injected identity registry initialization failure",
      );
    } finally {
      pragmaSpy.mockRestore();
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it("freezes conservative defaults separately from hard override ceilings", () => {
    expect(recoveryFileLimits()).toMatchObject({
      maxLineBytes: DEFAULT_MAX_RECOVERY_LINE_BYTES,
      maxSourceBytes: DEFAULT_MAX_RECOVERY_SOURCE_BYTES,
      maxEvents: DEFAULT_MAX_RECOVERY_EVENTS_PER_RUN,
      maxScanMilliseconds: DEFAULT_MAX_STARTUP_RECOVERY_MS,
      maxReadBytes: DEFAULT_MAX_STARTUP_RECOVERY_BYTES,
    });
    expect(DEFAULT_MAX_RECOVERY_LINE_BYTES).toBe(4_194_304);
    expect(DEFAULT_MAX_RECOVERY_SOURCE_BYTES).toBe(67_108_864);
    expect(DEFAULT_MAX_RECOVERY_EVENTS_PER_RUN).toBe(1_000_000);
    expect(DEFAULT_MAX_STARTUP_RECOVERY_BYTES).toBe(1_073_741_824);
    expect(DEFAULT_MAX_STARTUP_RECOVERY_MS).toBe(30_000);
    expect(MAX_RECOVERY_SOURCES_PER_RUN).toBe(32);
    expect(MAX_RECOVERY_PINNED_DESCRIPTORS).toBe(129);
  });

  it("validates first and streams an anchored replay into one projection transaction", () => {
    const fixture = createFixture(event(1) + event(2));
    try {
      const result = project(fixture);

      expect(result.itemsIndexed).toBe(2);
      expect(result.proof).toMatchObject({
        recordCount: 2,
        eventCount: 2,
        format: "sequenced_v1",
        digestAnchored: true,
      });
      expect(Object.hasOwn(result.proof, "records")).toBe(false);
      expect(projectedRows(fixture.driver)).toBe(2);
      expect(
        new StateThreadRepository(fixture.driver).getBackfillFile(
          fixture.rolloutPath,
        ),
      ).toMatchObject({
        itemCount: 2,
        sha256: result.proof.sourceSha256,
        size: Buffer.byteLength(event(1) + event(2)),
      });
    } finally {
      fixture.driver.close();
    }
  });

  it("validates every source before one run transaction and rolls all sources back", () => {
    const fixture = createFixture(event(1));
    const second = addSource(fixture, "recovery-second", event(1, "second"));
    try {
      fixture.driver.state.exec(
        `CREATE TEMP TRIGGER reject_second_recovery_source
         BEFORE INSERT ON main.thread_rollout_items
         WHEN NEW.source_path = ${sqlString(second.rolloutPath)}
         BEGIN
           SELECT RAISE(ABORT, 'reject second recovery source');
         END`,
      );
      expect(() => projectRun(fixture, [fixture, second])).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "projection_failure",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("aggregates actual two-pass bytes and validated events across a run", () => {
    const firstRaw = event(1);
    const secondRaw = event(1, "second");
    const fixture = createFixture(firstRaw);
    const second = addSource(fixture, "recovery-budget", secondRaw);
    try {
      expect(() =>
        projectRun(fixture, [fixture, second], {
          maxReadBytes:
            2 * (Buffer.byteLength(firstRaw) + Buffer.byteLength(secondRaw)) - 1,
        }),
      ).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "startup_byte_budget",
        }),
      );
      expect(() =>
        projectRun(fixture, [fixture, second], { maxEvents: 1 }),
      ).toThrow(
        expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
          reasonCode: "event_limit",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("accepts the aggregate event boundary and rejects the next event before projection", () => {
    const boundary = createFixture(event(1, "boundary:first"));
    const boundarySecond = addSource(
      boundary,
      "recovery-boundary-second",
      event(1, "boundary:second"),
    );
    try {
      expect(
        projectRun(boundary, [boundarySecond, boundary], { maxEvents: 2 }),
      ).toHaveLength(2);
      expect(projectedRows(boundary.driver)).toBe(2);
    } finally {
      boundary.driver.close();
    }

    const overflow = createFixture(event(1, "overflow:first"));
    const overflowSecond = addSource(
      overflow,
      "recovery-overflow-second",
      event(1, "overflow:second") + event(2, "overflow:third"),
    );
    try {
      expect(() =>
        projectRun(overflow, [overflowSecond, overflow], { maxEvents: 2 }),
      ).toThrow(
        expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
          reasonCode: "event_limit",
          facts: expect.objectContaining({ lineNumber: 2 }),
        }),
      );
      expect(projectedRows(overflow.driver)).toBe(0);
    } finally {
      overflow.driver.close();
    }
  });

  it("rejects cross-source event identities before the projection transaction", () => {
    const fixture = createFixture(event(1, "shared-event-identity"));
    const second = addSource(
      fixture,
      "recovery-duplicate-identity",
      event(1, "shared-event-identity"),
    );
    try {
      expect(() => projectRun(fixture, [fixture, second])).toThrow(
        expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
          reasonCode: "identity_conflict",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("rejects cross-source terminal identities before the projection transaction", () => {
    const fixture = createFixture(
      terminalEvent("terminal:first", "shared-terminal-run"),
    );
    const second = addSource(
      fixture,
      "recovery-duplicate-terminal",
      terminalEvent("terminal:second", "shared-terminal-run"),
    );
    try {
      expect(() => projectRun(fixture, [fixture, second])).toThrow(
        expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
          reasonCode: "duplicate_terminal",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("canonical-sorts sources before opening and validating them", () => {
    const fixture = createFixture(event(1, "sorted:z"));
    const first = addSource(
      fixture,
      "aaa-recovery-source",
      event(1, "sorted:a"),
    );
    const observed: string[] = [];
    try {
      projectRun(fixture, [
        {
          ...fixture,
          afterValidationPass: () => observed.push(fixture.rolloutPath),
        },
        {
          ...first,
          afterValidationPass: () => observed.push(first.rolloutPath),
        },
      ]);
      expect(observed).toEqual(
        [fixture.rolloutPath, first.rolloutPath].sort(comparePaths),
      );
    } finally {
      fixture.driver.close();
    }
  });

  it("rejects duplicate canonical source paths before filesystem I/O", () => {
    const fixture = createFixture(event(1));
    const displacedPath = `${fixture.rolloutPath}.displaced`;
    renameSync(fixture.rolloutPath, displacedPath);
    try {
      expect(() => projectRun(fixture, [fixture, fixture])).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "concurrency_limit",
          errorClass: "RECOVERY_DUPLICATE_SOURCE_PATH",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("pins and projects exactly 32 canonically sorted sources", () => {
    const fixture = createFixture(event(1, "source:00"));
    const sources: RecoverySourceFixture[] = [fixture];
    for (let index = 1; index < MAX_RECOVERY_SOURCES_PER_RUN; index += 1) {
      sources.push(
        addSource(
          fixture,
          `recovery-source-${String(index).padStart(2, "0")}`,
          event(1, `source:${String(index).padStart(2, "0")}`),
        ),
      );
    }
    try {
      expect(projectRun(fixture, sources.reverse())).toHaveLength(32);
      expect(projectedRows(fixture.driver)).toBe(32);
    } finally {
      fixture.driver.close();
    }
  });

  it("rejects a recovery run before I/O when it exceeds 32 sources", () => {
    const fixture = createFixture(event(1));
    const displacedPath = `${fixture.rolloutPath}.displaced`;
    renameSync(fixture.rolloutPath, displacedPath);
    try {
      expect(() =>
        projectRun(
          fixture,
          Array.from({ length: 33 }, () => fixture),
        ),
      ).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "concurrency_limit",
          errorClass: "RECOVERY_SOURCE_LIMIT",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it.each([
    {
      name: "line bytes",
      raw: event(1, "event:1", "x".repeat(256)),
      limits: { maxLineBytes: 128 },
      reasonCode: "line_byte_limit",
    },
    {
      name: "source bytes",
      raw: event(1),
      limits: { maxSourceBytes: 32 },
      reasonCode: "source_byte_limit",
    },
    {
      name: "event count",
      raw: event(1) + event(2),
      limits: { maxEvents: 1 },
      reasonCode: "event_limit",
    },
  ] as const)(
    "rejects the $name ceiling before projecting rows",
    (testCase) => {
      const fixture = createFixture(testCase.raw);
      try {
        expect(() => project(fixture, { limits: testCase.limits })).toThrow(
          expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
            reasonCode: testCase.reasonCode,
          }),
        );
        expect(projectedRows(fixture.driver)).toBe(0);
      } finally {
        fixture.driver.close();
      }
    },
  );

  it("keeps aggregate byte, time, and descriptor pressure operational", () => {
    const raw = event(1);
    const byteFixture = createFixture(raw);
    try {
      expect(() =>
        project(byteFixture, {
          limits: { maxReadBytes: Buffer.byteLength(raw) * 2 - 1 },
        }),
      ).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "startup_byte_budget",
        }),
      );
      expect(projectedRows(byteFixture.driver)).toBe(0);
    } finally {
      byteFixture.driver.close();
    }

    const timeFixture = createFixture(raw);
    let tick = 0;
    try {
      expect(() =>
        project(timeFixture, {
          limits: { maxScanMilliseconds: 1 },
          nowMilliseconds: () => tick++,
        }),
      ).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "startup_time_budget",
        }),
      );
      expect(projectedRows(timeFixture.driver)).toBe(0);
    } finally {
      timeFixture.driver.close();
    }

    const descriptorFixture = createFixture(raw);
    try {
      expect(() =>
        project(descriptorFixture, {
          descriptorBudget: new RecoveryDescriptorBudget(4),
        }),
      ).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "descriptor_limit",
        }),
      );
      expect(projectedRows(descriptorFixture.driver)).toBe(0);
    } finally {
      descriptorFixture.driver.close();
    }
    expect(() => new RecoveryDescriptorBudget(130)).toThrow(/\[1, 129\]/);
  });

  it("rejects a pathname replacement between passes with zero projection", () => {
    const fixture = createFixture(event(1));
    const originalPath = `${fixture.rolloutPath}.original`;
    try {
      expect(() =>
        project(fixture, {
          afterValidationPass: () => {
            renameSync(fixture.rolloutPath, originalPath);
            writeFileSync(fixture.rolloutPath, event(1, "replacement"));
          },
        }),
      ).toThrow(
        expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
          reasonCode: "source_changed",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("defers a source whose session lease is live", () => {
    const fixture = createFixture(event(1));
    writeFileSync(
      `${fixture.rolloutPath}.lock`,
      `${JSON.stringify({
        pid: process.pid,
        startNs: "independent-live-owner",
        acquiredAtIso: "2026-08-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    try {
      expect(() => project(fixture)).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "source_not_quiescent",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("uses disk-backed identity claims for non-reserved event ids", () => {
    const fixture = createFixture(
      event(1, "custom-event") + event(2, "custom-event"),
    );
    try {
      expect(() => project(fixture)).toThrow(
        expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
          reasonCode: "identity_conflict",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("maps shared identity-registry close failures to the canonical first source and preserves both errors", () => {
    const fixture = createFixture(event(1));
    const canonicalFirst = addSource(
      fixture,
      "aaa-registry-source",
      event(1, "registry:first"),
    );
    const validationError = new Error("injected identity validation failure");
    const closeError = Object.assign(
      new Error("injected identity registry close failure"),
      { code: "SQLITE_IOERR_CLOSE" },
    );
    let operationCalled = false;
    let caught: unknown;
    try {
      withPinnedCanonicalJournalRun(
        {
          sources: [
            {
              projectDir: fixture.projectDir,
              sessionId: fixture.sessionId,
              sourcePath: fixture.rolloutPath,
            },
            {
              projectDir: fixture.projectDir,
              sessionId: canonicalFirst.sessionId,
              sourcePath: canonicalFirst.rolloutPath,
            },
          ],
          createIdentityRegistry: () => ({
            claimEventId: () => {
              throw validationError;
            },
            claimTerminalKey: () => true,
            close: () => {
              throw closeError;
            },
          }),
        },
        () => {
          operationCalled = true;
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      fixture.driver.close();
    }

    expect(operationCalled).toBe(false);
    expect(caught).toMatchObject<Partial<RecoveryOperationalError>>({
      reasonCode: "database_io",
      errorClass: "SQLITE_IOERR_CLOSE",
    });
    expect(recoveryFailureSourcePath(caught)).toBe(canonicalFirst.rolloutPath);
    const aggregate = (caught as Error & { cause?: unknown }).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors[0]).toBe(validationError);
    expect(
      ((aggregate as AggregateError).errors[1] as Error & { cause?: unknown })
        .cause,
    ).toBe(closeError);
  });

  it("classifies a rolled-back SQLite projection rejection as operational", () => {
    const fixture = createFixture(event(1));
    try {
      fixture.driver.state.exec(
        `CREATE TEMP TRIGGER reject_recovery_projection
         BEFORE INSERT ON main.thread_rollout_items
         BEGIN
           SELECT RAISE(ABORT, 'injected projection failure');
         END`,
      );
      expect(() => project(fixture)).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "projection_failure",
        }),
      );
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });

  it("projects a large journal without exposing or retaining a record array", () => {
    const recordCount = 10_000;
    const raw = Array.from({ length: recordCount }, (_, index) =>
      event(index + 1),
    ).join("");
    const fixture = createFixture(raw);
    try {
      const result = project(fixture);
      expect(result.proof.recordCount).toBe(recordCount);
      expect(Object.hasOwn(result.proof, "records")).toBe(false);
      expect(projectedRows(fixture.driver)).toBe(recordCount);
    } finally {
      fixture.driver.close();
    }
  });

  it("keeps the frozen tolerant-path line-limit probe fail-closed", () => {
    const fixture = createFixture(
      event(1, "event:1", "x".repeat(MAX_RECOVERY_CANONICAL_LINE_BYTES)),
    );
    try {
      expect(() =>
        backfillRolloutFile({
          rolloutPath: fixture.rolloutPath,
          threads: new StateThreadRepository(fixture.driver),
        }),
      ).toThrow(expect.objectContaining({ reasonCode: "line_limit" }));
      expect(projectedRows(fixture.driver)).toBe(0);
    } finally {
      fixture.driver.close();
    }
  });
});

interface Fixture {
  readonly root: string;
  readonly projectDir: string;
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly driver: StateSqliteDriver;
}

interface RecoverySourceFixture {
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly afterValidationPass?: () => void;
}

function createFixture(raw: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agenc-recovery-file-"));
  temporaryRoots.push(root);
  const cwd = join(root, "repository");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const driver = openStateDatabases({
    cwd,
    agencHome: join(root, "state"),
  });
  const sessionId = "recovery-file";
  const sessionDirectory = join(driver.projectDir, "sessions", sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const rolloutPath = join(
    sessionDirectory,
    `rollout-2026-08-01T00-00-00-000Z-${sessionId}.jsonl`,
  );
  writeFileSync(rolloutPath, raw, { mode: 0o600 });
  return {
    root,
    projectDir: driver.projectDir,
    sessionId,
    rolloutPath,
    driver,
  };
}

function addSource(
  fixture: Fixture,
  sessionId: string,
  raw: string,
): RecoverySourceFixture {
  const sessionDirectory = join(fixture.projectDir, "sessions", sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const rolloutPath = join(
    sessionDirectory,
    `rollout-2026-08-01T00-00-00-000Z-${sessionId}.jsonl`,
  );
  writeFileSync(rolloutPath, raw, { mode: 0o600 });
  return { sessionId, rolloutPath };
}

function projectRun(
  fixture: Fixture,
  sources: readonly RecoverySourceFixture[],
  limits?: Parameters<typeof withPreparedPinnedRolloutRun>[0]["limits"],
) {
  return withPreparedPinnedRolloutRun(
    {
      projectDir: fixture.projectDir,
      sources: sources.map((source) => ({
        sessionId: source.sessionId,
        rolloutPath: source.rolloutPath,
        ...(source.afterValidationPass === undefined
          ? {}
          : { afterValidationPass: source.afterValidationPass }),
      })),
      threads: new StateThreadRepository(fixture.driver),
      ...(limits === undefined ? {} : { limits }),
    },
    (prepared) =>
      fixture.driver.transactionImmediate(() => {
        const result = prepared.projectAll();
        prepared.assertPinned();
        return result;
      }),
  );
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function project(
  fixture: Fixture,
  options: Partial<
    Pick<
      Parameters<typeof backfillPinnedRolloutFile>[0],
      "limits" | "descriptorBudget" | "nowMilliseconds" | "afterValidationPass"
    >
  > = {},
) {
  return backfillPinnedRolloutFile({
    projectDir: fixture.projectDir,
    sessionId: fixture.sessionId,
    rolloutPath: fixture.rolloutPath,
    threads: new StateThreadRepository(fixture.driver),
    ...options,
  });
}

function projectedRows(driver: StateSqliteDriver): number {
  return (
    driver
      .prepareState<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM thread_rollout_items",
      )
      .get()?.count ?? -1
  );
}

function event(
  sequence: number,
  eventId = `event:${sequence}`,
  content = "content",
): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      eventId,
      id: `envelope-${sequence}`,
      seq: sequence,
      msg: {
        type: "turn_started",
        payload: { turnId: "turn-1", content },
      },
    },
    eventVersion: 1,
  })}\n`;
}

function terminalEvent(eventId: string, runId: string): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      eventId,
      id: `${eventId}:envelope`,
      seq: 1,
      msg: {
        type: "run_terminal",
        payload: {
          runId,
          epoch: 1,
          status: "completed",
          exitCode: 0,
          stopReason: "done",
          finalMessage: "done",
          usage: null,
          lastSequenceBeforeTerminal: null,
          finishedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    },
    eventVersion: 1,
  })}\n`;
}
