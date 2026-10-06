import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export const freshStateArtifactPath = "src/state/fresh-state-schema.generated.ts";
export const freshStateManifestPath = "src/state/fresh-state-schema.sources.json";
export const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

/** Release builds must never ship a snapshot from different migration sources. */
export async function verifyFreshStateSchemaSources(runtimeRoot) {
  const manifest = JSON.parse(await readFile(resolve(runtimeRoot, freshStateManifestPath), "utf8"));
  const stale = [];
  for (const [path, expected] of Object.entries(manifest.sources)) {
    try {
      if (sha256(await readFile(resolve(runtimeRoot, path))) !== expected) stale.push(path);
    } catch {
      stale.push(path);
    }
  }
  const migrations = (await readdir(resolve(runtimeRoot, "src/state/migrations")))
    .filter((name) => name.endsWith(".ts")).map((name) => `src/state/migrations/${name}`);
  for (const path of migrations) if (!(path in manifest.sources)) stale.push(path);
  if (sha256(await readFile(resolve(runtimeRoot, freshStateArtifactPath))) !== manifest.artifactSha256) {
    stale.push(freshStateArtifactPath);
  }
  if (stale.length > 0) {
    throw new Error(`Fresh state schema is stale (${stale.join(", ")}). Run npm run generate:fresh-state-schema and its parity tests.`);
  }
}
