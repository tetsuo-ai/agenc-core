import { basename, dirname } from "node:path";
import { MAX_RECOVERY_CANONICAL_LINE_BYTES, DEFAULT_MAX_STARTUP_RECOVERY_MS } from "./recovery-contract.js";
import { withPinnedCanonicalJournalTwoPass } from "./recovery-file.js";
import { StateRecoveryIncidentRepository } from "./recovery-incidents.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

/** Clear only false line-limit incidents on unchanged, fully valid legacy bytes. */
export function repairLegacySessionConfiguredQuarantines(
  driver: StateSqliteDriver,
  nowMs: number,
): number {
  const repository = new StateRecoveryIncidentRepository(driver);
  const deadline = Date.now() + DEFAULT_MAX_STARTUP_RECOVERY_MS;
  let cursor: string | undefined;
  let checked = 0;
  let repaired = 0;
  do {
    const page = repository.listQuarantines({ state: "active", limit: 100, ...(cursor ? { cursor } : {}) });
    for (const incident of page.items) {
      if (Date.now() >= deadline || checked >= 32) return repaired;
      if (incident.reasonCode !== "line_byte_limit" ||
          basename(dirname(incident.sourcePath)) !== incident.runId) continue;
      checked += 1;
      let legacyCopyAtIncident = false;
      try {
        withPinnedCanonicalJournalTwoPass({
          projectDir: driver.projectDir,
          sessionId: incident.runId,
          sourcePath: incident.sourcePath,
          expectedRunId: incident.runId,
          limits: { maxScanMilliseconds: Math.max(1, deadline - Date.now()) },
          observeValidatedRecord: record => {
            if (record.encodedByteLength > MAX_RECOVERY_CANONICAL_LINE_BYTES &&
                record.item.type === "event_msg" &&
                record.item.payload.msg.type === "session_configured" &&
                (incident.lineNumber === undefined || incident.lineNumber === record.lineNumber)) {
              legacyCopyAtIncident = true;
            }
          },
        }, journal => {
          if (!legacyCopyAtIncident || journal.proof.sourceSha256 !== incident.sourceSha256 ||
              journal.proof.sourceByteLength !== incident.sourceSizeBytes) {
            journal.replay(() => {});
            return;
          }
          repository.repairQuarantine({
            quarantineId: incident.quarantineId,
            confirmedSourceSha256: journal.proof.sourceSha256,
            actor: "daemon_legacy_bootstrap_recovery",
            note: "Unchanged historical session_configured transcript copy passed bounded strict replay; no source bytes were changed",
            resolvedAtMs: nowMs,
          }, () => {
            const proof = journal.replay(() => {});
            journal.assertPinned();
            return { sourceSha256: proof.sourceSha256 };
          });
          repaired += 1;
        });
      } catch {
        // Corrupt, changed, live or unavailable sources remain quarantined.
        // The ordinary recovery report below preserves their original evidence.
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return repaired;
}
