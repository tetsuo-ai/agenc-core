import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkEvalEffort } from "./check-eval-effort.mjs";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "agenc-compare-agents-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// An AgenC eval home whose config.toml holds `config`, or has none when it is undefined.
function withEvalHome(config, run) {
  return withTempDir((home) => {
    if (config !== undefined) writeFileSync(join(home, "config.toml"), config);
    return run(home);
  });
}

test("the effort check accepts an eval home whose config.toml sets EFFORT", () => {
  withEvalHome("model_provider = \"grok\"\nreasoning_effort = \"medium\" # pinned for the comparison\n", (home) => {
    const result = spawnSync(process.execPath, [here("./check-eval-effort.mjs"), home, "medium"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  });
});

test("the effort check refuses a config.toml that sets another effort", () => {
  withEvalHome("reasoning_effort = \"xhigh\"\n", (home) => {
    assert.throws(() => checkEvalEffort({ home, effort: "medium" }), {
      message: `${join(home, "config.toml")} sets reasoning_effort = "xhigh", but EFFORT is "medium"; ` +
        "set reasoning_effort = \"medium\" there so every agent runs at the same effort",
    });
  });
});

test("the effort check refuses a config.toml that sets the effort only in a profile", () => {
  withEvalHome("[profiles.eval]\nreasoning_effort = \"medium\"\n", (home) => {
    assert.throws(
      () => checkEvalEffort({ home, effort: "medium" }),
      /config\.toml does not set reasoning_effort, but EFFORT is "medium"/u,
    );
  });
});

test("the effort check refuses an eval home without config.toml", () => {
  withEvalHome(undefined, (home) => {
    assert.throws(() => checkEvalEffort({ home, effort: "medium" }), /cannot read .*config\.toml: ENOENT/u);
  });
});

test("compare-agents.sh refuses a mismatched eval home before it runs an agent", () => {
  withEvalHome("reasoning_effort = \"xhigh\"\n", (home) => {
    const ran = join(home, "agent-ran");
    const agent = join(home, "agent");
    writeFileSync(agent, `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 });
    const run = `effort-check-${process.pid}`;
    const reports = here(`../eval/reports/${run}`);
    try {
      const result = spawnSync("bash", [here("./compare-agents.sh"), "commands"], {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          PROVIDER: "grok",
          MODEL: "grok-4.6",
          KEY_VAR: "EFFORT_CHECK_KEY",
          EFFORT_CHECK_KEY: "unused",
          AGENC_BIN: agent,
          HERMES_BIN: agent,
          OPENCODE_BIN: agent,
          AGENC_EVAL_HOME: home,
          RUN: run,
          NODE: process.execPath,
        },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /sets reasoning_effort = "xhigh", but EFFORT is "medium"/u);
      assert.equal(existsSync(ran), false, "an agent ran");
      assert.equal(existsSync(reports), false, "the run wrote a report directory");
    } finally {
      rmSync(reports, { recursive: true, force: true });
    }
  });
});

test("the comparison table states the reasoning effort it is given", () => {
  withTempDir((root) => {
    const table = join(root, "scripts", "eval-compare-table.mjs");
    const reports = join(root, "eval", "reports", "run");
    mkdirSync(join(root, "scripts"));
    mkdirSync(reports, { recursive: true });
    copyFileSync(here("./eval-compare-table.mjs"), table);
    const report = (id) => JSON.stringify({ run: { agent: { name: "agenc" } }, tasks: [{ id, status: "passed", durationMs: 1000 }] });
    writeFileSync(join(reports, "agenc-tag-commands.json"), report("add-clamp"));
    writeFileSync(join(reports, "agenc-tag-session.json"), report("asteroid-drift-15"));
    const headings = (...args) => {
      const result = spawnSync(process.execPath, [table, "run", "tag", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.split("\n").filter((line) => line.startsWith("## "));
    };
    assert.deepEqual(headings("medium"), [
      "## Command tasks (reasoning effort medium)",
      "## Session task (reasoning effort medium)",
    ]);
    assert.deepEqual(headings(), ["## Command tasks", "## Session task"]);
  });
});
