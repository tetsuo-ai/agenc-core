import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const APPLY_PATCH_SCENARIOS_ROOT = fileURLToPath(
  new URL("./__fixtures__/scenarios/", import.meta.url),
);

const EXPECTED_SCENARIOS = [
  "001_add_file",
  "002_multiple_operations",
  "003_multiple_chunks",
  "004_move_to_new_directory",
  "005_rejects_empty_patch",
  "006_rejects_missing_context",
  "007_rejects_missing_file_delete",
  "008_rejects_empty_update_hunk",
  "009_requires_existing_file_for_update",
  "010_move_overwrites_existing_destination",
  "011_add_overwrites_existing_file",
  "012_delete_directory_fails",
  "013_rejects_invalid_hunk_header",
  "014_update_file_appends_trailing_newline",
  "015_failure_after_partial_success_leaves_changes",
  "016_pure_addition_update_chunk",
  "017_whitespace_padded_hunk_header",
  "018_whitespace_padded_patch_markers",
  "019_unicode_simple",
  "020_delete_file_success",
  "020_whitespace_padded_patch_marker_lines",
  "021_update_file_deletion_only",
  "022_update_file_end_of_file_marker",
];

describe("apply-patch fixture corpus", () => {
  test("keeps the full scenario fixture corpus under runtime/tests", async () => {
    const actual = (
      await readdir(APPLY_PATCH_SCENARIOS_ROOT, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(actual).toEqual([...EXPECTED_SCENARIOS].sort());
  });
});
