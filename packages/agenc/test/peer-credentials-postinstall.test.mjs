import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(run, { helper = true, nodeBin = process.execPath, fail = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agenc-postinstall-peer-"));
  try {
    for (const dir of ["scripts", "lib", "runtime/bin", "runtime/dist/bin"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    copyFileSync(join(packageRoot, "scripts/postinstall.mjs"), join(root, "scripts/postinstall.mjs"));
    writeFileSync(join(root, "lib/runtime-manager.mjs"), `
      import { writeFileSync } from 'node:fs';
      export async function ensureRuntimeLaunch() {
        writeFileSync(${JSON.stringify(join(root, "fetched"))}, 'yes');
        return ${JSON.stringify({ runtimeBin: join(root, "runtime/bin/agenc"), nodeBin, nodeLibraryPath: join(root, "pinned-libs") })};
      }
    `);
    if (helper) {
      copyFileSync(join(packageRoot, "../../runtime/bin/prepare-peer-credentials.mjs"), join(root, "runtime/bin/prepare-peer-credentials.mjs"));
      writeFileSync(join(root, "runtime/dist/bin/prepare-peer-credentials.js"), fail
        ? 'throw new Error("compiler unavailable");'
        : `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(root, "prepared"))}, process.env.LD_LIBRARY_PATH);`);
    }
    run(root, (env = {}) => spawnSync(process.execPath, [join(root, "scripts/postinstall.mjs")], {
      env: { ...process.env, CI: "false", AGENC_SKIP_POSTINSTALL: "0", LD_LIBRARY_PATH: "/ambient", ...env },
      encoding: "utf8",
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("postinstall prepares using the installed runtime's library path", () => {
  fixture((root, run) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "prepared"), "utf8"), join(root, "pinned-libs"));
  });
});

test("postinstall uses the pinned Node even when it cannot be executed", () => {
  fixture((root, run) => {
    const result = run();
    assert.equal(result.status, 0);
    assert.match(result.stderr, /native peer credential preparation skipped/);
    assert.equal(existsSync(join(root, "prepared")), false);
  }, { nodeBin: "/missing/agenc-pinned-node" });
});

for (const env of [{ CI: "true" }, { AGENC_SKIP_POSTINSTALL: "1" }]) {
  test(`postinstall honors ${Object.keys(env)[0]} before installation or preparation`, () => {
    fixture((root, run) => {
      assert.equal(run(env).status, 0);
      assert.equal(existsSync(join(root, "fetched")), false);
      assert.equal(existsSync(join(root, "prepared")), false);
    });
  });
}

test("legacy runtime without a helper keeps install success", () => {
  fixture((root, run) => {
    assert.equal(run().status, 0);
    assert.equal(existsSync(join(root, "fetched")), true);
  }, { helper: false });
});

test("preparation failure is nonfatal and leaves startup fallback available", () => {
  fixture((_root, run) => {
    const result = run();
    assert.equal(result.status, 0);
    assert.match(result.stderr, /compiler unavailable.*startup will retry/);
  }, { fail: true });
});

test("runtime source workspace without dist skips preparation", () => {
  fixture((root) => {
    rmSync(join(root, "runtime/dist"), { recursive: true });
    const result = spawnSync(process.execPath, [join(root, "runtime/bin/prepare-peer-credentials.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  });
});
