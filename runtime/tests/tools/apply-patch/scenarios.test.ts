import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  join,
  relative,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { applyPatchText } from "./runtime.js";

const SCENARIOS_ROOT = fileURLToPath(
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
  "015_failure_rolls_back_partial_success",
  "016_pure_addition_update_chunk",
  "017_whitespace_padded_hunk_header",
  "018_whitespace_padded_patch_markers",
  "019_unicode_simple",
  "020_delete_file_success",
  "020_whitespace_padded_patch_marker_lines",
  "021_update_file_deletion_only",
  "022_update_file_end_of_file_marker",
] as const;

const REJECTING_SCENARIOS = new Set<(typeof EXPECTED_SCENARIOS)[number]>([
  "005_rejects_empty_patch",
  "006_rejects_missing_context",
  "007_rejects_missing_file_delete",
  "008_rejects_empty_update_hunk",
  "009_requires_existing_file_for_update",
  "012_delete_directory_fails",
  "013_rejects_invalid_hunk_header",
  "015_failure_rolls_back_partial_success",
]);

type SnapshotEntry =
  | { readonly kind: "dir" }
  | { readonly kind: "file"; readonly contentsBase64: string };

type DirectorySnapshot = Record<string, SnapshotEntry>;

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-apply-patch-scenario-"));
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

async function snapshotDir(root: string): Promise<DirectorySnapshot> {
  const entries: DirectorySnapshot = {};

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return entries;
  } catch {
    return entries;
  }

  async function visit(dir: string): Promise<void> {
    for (const child of await readdir(dir)) {
      const absolute = join(dir, child);
      const metadata = await stat(absolute);
      const rel = normalizeRelativePath(relative(root, absolute));
      if (metadata.isDirectory()) {
        entries[rel] = { kind: "dir" };
        await visit(absolute);
      } else if (metadata.isFile()) {
        entries[rel] = {
          kind: "file",
          contentsBase64: (await readFile(absolute)).toString("base64"),
        };
      }
    }
  }

  await visit(root);
  return entries;
}

async function seedInput(scenarioDir: string, root: string): Promise<void> {
  const inputDir = join(scenarioDir, "input");
  try {
    const inputStat = await stat(inputDir);
    if (!inputStat.isDirectory()) return;
  } catch {
    return;
  }
  await cp(inputDir, root, { recursive: true });
}

async function listScenarioNames(): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(SCENARIOS_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names.sort();
}

describe("apply-patch donor fixture scenarios", () => {
  test("copies every donor scenario directory", async () => {
    const names = await listScenarioNames();

    expect(names).toEqual([...EXPECTED_SCENARIOS]);
  });

  test.each(EXPECTED_SCENARIOS)(
    "%s matches the expected final filesystem state",
    async (scenarioName) => {
      const scenarioDir = join(SCENARIOS_ROOT, scenarioName);
      const root = await tempRoot();
      try {
        await seedInput(scenarioDir, root);

        const patch = await readFile(join(scenarioDir, "patch.txt"), "utf8");
        let thrown: unknown;
        try {
          await applyPatchText(patch, { cwd: root, allowedPaths: [root] });
        } catch (error) {
          thrown = error;
        }

        if (REJECTING_SCENARIOS.has(scenarioName)) {
          expect(thrown).toBeInstanceOf(Error);
        } else {
          expect(thrown).toBeUndefined();
        }

        const actual = await snapshotDir(root);
        const expectedDir = join(scenarioDir, "expected");
        const expected = await snapshotDir(expectedDir);

        expect(actual).toEqual(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
