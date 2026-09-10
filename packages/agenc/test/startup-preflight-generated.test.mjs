import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLauncherPreflight, renderLauncherPreflight } from "../../../runtime/scripts/check-launcher-preflight.mjs";

test("launcher preflight is deterministic and included in both package gates", async () => {
  const generated = await readFile(new URL("../generated/startup-preflight.mjs", import.meta.url), "utf8");
  assert.equal(await renderLauncherPreflight(), generated);
  assert.equal(await renderLauncherPreflight(), generated);
  await checkLauncherPreflight();
  const launcherPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const runtimePackage = JSON.parse(await readFile(new URL("../../../runtime/package.json", import.meta.url), "utf8"));
  assert.ok(launcherPackage.files.includes("generated/startup-preflight.mjs"));
  assert.match(launcherPackage.scripts.prepack, /^node \.\.\/\.\.\/runtime\/scripts\/check-launcher-preflight\.mjs --check &&/u);
  assert.match(runtimePackage.scripts.build, /^node scripts\/check-launcher-preflight\.mjs --check &&/u);
});

test("preflight checker rejects missing or stale artifacts and only write mode repairs them", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenc-preflight-generated-"));
  const outputPath = join(root, "startup-preflight.mjs");
  try {
    await assert.rejects(checkLauncherPreflight({ outputPath }), /preflight is stale/u);
    await writeFile(outputPath, "stale artifact\n");
    await assert.rejects(checkLauncherPreflight({ outputPath }), /preflight is stale/u);
    assert.equal(await readFile(outputPath, "utf8"), "stale artifact\n");
    await checkLauncherPreflight({ outputPath, mode: "write" });
    await checkLauncherPreflight({ outputPath });
    await assert.rejects(checkLauncherPreflight({ outputPath, mode: "invalid" }), /usage:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
