import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { renderGeneratedWrapperContent } from "../lib/generated-wrapper.mjs";

test("POSIX wrapper resolves child node commands from the private runtime", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-generated-wrapper-"));
  try {
    const nodeBin = join(
      root,
      "runtime",
      "node_modules",
      ".agenc-node",
      "bin",
      "node",
    );
    const runtimeBin = join(
      root,
      "runtime",
      "node_modules",
      "@tetsuo-ai",
      "runtime",
      "bin",
      "agenc.cjs",
    );
    const agencHome = join(root, "home");
    const ambientBin = join(root, "ambient-bin");
    const wrapper = join(root, "agenc");
    for (const directory of [
      dirname(nodeBin),
      dirname(runtimeBin),
      agencHome,
      ambientBin,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(nodeBin, [
      "#!/bin/sh",
      'if [ "${1:-}" = "--agenc-private-node-probe" ]; then',
      "  printf 'private-node-path-ok\\n'",
      "  exit 0",
      "fi",
      `exec ${JSON.stringify(process.execPath)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    chmodSync(nodeBin, 0o755);
    writeFileSync(runtimeBin, [
      'const { spawnSync } = require("node:child_process");',
      'const child = spawnSync("node", ["--agenc-private-node-probe"], { encoding: "utf8" });',
      "if (child.error) throw child.error;",
      "process.stdout.write(child.stdout);",
      "",
    ].join("\n"));
    writeFileSync(wrapper, renderGeneratedWrapperContent({
      kind: "posix",
      nodeBin,
      runtimeBin,
      agencHome,
    }), { mode: 0o755 });
    chmodSync(wrapper, 0o755);

    const result = spawnSync(wrapper, [], {
      encoding: "utf8",
      env: {
        PATH: ambientBin,
        NODE_OPTIONS: "--heapsnapshot-near-heap-limit=1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "private-node-path-ok\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows wrapper prepends its private Node directory before exact execution", () => {
  const content = renderGeneratedWrapperContent({
    kind: "cmd",
    nodeBin: "/AgenC Runtime/.agenc-node/node.exe",
    runtimeBin: "/AgenC Runtime/@tetsuo-ai/runtime/bin/agenc",
    agencHome: "/Users/operator/.agenc",
  });
  const pathLine = 'set "PATH=/AgenC Runtime/.agenc-node;%PATH%"';
  const execLine =
    '"/AgenC Runtime/.agenc-node/node.exe" ' +
    '"/AgenC Runtime/@tetsuo-ai/runtime/bin/agenc" %*';

  assert.ok(content.includes(pathLine));
  assert.ok(content.indexOf(pathLine) < content.indexOf(execLine));
});
