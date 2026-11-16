import { describe, expect, it } from "vitest";
import { isAuditedAdmissionRead } from "../../src/state/synchronous-admission-sql.js";

describe("audited admission SQL", () => {
  const allowed = "SELECT * FROM execution_admission_allocations WHERE scope_key = ?";
  it("accepts the audited text with formatting differences only", () => {
    expect(isAuditedAdmissionRead(allowed)).toBe(true);
    expect(isAuditedAdmissionRead(` \n SELECT *  FROM execution_admission_allocations\n WHERE scope_key = ? `)).toBe(true);
  });
  it.each(["", " AND reservation.reservation_id = ?", " LIMIT 10001"])("audits the usage view read with plan billing details%s", suffix => {
    // The view joins agent_jobs for the billing route. Unaudited, every usage
    // snapshot would drain the one-shot write-behind buffer (rb37, step 5).
    const select = `SELECT reservation.*, job.result_json AS usage_details_json FROM execution_admission_reservations AS reservation
        LEFT JOIN agent_jobs AS job ON job.id = reservation.job_id
        JOIN execution_admission_reservation_allocations AS allocation
        ON allocation.reservation_id = reservation.reservation_id
        WHERE allocation.scope_key = ? AND reservation.status != 'voided'`;
    expect(isAuditedAdmissionRead(select + suffix)).toBe(true);
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
