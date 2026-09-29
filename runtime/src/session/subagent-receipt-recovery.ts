import { existsSync, lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { withPinnedOfflineRolloutReadLease } from "../durability/offline-rollout.js";
import { StrictCanonicalJournalValidator } from "../state/recovery-journal-contract.js";
import { LOGS_DATABASE_FILENAME, STATE_DATABASE_FILENAME, StateSqliteReader } from "../state/sqlite-driver.js";
import type { RunJournalBinding } from "../state/run-durability.js";
import type { SubagentTaskAdmissionEvent, SubagentTurnOutcomeEvent } from "./event-log.js";
import type { ThreadSpawnEdgeRecord } from "./rollout-store.js";
import { childTerminalOutcome } from "../agents/child-terminal.js";

export interface RecoveredChildTaskReceipt {
  readonly edge: ThreadSpawnEdgeRecord;
  readonly sourcePath: string;
  readonly sequence: number;
  readonly receipt: SubagentTurnOutcomeEvent;
  readonly admission?: SubagentTaskAdmissionEvent;
  readonly eventId?: string;
  readonly spawnEdgeId?: string;
}

type SourceBinding = Pick<RunJournalBinding, "runId" | "childRunId" | "sessionId" | "sourcePath">;

/** Read evidence only. This never restores a worker, calls a provider, or repairs a journal tail. */
export function readSubagentTaskReceipts(options: {
  readonly edge: ThreadSpawnEdgeRecord;
  readonly projectDir: string;
  readonly projectsDir: string;
  readonly bindings: readonly SourceBinding[];
  readonly resolveSourcePath: (path: string) => string;
  readonly deadline?: number;
}): readonly RecoveredChildTaskReceipt[] {
  const { edge } = options;
  const deadline = Math.min(Date.now() + 2_000, options.deadline ?? Number.POSITIVE_INFINITY);
  const checkOperationalBudget = (): void => {
    if (Date.now() > deadline) throw new Error("Child receipt recovery time limit exceeded.");
  };
  let projectDir = options.projectDir;
  let bindings = options.bindings;
  if (bindings.length === 0) {
    // Worktree children own a different project database. Resolve only this
    // already-authorized spawn identity, and refuse duplicate project claims.
    const directory = opendirSync(options.projectsDir);
    let visited = 0;
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        checkOperationalBudget();
        if (++visited > 2_048) throw new Error("Child receipt project discovery limit exceeded.");
        if (!entry.isDirectory()) continue;
        const candidate = join(options.projectsDir, entry.name);
        if (candidate === options.projectDir || !lstatSync(candidate).isDirectory()) continue;
        const stateDbPath = join(candidate, STATE_DATABASE_FILENAME);
        const logsDbPath = join(candidate, LOGS_DATABASE_FILENAME);
        if (!existsSync(stateDbPath) || !existsSync(logsDbPath)) continue;
        const reader = new StateSqliteReader({ projectDir: candidate, stateDbPath, logsDbPath });
        try {
          const rows = reader.prepareState<[string], {
            run_id: string; child_run_id: string; session_id: string; source_path: string;
          }>(`SELECT run_id, child_run_id, session_id, source_path FROM run_journal_bindings
              WHERE run_id = ? ORDER BY epoch, bound_at, source_path`).all(edge.childThreadId);
          if (rows.length === 0) continue;
          if (bindings.length > 0) throw new Error("Child receipt identity exists in multiple projects.");
          projectDir = candidate;
          bindings = rows.map((row) => ({ runId: row.run_id, childRunId: row.child_run_id,
            sessionId: row.session_id, sourcePath: row.source_path }));
        } finally {
          reader.close();
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  const receipts = new Map<string, RecoveredChildTaskReceipt>();
  const admissions = new Map<string, { admission: SubagentTaskAdmissionEvent; sourcePath: string; sequence: number; eventId: string; spawnEdgeId?: string }>();
  const initialAdmission = edge.metadata.initialTaskAdmission;
  if (initialAdmission !== undefined) {
    if (initialAdmission.agentId !== edge.childThreadId || initialAdmission.agentPath !== edge.metadata.agentPath ||
        initialAdmission.author !== edge.parentPath) throw new Error("Initial task admission does not match its spawn identity.");
    admissions.set(`${initialAdmission.agentId}:${initialAdmission.turnId}`, { admission: initialAdmission,
      sourcePath: "", sequence: 0, eventId: `spawn-edge:${edge.childThreadId}`, spawnEdgeId: edge.childThreadId });
  }
  const sources = new Set<string>();
  for (const binding of bindings) {
    checkOperationalBudget();
    if (binding.runId !== edge.childThreadId || binding.childRunId !== edge.childThreadId ||
        binding.sessionId !== edge.childThreadId) {
      throw new Error("Child receipt journal binding does not match its spawn identity.");
    }
    const sourcePath = options.resolveSourcePath(binding.sourcePath);
    if (sources.has(sourcePath)) continue;
    sources.add(sourcePath);
    if (sources.size > 64) throw new Error("Child receipt journal source limit exceeded.");
    const fromSource: RecoveredChildTaskReceipt[] = [];
    const sourceAdmissions: { admission: SubagentTaskAdmissionEvent; sourcePath: string; sequence: number; eventId: string }[] = [];
    withPinnedOfflineRolloutReadLease({ projectDir, sessionId: binding.sessionId, sourcePath }, (rollout) => {
      const validator = new StrictCanonicalJournalValidator({ expectedRunId: edge.childThreadId,
        retainRecords: false, terminalPolicy: "allow_missing", maxSourceBytes: 64 * 1_024 * 1_024,
        checkOperationalBudget,
        onRecord: ({ item }) => {
          if (item.type !== "event_msg") return;
          if (item.payload.msg.type === "subagent_task_admitted") {
            const admission = item.payload.msg.payload;
            if (admission.agentId !== edge.childThreadId || admission.agentPath !== edge.metadata.agentPath ||
                (admission.author !== edge.parentPath && !admission.agentPath.startsWith(`${admission.author}/`)) ||
                !Number.isSafeInteger(item.payload.seq) || item.payload.seq! <= 0) {
              throw new Error("Child task admission does not match its spawn identity.");
            }
            if (sourceAdmissions.length >= 1_024) throw new Error("Child task admission count limit exceeded.");
            sourceAdmissions.push({ admission, sourcePath, sequence: item.payload.seq!,
              eventId: item.payload.eventId ?? item.payload.id });
            return;
          }
          if (item.payload.msg.type !== "subagent_turn_outcome") return;
          const receipt = item.payload.msg.payload;
          if (receipt.agentId !== edge.childThreadId || receipt.agentPath !== edge.metadata.agentPath ||
              !Number.isSafeInteger(item.payload.seq) || item.payload.seq! <= 0) {
            throw new Error("Child task receipt does not match its spawn identity.");
          }
          if (fromSource.length >= 1_024) throw new Error("Child task receipt count limit exceeded.");
          fromSource.push({ edge, sourcePath, sequence: item.payload.seq!, receipt });
        } });
      rollout.scanChunks(64 * 1_024, (chunk) => validator.push(chunk));
      validator.finish();
    });
    for (const admitted of sourceAdmissions) {
      const key = `${admitted.admission.agentId}:${admitted.admission.turnId}`;
      const previous = admissions.get(key);
      if (previous !== undefined && JSON.stringify(previous.admission) !== JSON.stringify(admitted.admission)) {
        throw new Error("Child task has conflicting durable admissions.");
      }
      admissions.set(key, admitted);
      if (admissions.size > 1_024) throw new Error("Child task admission count limit exceeded.");
    }
    for (const recovered of fromSource) {
      const key = `${recovered.receipt.agentId}:${recovered.receipt.turnId}`;
      const existing = receipts.get(key);
      if (existing !== undefined && JSON.stringify(existing.receipt) !== JSON.stringify(recovered.receipt)) {
        throw new Error("Child task has conflicting durable receipts.");
      }
      receipts.set(key, recovered);
      if (receipts.size > 1_024) throw new Error("Child task receipt count limit exceeded.");
    }
  }
  for (const [key, admitted] of admissions) {
    const outcome = receipts.get(key);
    if (outcome !== undefined) {
      if (outcome.receipt.taskId !== admitted.admission.taskId) {
        throw new Error("Child task outcome does not match its admitted task.");
      }
      continue;
    }
    const { admission, sourcePath, sequence, eventId, spawnEdgeId } = admitted;
    const reason = "The child task was admitted but has no durable outcome after restart. Effects are unknown. The task was not replayed.";
    receipts.set(key, { edge, sourcePath, sequence, eventId, admission,
      ...(spawnEdgeId === undefined ? {} : { spawnEdgeId }),
      receipt: { agentId: admission.agentId, agentPath: admission.agentPath,
        turnId: admission.turnId, taskId: admission.taskId, outcome: "interrupted", toolCallCount: 0,
        reason, terminal: childTerminalOutcome({ provider: admission.provider, model: admission.model,
          reason: "resume_blocked", retryable: false, dispatch: "unknown", unfinishedWork: admission.taskText }) } });
  }
  return [...receipts.values()].sort((left, right) => left.sequence - right.sequence);
}
