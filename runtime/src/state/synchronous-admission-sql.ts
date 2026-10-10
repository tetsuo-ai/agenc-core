/**
 * Audited SQL of the private admission writer. These queries read only
 * synchronously committed admission, cancellation, lifecycle or spawn state.
 * Canonical rollout/thread projections are never in this set. Any query edit
 * falls back to the ordinary reader barrier until it is audited here too.
 */
const AUDITED_ADMISSION_READS = new Set([
  "SELECT * FROM execution_admission_allocations ORDER BY scope_key ASC",
  "SELECT * FROM execution_admission_allocations ORDER BY scope_key ASC LIMIT ?",
  "SELECT * FROM execution_admission_allocations WHERE owner_run_id = ? ORDER BY scope_key ASC LIMIT ?",
  "SELECT * FROM execution_admission_allocations WHERE scope_key = ?",
  "SELECT * FROM execution_admission_journal WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
  "SELECT * FROM execution_admission_journal WHERE sequence = ?",
  "SELECT * FROM execution_admission_reservations WHERE reservation_id = ?",
  "SELECT 1 AS capped FROM execution_admission_reservation_allocations AS link JOIN execution_admission_allocations AS allocation ON allocation.scope_key = link.scope_key WHERE link.reservation_id = ? AND (allocation.max_tokens IS NOT NULL OR allocation.max_cost_nanos IS NOT NULL) LIMIT 1",
  "SELECT 1 AS capped FROM execution_admission_reservation_allocations AS link JOIN execution_admission_allocations AS allocation ON allocation.scope_key = link.scope_key WHERE link.reservation_id = ? AND allocation.max_cost_nanos IS NOT NULL LIMIT 1",
  "SELECT 1 AS found FROM execution_admission_cancellations WHERE run_id = ? LIMIT 1",
  "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM execution_admission_journal",
  "SELECT deadline_at FROM execution_admission_run_limits WHERE run_id = ?",
  "SELECT id, kind, status, priority, input_json, result_json, error, worker_id, created_at, updated_at, available_at, admission_run_id, admission_step_id, admission_parent_run_id, admission_workspace_id, admission_session_id, admission_parent_id, admission_provider, admission_model, admission_autonomous, admission_deadline_at, admission_approval_required, admission_max_input_tokens, admission_max_output_tokens, admission_max_cost_nanos, admission_attempts, admission_queue_sequence, admission_owner_pid, admission_owner_id, admission_attached, admission_admitted_at, admission_dispatched_at, admission_completed_at, admission_reason, admission_reservation_id FROM agent_jobs WHERE admission_run_id = ? AND admission_step_id = ?",
  "SELECT id, kind, status, priority, input_json, result_json, error, worker_id, created_at, updated_at, available_at, admission_run_id, admission_step_id, admission_parent_run_id, admission_workspace_id, admission_session_id, admission_parent_id, admission_provider, admission_model, admission_autonomous, admission_deadline_at, admission_approval_required, admission_max_input_tokens, admission_max_output_tokens, admission_max_cost_nanos, admission_attempts, admission_queue_sequence, admission_owner_pid, admission_owner_id, admission_attached, admission_admitted_at, admission_dispatched_at, admission_completed_at, admission_reason, admission_reservation_id FROM agent_jobs WHERE admission_run_id IS NOT NULL AND status = 'queued' AND available_at <= ? AND (admission_deadline_at IS NULL OR admission_deadline_at > ?) ORDER BY priority DESC, admission_queue_sequence ASC LIMIT 1",
  "SELECT id, kind, status, priority, input_json, result_json, error, worker_id, created_at, updated_at, available_at, admission_run_id, admission_step_id, admission_parent_run_id, admission_workspace_id, admission_session_id, admission_parent_id, admission_provider, admission_model, admission_autonomous, admission_deadline_at, admission_approval_required, admission_max_input_tokens, admission_max_output_tokens, admission_max_cost_nanos, admission_attempts, admission_queue_sequence, admission_owner_pid, admission_owner_id, admission_attached, admission_admitted_at, admission_dispatched_at, admission_completed_at, admission_reason, admission_reservation_id FROM agent_jobs WHERE admission_run_id IS NOT NULL AND status IN ('queued', 'approval_required', 'running') ORDER BY admission_queue_sequence ASC",
  "SELECT id, kind, status, priority, input_json, result_json, error, worker_id, created_at, updated_at, available_at, admission_run_id, admission_step_id, admission_parent_run_id, admission_workspace_id, admission_session_id, admission_parent_id, admission_provider, admission_model, admission_autonomous, admission_deadline_at, admission_approval_required, admission_max_input_tokens, admission_max_output_tokens, admission_max_cost_nanos, admission_attempts, admission_queue_sequence, admission_owner_pid, admission_owner_id, admission_attached, admission_admitted_at, admission_dispatched_at, admission_completed_at, admission_reason, admission_reservation_id FROM agent_jobs WHERE id = ? AND admission_run_id IS NOT NULL",
  "SELECT ra.reservation_id, ra.scope_key, ra.reserved_tokens, ra.reserved_cost_nanos, r.status, r.actual_tokens, r.actual_cost_nanos FROM execution_admission_reservation_allocations ra JOIN execution_admission_reservations r ON r.reservation_id = ra.reservation_id ORDER BY ra.scope_key ASC, ra.reservation_id ASC",
  "SELECT requested.run_id, run.status, EXISTS ( SELECT 1 FROM execution_admission_cancellations AS locked WHERE locked.run_id = requested.run_id ) AS cancelled, (run.id IS NOT NULL OR EXISTS ( SELECT 1 FROM agent_jobs AS identity_job WHERE identity_job.admission_run_id = requested.run_id ) OR EXISTS ( SELECT 1 FROM run_lifecycle_epochs AS lifecycle WHERE lifecycle.run_id = requested.run_id )) AS durable_identity, '[]' AS parents_json FROM (SELECT ? AS run_id) AS requested LEFT JOIN agent_runs AS run ON run.id = requested.run_id WHERE NOT EXISTS ( SELECT 1 FROM thread_spawn_edges AS edge WHERE edge.child_thread_id = requested.run_id ) AND NOT EXISTS ( SELECT 1 FROM agent_jobs AS parent_job WHERE parent_job.admission_run_id = requested.run_id AND parent_job.admission_parent_run_id IS NOT NULL )",
  "SELECT reservation.* FROM execution_admission_reservations AS reservation JOIN execution_admission_reservation_allocations AS allocation ON allocation.reservation_id = reservation.reservation_id WHERE allocation.scope_key = ? AND reservation.status != 'voided'",
  "SELECT reservation.* FROM execution_admission_reservations AS reservation JOIN execution_admission_reservation_allocations AS allocation ON allocation.reservation_id = reservation.reservation_id WHERE allocation.scope_key = ? AND reservation.status != 'voided' AND reservation.reservation_id = ?",
  "SELECT reservation.* FROM execution_admission_reservations AS reservation JOIN execution_admission_reservation_allocations AS allocation ON allocation.reservation_id = reservation.reservation_id WHERE allocation.scope_key = ? AND reservation.status != 'voided' LIMIT 10001",
  "SELECT reservation_id, scope_key, reserved_tokens, reserved_cost_nanos FROM execution_admission_reservation_allocations WHERE reservation_id = ? ORDER BY scope_key ASC",
  "SELECT run_id FROM execution_admission_run_limits ORDER BY run_id ASC",
  "SELECT run_id FROM execution_admission_run_limits WHERE deadline_at IS NOT NULL AND deadline_at <= ? ORDER BY deadline_at ASC, run_id ASC",
]);

export function isAuditedAdmissionRead(sql: string): boolean {
  // Whitespace only: comments, comma joins, CTEs and appended clauses are
  // significant and cannot turn an unknown query into an allowed one.
  return AUDITED_ADMISSION_READS.has(sql.replace(/\s+/g, " ").trim());
}
