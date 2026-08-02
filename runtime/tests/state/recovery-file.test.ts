import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { backfillPinnedRolloutFile, backfillRolloutFile } from "./backfill.js";
import {
  CanonicalJournalIntegrityError,
  MAX_RECOVERY_CANONICAL_LINE_BYTES,
  RecoveryOperationalError,
} from "./recovery-contract.js";
import { RecoveryDescriptorBudget } from "./recovery-file.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("descriptor-pinned canonical recovery", () => {
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
    expect(() => new RecoveryDescriptorBudget(17)).toThrow(/\[1, 16\]/);
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
