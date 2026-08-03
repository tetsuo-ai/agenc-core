import type { SqlMigration } from "./types.js";
import type { SqliteDatabase } from "../sqlite-driver.js";
import {
  MAX_CSV_AUTOMATIC_FULL_RECONCILIATIONS_PER_JOB_LIFECYCLE,
  MAX_RECOVERED_CSV_JOBS,
} from "../../contracts/csv-job-contract.js";

export const CSV_JOB_SCHEDULER_SCHEMA_VERSION = 21;

function tableExists(db: SqliteDatabase, table: string): boolean {
  return (
    db
      .prepare<[string], { readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== undefined
  );
}

/**
 * Add the projections and indexes needed by the bounded CSV supervisor.
 *
 * Item transitions remain the source of truth. The trigger updates below make
 * every job summary a constant-time read while preserving the transaction that
 * changes the item itself as the sole counter linearization point.
 */
export const csvJobSchedulerMigration: SqlMigration = {
  version: CSV_JOB_SCHEDULER_SCHEMA_VERSION,
  name: "csv_job_scheduler",
  apply: (db) => {
    // Historical unit fixtures can record migration versions without creating
    // the optional CSV tables. A real state database upgraded through v20 has
    // both tables and receives the additive scheduler schema.
    if (
      !tableExists(db, "csv_agent_jobs") ||
      !tableExists(db, "csv_agent_job_items")
    ) {
      return;
    }

    db.exec(`
ALTER TABLE csv_agent_jobs ADD COLUMN review_pending_items
  INTEGER NOT NULL DEFAULT 0 CHECK (review_pending_items >= 0);
ALTER TABLE csv_agent_jobs ADD COLUMN available_results
  INTEGER NOT NULL DEFAULT 0 CHECK (available_results >= 0);
ALTER TABLE csv_agent_jobs ADD COLUMN unavailable_after_review_results
  INTEGER NOT NULL DEFAULT 0 CHECK (unavailable_after_review_results >= 0);
ALTER TABLE csv_agent_jobs ADD COLUMN not_produced_results
  INTEGER NOT NULL DEFAULT 0 CHECK (not_produced_results >= 0);
ALTER TABLE csv_agent_jobs ADD COLUMN created_at_ms
  INTEGER NOT NULL DEFAULT 0 CHECK (created_at_ms >= 0);
ALTER TABLE csv_agent_jobs ADD COLUMN automatic_full_reconciliations
  INTEGER NOT NULL DEFAULT 0 CHECK (
    automatic_full_reconciliations BETWEEN 0 AND
      ${MAX_CSV_AUTOMATIC_FULL_RECONCILIATIONS_PER_JOB_LIFECYCLE}
  );
ALTER TABLE csv_agent_jobs ADD COLUMN counter_integrity_state
  TEXT NOT NULL DEFAULT 'unchecked' CHECK (counter_integrity_state IN (
    'unchecked', 'ok', 'poisoned'
  ));
ALTER TABLE csv_agent_jobs ADD COLUMN counter_integrity_error TEXT;

UPDATE csv_agent_jobs SET
  review_pending_items = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = csv_agent_jobs.id AND item.review_status = 'pending'
  ),
  available_results = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = csv_agent_jobs.id
      AND item.result_availability = 'available'
  ),
  unavailable_after_review_results = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = csv_agent_jobs.id
      AND item.result_availability = 'unavailable_after_review'
  ),
  not_produced_results = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = csv_agent_jobs.id
      AND item.result_availability = 'not_produced'
  ),
  created_at_ms = created_at * 1000;

DROP TRIGGER csv_agent_job_item_insert_counters;
DROP TRIGGER csv_agent_job_item_update_counters;
DROP TRIGGER csv_agent_job_item_delete_counters;

CREATE TRIGGER csv_agent_job_item_insert_counters
AFTER INSERT ON csv_agent_job_items
BEGIN
  UPDATE csv_agent_jobs SET
    total_items = total_items + 1,
    pending_items = pending_items + (NEW.status = 'pending'),
    running_items = running_items + (NEW.status = 'running'),
    completed_items = completed_items + (NEW.status = 'completed'),
    failed_items = failed_items + (NEW.status = 'failed'),
    cancelled_items = cancelled_items + (NEW.status = 'cancelled'),
    unknown_outcome_items = unknown_outcome_items
      + (NEW.status = 'unknown_outcome'),
    review_pending_items = review_pending_items
      + CASE WHEN NEW.review_status = 'pending' THEN 1 ELSE 0 END,
    available_results = available_results
      + (NEW.result_availability = 'available'),
    unavailable_after_review_results = unavailable_after_review_results
      + (NEW.result_availability = 'unavailable_after_review'),
    not_produced_results = not_produced_results
      + (NEW.result_availability = 'not_produced'),
    result_bytes = result_bytes + NEW.result_size_bytes
  WHERE id = NEW.job_id;
END;

CREATE TRIGGER csv_agent_job_item_update_counters
AFTER UPDATE OF status, result_size_bytes, review_status, result_availability
ON csv_agent_job_items
BEGIN
  UPDATE csv_agent_jobs SET
    pending_items = pending_items - (OLD.status = 'pending')
      + (NEW.status = 'pending'),
    running_items = running_items - (OLD.status = 'running')
      + (NEW.status = 'running'),
    completed_items = completed_items - (OLD.status = 'completed')
      + (NEW.status = 'completed'),
    failed_items = failed_items - (OLD.status = 'failed')
      + (NEW.status = 'failed'),
    cancelled_items = cancelled_items - (OLD.status = 'cancelled')
      + (NEW.status = 'cancelled'),
    unknown_outcome_items = unknown_outcome_items
      - (OLD.status = 'unknown_outcome') + (NEW.status = 'unknown_outcome'),
    review_pending_items = review_pending_items
      - CASE WHEN OLD.review_status = 'pending' THEN 1 ELSE 0 END
      + CASE WHEN NEW.review_status = 'pending' THEN 1 ELSE 0 END,
    available_results = available_results
      - (OLD.result_availability = 'available')
      + (NEW.result_availability = 'available'),
    unavailable_after_review_results = unavailable_after_review_results
      - (OLD.result_availability = 'unavailable_after_review')
      + (NEW.result_availability = 'unavailable_after_review'),
    not_produced_results = not_produced_results
      - (OLD.result_availability = 'not_produced')
      + (NEW.result_availability = 'not_produced'),
    result_bytes = result_bytes - OLD.result_size_bytes + NEW.result_size_bytes
  WHERE id = NEW.job_id;
END;

CREATE TRIGGER csv_agent_job_item_delete_counters
AFTER DELETE ON csv_agent_job_items
BEGIN
  UPDATE csv_agent_jobs SET
    total_items = total_items - 1,
    pending_items = pending_items - (OLD.status = 'pending'),
    running_items = running_items - (OLD.status = 'running'),
    completed_items = completed_items - (OLD.status = 'completed'),
    failed_items = failed_items - (OLD.status = 'failed'),
    cancelled_items = cancelled_items - (OLD.status = 'cancelled'),
    unknown_outcome_items = unknown_outcome_items
      - (OLD.status = 'unknown_outcome'),
    review_pending_items = review_pending_items
      - CASE WHEN OLD.review_status = 'pending' THEN 1 ELSE 0 END,
    available_results = available_results
      - (OLD.result_availability = 'available'),
    unavailable_after_review_results = unavailable_after_review_results
      - (OLD.result_availability = 'unavailable_after_review'),
    not_produced_results = not_produced_results
      - (OLD.result_availability = 'not_produced'),
    result_bytes = result_bytes - OLD.result_size_bytes
  WHERE id = OLD.job_id;
END;

CREATE INDEX idx_csv_agent_jobs_scheduler_keyset
  ON csv_agent_jobs(created_at_ms ASC, id ASC)
  WHERE import_state = 'visible' AND retired_at IS NULL
    AND execution_gate = 'ready' AND counter_integrity_state <> 'poisoned'
    AND status IN ('pending', 'running')
    AND (pending_items > 0 OR running_items > 0);

CREATE TABLE csv_job_supervisor_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  supervisor_epoch INTEGER NOT NULL CHECK (supervisor_epoch > 0),
  job_cursor_created_at_ms INTEGER CHECK (job_cursor_created_at_ms >= 0),
  job_cursor_job_id TEXT,
  cleanup_cursor_queue_sequence INTEGER CHECK (
    cleanup_cursor_queue_sequence > 0
  ),
  cleanup_cursor_job_id TEXT,
  cleanup_scan_complete INTEGER NOT NULL CHECK (
    cleanup_scan_complete IN (0, 1)
  ),
  next_queue_sequence INTEGER NOT NULL CHECK (next_queue_sequence > 0),
  registered_jobs INTEGER NOT NULL CHECK (
    registered_jobs BETWEEN 0 AND ${MAX_RECOVERED_CSV_JOBS}
  ),
  epoch_scan_complete INTEGER NOT NULL CHECK (epoch_scan_complete IN (0, 1)),
  background_scan_required INTEGER NOT NULL CHECK (
    background_scan_required IN (0, 1)
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (
    (job_cursor_created_at_ms IS NULL AND job_cursor_job_id IS NULL)
    OR
    (job_cursor_created_at_ms IS NOT NULL
      AND job_cursor_job_id IS NOT NULL
      AND length(job_cursor_job_id) > 0)
  ),
  CHECK (
    (cleanup_cursor_queue_sequence IS NULL AND cleanup_cursor_job_id IS NULL)
    OR
    (cleanup_cursor_queue_sequence IS NOT NULL
      AND cleanup_cursor_job_id IS NOT NULL
      AND length(cleanup_cursor_job_id) > 0)
  )
);

INSERT INTO csv_job_supervisor_state (
  singleton, supervisor_epoch, job_cursor_created_at_ms, job_cursor_job_id,
  cleanup_cursor_queue_sequence, cleanup_cursor_job_id, cleanup_scan_complete,
  next_queue_sequence, registered_jobs, epoch_scan_complete,
  background_scan_required,
  updated_at_ms
) VALUES (
  1, 1, NULL, NULL, NULL, NULL, 0, 1, 0, 0, 0,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

CREATE TABLE csv_job_supervisor_registrations (
  job_id TEXT PRIMARY KEY,
  substate TEXT NOT NULL CHECK (substate IN (
    'unregistered', 'recovery_queued', 'registered', 'rotating', 'done'
  )),
  supervisor_epoch INTEGER NOT NULL CHECK (supervisor_epoch > 0),
  registration_generation TEXT NOT NULL CHECK (
    length(registration_generation) > 0
  ),
  queue_sequence INTEGER NOT NULL CHECK (queue_sequence > 0),
  item_cursor_row_index INTEGER NOT NULL DEFAULT -1 CHECK (
    item_cursor_row_index >= -1
  ),
  item_cursor_item_id TEXT,
  admitted_items INTEGER NOT NULL DEFAULT 0 CHECK (admitted_items >= 0),
  registered_at_ms INTEGER CHECK (registered_at_ms >= 0),
  last_admitted_at_ms INTEGER CHECK (last_admitted_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  FOREIGN KEY(job_id) REFERENCES csv_agent_jobs(id) ON DELETE CASCADE,
  CHECK (
    (item_cursor_row_index = -1 AND item_cursor_item_id IS NULL)
    OR
    (item_cursor_row_index >= 0 AND item_cursor_item_id IS NOT NULL
      AND length(item_cursor_item_id) > 0)
  )
);

CREATE INDEX idx_csv_job_supervisor_registration_queue
  ON csv_job_supervisor_registrations(
    substate, queue_sequence ASC, job_id ASC
  );

CREATE INDEX idx_csv_job_supervisor_registration_physical_keyset
  ON csv_job_supervisor_registrations(queue_sequence ASC, job_id ASC)
  WHERE substate IN ('recovery_queued', 'registered', 'rotating');
CREATE INDEX idx_csv_job_supervisor_registration_epoch
  ON csv_job_supervisor_registrations(
    supervisor_epoch, substate, queue_sequence ASC
  );
`);
  },
};
