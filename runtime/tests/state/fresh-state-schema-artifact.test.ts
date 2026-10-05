import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyFreshStateSchemaSources } from "../../scripts/fresh-state-schema-artifact.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agenc-schema-artifact-")); roots.push(root);
  mkdirSync(join(root, "src/state/migrations"), { recursive: true });
  mkdirSync(join(root, "src/contracts"), { recursive: true });
  const inputs = { "src/state/migrations/index.ts": "export const migrations = [];", "src/contracts/quota.ts": "export const quota = 5;" };
  for (const [path, value] of Object.entries(inputs)) writeFileSync(join(root, path), value);
  writeFileSync(join(root, "src/state/fresh-state-schema.generated.ts"), "schema");
  writeFileSync(join(root, "src/state/fresh-state-schema.sources.json"), JSON.stringify({ artifactSha256: digest("schema"), sources: Object.fromEntries(Object.entries(inputs).map(([path, text]) => [path, digest(text)])) }));
  return root;
}
it("binds the checked-in artifact to every current migration dependency", async () => {
  await expect(verifyFreshStateSchemaSources(resolve("."))).resolves.toBeUndefined();
});
it.each(["migration", "dependency", "artifact", "new migration", "missing migration"])("rejects %s drift before bundling", async (change) => {
  const root = fixture(); await verifyFreshStateSchemaSources(root);
  const migration = join(root, "src/state/migrations/index.ts");
  if (change === "migration") writeFileSync(migration, readFileSync(migration, "utf8") + "// changed");
  if (change === "dependency") writeFileSync(join(root, "src/contracts/quota.ts"), "export const quota = 6;");
  if (change === "artifact") writeFileSync(join(root, "src/state/fresh-state-schema.generated.ts"), "different");
  if (change === "new migration") writeFileSync(join(root, "src/state/migrations/002.ts"), "new");
  if (change === "missing migration") unlinkSync(migration);
  await expect(verifyFreshStateSchemaSources(root)).rejects.toThrow("Fresh state schema is stale");
});
