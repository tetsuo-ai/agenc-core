import { describe, expect, it } from "vitest";
import { isAuditedAdmissionRead } from "../../src/state/synchronous-admission-sql.js";

describe("audited admission SQL", () => {
  const allowed = "SELECT * FROM execution_admission_allocations WHERE scope_key = ?";
  it("accepts the audited text with formatting differences only", () => {
    expect(isAuditedAdmissionRead(allowed)).toBe(true);
    expect(isAuditedAdmissionRead(` \n SELECT *  FROM execution_admission_allocations\n WHERE scope_key = ? `)).toBe(true);
  });
  it.each([
    "SELECT * FROM execution_admission_allocations, session_snapshots WHERE scope_key = ?",
    "SELECT * FROM execution_admission_allocations JOIN session_snapshots ON 1 = 1 WHERE scope_key = ?",
    "WITH execution_admission_allocations AS (SELECT * FROM session_snapshots) SELECT * FROM execution_admission_allocations WHERE scope_key = ?",
    "WITH ignored AS (SELECT * FROM session_snapshots) SELECT * FROM execution_admission_allocations WHERE scope_key = ?",
    "SELECT * FROM execution_admission_allocations /* JOIN session_snapshots */ WHERE scope_key = ?",
    "SELECT * FROM execution_admission_allocations WHERE scope_key = ? UNION SELECT * FROM session_snapshots",
    "SELECT * FROM main.execution_admission_allocations WHERE scope_key = ?",
    'SELECT * FROM "execution_admission_allocations" WHERE scope_key = ?',
    "SELECT * FROM execution_admission_allocations WHERE scope_key = ?; SELECT * FROM session_snapshots",
    "SELECT * FROM execution_admission_allocations WHERE scope_key = ? AND EXISTS (SELECT 1 FROM session_snapshots)",
  ])("keeps the reader barrier for unaudited SQL: %s", sql => {
    expect(isAuditedAdmissionRead(sql)).toBe(false);
  });
});
