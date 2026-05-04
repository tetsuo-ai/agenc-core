import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildPermissionAuditRecord,
  createPermissionAuditFileLogger,
  recordPermissionAuditEvent,
  resolvePermissionAuditLogPath,
  type PermissionAuditEventInput,
} from "./permission-audit-log.js";

const baseEvent: PermissionAuditEventInput = {
  eventKind: "policy_outcome",
  decision: "approved",
  source: "unit-test",
  subjectType: "tool_execution",
  toolName: "Write",
  callId: "call_1",
  sessionId: "session_1",
  reasonCode: "evaluator_allowed",
};

describe("permission audit log", () => {
  it("resolves under AGENC_HOME before HOME", () => {
    expect(
      resolvePermissionAuditLogPath({
        env: {
          AGENC_HOME: "/tmp/agenc-custom",
          HOME: "/home/person",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe("/tmp/agenc-custom/audit/permission-audit.jsonl");
    expect(
      resolvePermissionAuditLogPath({
        env: { HOME: "/home/person" } as NodeJS.ProcessEnv,
      }),
    ).toBe("/home/person/.agenc/audit/permission-audit.jsonl");
  });

  it("appends sanitized JSONL records and repairs file permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-permission-audit-"));
    try {
      const path = resolvePermissionAuditLogPath({ agencHome: home });
      const logger = createPermissionAuditFileLogger({
        agencHome: home,
        now: () => new Date("2026-05-04T12:00:00.000Z"),
        createId: () => "audit_1",
      });
      await logger({
        ...baseEvent,
        rule: "Bash(api_key=abcdefghijklmnopqrstuvwxyz123456)",
        metadata: {
          approvalSource: "resolver",
          ignoredRawArgs: '{"command":"rm -rf /"}',
        },
      });
      await chmod(path, 0o644);
      await logger({ ...baseEvent, callId: "call_2" });

      const rows = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        schemaVersion: 1,
        id: "audit_1",
        recordedAt: "2026-05-04T12:00:00.000Z",
        eventKind: "policy_outcome",
        decision: "approved",
        source: "unit-test",
        subjectType: "tool_execution",
      });
      expect(JSON.stringify(rows[0])).not.toContain(
        "abcdefghijklmnopqrstuvwxyz123456",
      );
      expect(JSON.stringify(rows[0])).not.toContain("rm -rf");
      expect(rows[0]!.metadata).toEqual({ approvalSource: "resolver" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "audit"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("truncates long string fields and omits unsupported metadata", () => {
    const record = buildPermissionAuditRecord(
      {
        ...baseEvent,
        toolName: "A".repeat(700),
        metadata: {
          approvalSource: "B".repeat(700),
          rawArgs: "must-not-persist",
        },
      },
      {
        now: () => new Date("2026-05-04T12:00:00.000Z"),
        createId: () => "audit_1",
      },
    );
    expect(record.toolName!.length).toBeLessThan(530);
    expect(record.toolName).toContain("[truncated]");
    expect(record.metadata).toEqual({
      approvalSource: expect.stringContaining("[truncated]"),
    });
  });

  it("catches injected logger failures", async () => {
    const onError = vi.fn();
    await expect(
      recordPermissionAuditEvent(
        () => {
          throw new Error("disk full");
        },
        baseEvent,
        onError,
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
