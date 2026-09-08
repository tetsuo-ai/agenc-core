import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rgPath } from "@vscode/ripgrep";
import { checkRipgrep } from "./check-ripgrep.mjs";

test("preflight reports the resolver's executable only after a successful probe", async () => {
  const messages = [];
  const status = { mode: "builtin", path: "/installed/rg", working: null };
  assert.equal(await checkRipgrep({
    loadResolver: async () => ({ getRipgrepStatus: () => status, probeRipgrepAvailable: async () => true }),
    report: (message) => messages.push(message),
  }), status);
  assert.deepEqual(messages, ["Ripgrep preflight passed (builtin: /installed/rg)."]);
});

test("preflight fails directly when the resolver's probe fails", async () => {
  await assert.rejects(checkRipgrep({
    loadResolver: async () => ({
      getRipgrepStatus: () => ({ mode: "builtin", path: "@vscode/ripgrep", working: false }),
      probeRipgrepAvailable: async () => false,
    }),
    report: () => assert.fail("unavailable ripgrep must not pass"),
  }), /Ripgrep preflight failed.*optional platform packages/u);
});

test("the real preflight finds the packaged binary without system rg", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-rg-preflight-"));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-ripgrep.mjs", import.meta.url))], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: root, USE_BUILTIN_RIPGREP: "0" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Ripgrep preflight passed (builtin: ${rgPath}).`), result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
