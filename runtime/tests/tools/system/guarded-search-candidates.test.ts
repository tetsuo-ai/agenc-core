import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachReadOnlyDelegationReadGuard } from "../../../src/permissions/readonly-read-guard.js";
import { collectGuardedSearchCandidates } from "../../../src/tools/system/guarded-search-candidates.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-guarded-search-"));
  await mkdir(join(root, "keep"));
  await mkdir(join(root, "hidden"));
  await writeFile(join(root, "public.ts"), "ok\n");
  await writeFile(join(root, "secret.ts"), "nope\n");
  await writeFile(join(root, "keep", "nested.ts"), "ok\n");
  await writeFile(join(root, "hidden", "private.ts"), "nope\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function args(guard?: (path: string) => boolean): object {
  const toolArgs = {};
  if (guard !== undefined) attachReadOnlyDelegationReadGuard(toolArgs, guard);
  return toolArgs;
}

const allowAll = async () => true;

describe("guarded search candidates", () => {
  it.skipIf(process.platform === "win32")("returns authorized files and never follows or reports denied or symlink paths", async () => {
    await symlink(join(root, "secret.ts"), join(root, "alias.ts"));
    await symlink(join(root, "hidden"), join(root, "hidden-link"));
    const candidates = await collectGuardedSearchCandidates({
      root,
      toolArgs: args((path) => !path.endsWith("secret.ts") && !path.includes(`${root}/hidden`)),
      acceptPath: allowAll,
    });
    const paths = candidates.map((candidate) => candidate.path).sort();
    expect(paths).toEqual([join(root, "keep", "nested.ts"), join(root, "public.ts")].sort());
    expect(paths.some((path) => path.includes("alias") || path.includes("hidden"))).toBe(false);
  });

  it("skips a directory when acceptPath or live authority rejects it", async () => {
    const rejected = await collectGuardedSearchCandidates({
      root,
      toolArgs: args(),
      acceptPath: async (path, directory) => !(directory && path.endsWith("keep")),
    });
    expect(rejected.map((candidate) => candidate.path).sort()).toEqual([
      join(root, "hidden", "private.ts"),
      join(root, "public.ts"),
      join(root, "secret.ts"),
    ].sort());

    let keepAllowed = true;
    const keep = join(root, "keep");
    const revoked = await collectGuardedSearchCandidates({
      root,
      toolArgs: args((path) => path === keep || path.startsWith(`${keep}/`) ? keepAllowed : true),
      acceptPath: async (path, directory) => {
        if (directory && path === keep) keepAllowed = false;
        return true;
      },
    });
    expect(revoked.map((candidate) => candidate.path)).not.toContain(join(keep, "nested.ts"));
  });

  it("fails closed when the search is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collectGuardedSearchCandidates({
      root,
      toolArgs: args(),
      signal: controller.signal,
      acceptPath: allowAll,
    })).rejects.toThrow(/Search aborted/u);
  });
});
