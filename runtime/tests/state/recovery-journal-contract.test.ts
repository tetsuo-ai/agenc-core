import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openFndFixtureCatalog } from "../helpers/fnd-fixtures.js";
import { backfillPinnedRolloutContent } from "./backfill.js";
import {
  CanonicalJournalIntegrityError,
} from "./recovery-contract.js";
import {
  StrictCanonicalJournalValidator,
  validateCanonicalJournalBytes,
  validateCanonicalJournalText,
} from "./recovery-journal-contract.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("strict canonical journal contract", () => {
  it("accepts sequenced and explicit legacy format lanes", async () => {
    const catalog = await openFndFixtureCatalog();
    const sequenced = validateCanonicalJournalBytes(
      await catalog.bytes("journal.sequenced-valid.v1"),
    );
    const legacy = validateCanonicalJournalBytes(
      await catalog.bytes("journal.legacy-repeated-id.v1"),
    );

    expect(sequenced).toMatchObject({
      format: "sequenced_v1",
      eventCount: 3,
      physicalLineCount: 3,
      digestAnchored: false,
    });
    expect(legacy).toMatchObject({
      format: "legacy_unsequenced_v1",
      eventCount: 3,
    });
    expect(legacy.records.map((record) => record.item.type)).toEqual([
      "event_msg",
      "event_msg",
      "event_msg",
    ]);
  });

  it.each([
    ["journal.malformed-interior.v1", "malformed_json"],
    ["journal.duplicate-json-key.v1", "schema_invalid"],
    ["journal.duplicate-canonical-id.v1", "identity_conflict"],
    ["journal.duplicate-sequence.v1", "sequence_duplicate"],
    ["journal.sequence-gap.v1", "sequence_gap"],
    ["journal.sequence-rewind.v1", "sequence_rewind"],
    ["journal.mixed-lanes.v1", "legacy_format_violation"],
    ["journal.interrupted-tail.v1", "unterminated_record"],
  ] as const)("rejects %s with stable reason %s", async (fixtureId, reasonCode) => {
    const catalog = await openFndFixtureCatalog();
    const bytes = await catalog.bytes(fixtureId);
    expect(() => validateCanonicalJournalBytes(bytes)).toThrow(
      expect.objectContaining({ reasonCode }),
    );
  });

  it("retains exact byte facts across CRLF and chunk boundaries", () => {
    const first = validEvent(1, "turn_started").trimEnd();
    const second = validEvent(2, "turn_complete").trimEnd();
    const bytes = Buffer.from(`${first}\r\n${second}\r\n`, "utf8");
    const validator = new StrictCanonicalJournalValidator();
    for (let offset = 0; offset < bytes.length; offset += 7) {
      validator.push(bytes.subarray(offset, offset + 7));
    }
    const result = validator.finish();

    expect(result.records[0]).toMatchObject({
      lineNumber: 1,
      byteOffset: 0,
      encodedByteLength: Buffer.byteLength(first),
    });
    expect(result.records[1]).toMatchObject({
      lineNumber: 2,
      byteOffset: Buffer.byteLength(first) + 2,
      encodedByteLength: Buffer.byteLength(second),
    });
    expect(result.records[1]?.rollingSha256).toBe(result.sourceSha256);
  });

  it("uses an existing digest as an anchor and never treats a fresh digest as proof", () => {
    const raw = validEvent(1, "turn_complete");
    const unanchored = validateCanonicalJournalText(raw);
    expect(unanchored.digestAnchored).toBe(false);
    expect(
      validateCanonicalJournalText(raw, {
        trustedSourceSha256: unanchored.sourceSha256,
      }).digestAnchored,
    ).toBe(true);
    expect(() =>
      validateCanonicalJournalText(raw, {
        trustedSourceSha256: "0".repeat(64),
      }),
    ).toThrow(expect.objectContaining({ reasonCode: "source_hash_mismatch" }));
  });

  it("enforces required terminal bindings only when the caller declares them", () => {
    const started = validEvent(1, "turn_started");
    expect(validateCanonicalJournalText(started).terminalCount).toBe(0);
    expect(() =>
      validateCanonicalJournalText(started, {
        terminalPolicy: "require_terminal",
      }),
    ).toThrow(expect.objectContaining({ reasonCode: "required_terminal_missing" }));
  });

  it("rejects invalid UTF-8 without replacement decoding", () => {
    const bytes = Buffer.concat([
      Buffer.from('{"type":"response_item","payload":{"role":"user","content":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}\n'),
    ]);
    expect(() => validateCanonicalJournalBytes(bytes)).toThrow(
      expect.objectContaining({ reasonCode: "malformed_json" }),
    );
  });

  it("rejects event message types unknown to this runtime", () => {
    expect(() =>
      validateCanonicalJournalText(validEvent(1, "future_event_type")),
    ).toThrow(
      expect.objectContaining({ reasonCode: "unsupported_format_version" }),
    );
  });
});

describe("strict pinned rollout projection", () => {
  it("rejects a malformed interior record before projecting any row", async () => {
    const catalog = await openFndFixtureCatalog();
    const raw = await catalog.text("journal.malformed-interior.v1");
    const { driver, rolloutPath } = createStateFixture();
    try {
      expect(() =>
        backfillPinnedRolloutContent({
          rolloutPath,
          raw,
          threads: new StateThreadRepository(driver),
          mtimeMs: 0,
          validateCanonical: () => {},
        }),
      ).toThrow(
        expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
          reasonCode: "malformed_json",
        }),
      );
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      driver.close();
    }
  });
});

function validEvent(sequence: number, type: string): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      eventId: `event:${sequence}`,
      id: "strict-test",
      seq: sequence,
      msg: { type, payload: { turnId: "strict-test" } },
    },
    eventVersion: 1,
  })}\n`;
}

function createStateFixture(): {
  readonly driver: StateSqliteDriver;
  readonly rolloutPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agenc-strict-journal-"));
  temporaryRoots.push(root);
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const driver = openStateDatabases({ cwd, agencHome: join(root, "state") });
  return {
    driver,
    rolloutPath: join(
      driver.projectDir,
      "rollout-2026-08-01T00-00-00-000Z-strict-test.jsonl",
    ),
  };
}
