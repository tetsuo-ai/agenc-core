import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { load as loadYaml } from "js-yaml";

import {
  createGateEnvironment,
  createRequiredGatesRoot,
  REQUIRED_GATES,
  REQUIRED_GATES_REPOSITORY_ROOT,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
  runGate,
  runGateSequence,
  stopOwnedDaemon,
} from "./run-required-gates.mjs";

const runnerPath = path.join(
  REQUIRED_GATES_REPOSITORY_ROOT,
  "scripts",
  "run-required-gates.mjs",
);

function readYaml(relativePath) {
  return loadYaml(
    readFileSync(path.join(REQUIRED_GATES_REPOSITORY_ROOT, relativePath), "utf8"),
  );
}

function collectUses(value, uses = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectUses(item, uses);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "uses" && typeof item === "string") uses.push(item);
      collectUses(item, uses);
    }
  }
  return uses;
}

function needs(job, dependency) {
  const declared = job?.needs;
  return Array.isArray(declared) ? declared.includes(dependency) : declared === dependency;
}

function waitForOutput(stream, pattern, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern} in ${JSON.stringify(output)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (!pattern.test(output)) return;
      cleanup();
      resolve(output);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
    };
    stream.on("data", onData);
  });
}

test("required gate inventory is complete, ordered, and bounded", () => {
  assert.equal(process.version, REQUIRED_NODE_VERSION);
  assert.deepEqual(
    REQUIRED_GATES.map(({ id, args }) => ({ id, args: [...args] })),
    [
      {
        id: "sdk-build",
        args: ["run", "build", "--workspace=@tetsuo-ai/agenc-sdk"],
      },
      {
        id: "sdk-typecheck",
        args: ["run", "typecheck", "--workspace=@tetsuo-ai/agenc-sdk"],
      },
      { id: "runtime-typecheck", args: ["run", "typecheck"] },
      { id: "stable-tests", args: ["test"] },
      { id: "runtime-build", args: ["run", "build"] },
      {
        id: "agent-surface",
        args: ["run", "check:agent-surface-contract"],
      },
      { id: "sbom", args: ["run", "check:sbom"] },
      {
        id: "tui-startup",
        args: [
          "run",
          "check:tui-runtime-startup",
          "--workspace=@tetsuo-ai/runtime",
        ],
      },
    ],
  );
  assert.ok(REQUIRED_GATES.every(({ timeoutMs }) =>
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 20 * 60_000
  ));
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
    encoding: "utf8",
  });
  assert.equal(npm.status, 0, npm.stderr);
  assert.equal(npm.stdout.trim(), REQUIRED_NPM_VERSION);
});

test("required-gates CLI exposes only the reviewed inventory", () => {
  const listed = spawnSync(process.execPath, [runnerPath, "--list-json"], {
    cwd: REQUIRED_GATES_REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), REQUIRED_GATES);

  const typo = spawnSync(process.execPath, [runnerPath, "--list-jsno"], {
    cwd: REQUIRED_GATES_REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /unknown option: --list-jsno/);
});

test("GitHub execution rejects a mismatched SHA before any gate starts", () => {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: REQUIRED_GATES_REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENC_REQUIRED_GATES_SHA: "0000000000000000000000000000000000000000",
      GITHUB_ACTIONS: "true",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match expected SHA/);
  assert.doesNotMatch(result.stdout, /required-gates: running/);
});

test("GitHub execution rejects a missing expected SHA before any gate starts", () => {
  const env = { ...process.env, GITHUB_ACTIONS: "true" };
  delete env.AGENC_REQUIRED_GATES_SHA;
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: REQUIRED_GATES_REPOSITORY_ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENC_REQUIRED_GATES_SHA is required/u);
  assert.doesNotMatch(result.stdout, /required-gates: running/u);
});

test("gate environment strips credentials and isolates writable state", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-required-env-test-"));
  const previous = {
    CORP_DEPLOY_TOKEN: process.env.CORP_DEPLOY_TOKEN,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    NPM_TOKEN: process.env.NPM_TOKEN,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    XAI_API_KEY: process.env.XAI_API_KEY,
    GH_TOKEN: process.env.GH_TOKEN,
    npm_config_script_shell: process.env.npm_config_script_shell,
    npm_config_userconfig: process.env.npm_config_userconfig,
  };
  process.env.CORP_DEPLOY_TOKEN = "must-not-survive";
  process.env.NODE_OPTIONS = "--require=/tmp/untrusted-loader.cjs";
  process.env.NPM_TOKEN = "must-not-survive";
  process.env.SSH_AUTH_SOCK = "/tmp/untrusted-agent.sock";
  process.env.XAI_API_KEY = "must-not-survive";
  process.env.GH_TOKEN = "must-not-survive";
  process.env.npm_config_script_shell = "/tmp/untrusted-shell";
  process.env.npm_config_userconfig = "/tmp/untrusted-npmrc";
  try {
    const env = createGateEnvironment(root);
    assert.equal(env.CORP_DEPLOY_TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.XAI_API_KEY, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.npm_config_script_shell, undefined);
    assert.equal(env.npm_config_userconfig, undefined);
    assert.equal(env.AGENC_AUTH_BACKEND, "local");
    assert.ok(env.AGENC_HOME.startsWith(root));
    assert.ok(env.HOME.startsWith(root));
    assert.ok(env.TMPDIR.startsWith(root));
    assert.ok(env.npm_config_cache.startsWith(root));
    assert.equal(env.npm_config_offline, "true");
    assert.deepEqual(
      Object.keys(env).filter((key) => /TOKEN|SECRET|SOCK|OPTIONS|script_shell|userconfig/u.test(key)),
      [],
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("required-gates state ignores hostile ambient temp roots", (t) => {
  if (process.platform === "win32") return t.skip("POSIX short-root assertion");
  const previous = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.TEMP = "relative-temp";
  process.env.TMP = "/tmp/" + "deep/".repeat(40);
  process.env.TMPDIR = "../retargetable-temp";
  let root;
  try {
    root = createRequiredGatesRoot();
    assert.match(root, /^\/tmp\/agenc-required-gates-/u);
    assert.ok(path.isAbsolute(root));
    assert.ok(root.length < 100);
  } finally {
    if (root) rmSync(root, { force: true, recursive: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("importing the runner does not swallow process termination signals", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX signal assertion");
  const importer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(runnerPath).href)}); console.log("runner-import-ready"); setInterval(() => {}, 1000);`,
    ],
    { cwd: REQUIRED_GATES_REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(importer, "close");
  t.after(() => {
    try {
      importer.kill("SIGKILL");
    } catch {
      // The signal assertion already stopped it.
    }
  });
  await waitForOutput(importer.stdout, /runner-import-ready/u);
  importer.kill("SIGTERM");
  const result = await Promise.race([
    closed.then(([status, signal]) => ({ status, signal })),
    delay(750).then(() => ({ status: "timeout", signal: null })),
  ]);
  assert.notEqual(result.status, "timeout", "runner importer survived SIGTERM");
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM");
});

test("a timed-out gate terminates its descendant process tree", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process-group assertion");
  const root = mkdtempSync(path.join(tmpdir(), "agenc-required-timeout-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const env = createGateEnvironment(root);
  const ready = path.join(root, "ready.txt");
  const marker = path.join(root, "survivor.txt");
  const grandchild = [
    "const fs = require('node:fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'survived'), 1600);`,
    "setTimeout(() => {}, 5000);",
  ].join("");
  const parent = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    "setInterval(() => {}, 5000);",
  ].join("");
  const result = await runGate(
    {
      id: "timeout-fixture",
      args: ["exec", "--", "node", "-e", parent],
      timeoutMs: 1_000,
    },
    env,
  );
  assert.equal(result.timedOut, true);
  assert.equal(existsSync(ready), true, "fixture never reached its survivor spawn");
  await delay(1_800);
  assert.equal(existsSync(marker), false);
});

test("a timed-out gate receives a bounded graceful cleanup phase", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX signal assertion");
  const root = mkdtempSync(path.join(tmpdir(), "agenc-required-term-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const env = createGateEnvironment(root);
  const ready = path.join(root, "ready.txt");
  const cleaned = path.join(root, "cleaned.txt");
  const fixture = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    `process.once('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(cleaned)}, 'cleaned'); process.exit(0); });`,
    "setInterval(() => {}, 5000);",
  ].join("");
  const result = await runGate(
    {
      id: "term-fixture",
      args: ["exec", "--", "node", "-e", fixture],
      timeoutMs: 1_000,
    },
    env,
  );
  assert.equal(result.timedOut, true);
  assert.equal(existsSync(ready), true, "fixture did not start before timeout");
  assert.equal(existsSync(cleaned), true, "SIGTERM cleanup did not run");
});

test("a successful gate drains background descendants before returning", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process-group assertion");
  const root = mkdtempSync(path.join(tmpdir(), "agenc-required-success-tree-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const env = createGateEnvironment(root);
  const ready = path.join(root, "ready.txt");
  const marker = path.join(root, "survivor.txt");
  const grandchild = [
    "const fs = require('node:fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'survived'), 700);`,
    "setTimeout(() => {}, 5000);",
  ].join("");
  const fixture = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }).unref();`,
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
  ].join("");
  const result = await runGate(
    {
      id: "success-tree-fixture",
      args: ["exec", "--", "node", "-e", fixture],
      timeoutMs: 2_000,
    },
    env,
  );
  assert.equal(result.status, 0);
  assert.equal(result.treeError, null);
  assert.equal(existsSync(ready), true);
  await delay(900);
  assert.equal(existsSync(marker), false);
});

test("a failed gate stops the required sequence immediately", async () => {
  const calls = [];
  await assert.rejects(
    runGateSequence(
      [
        { id: "first", label: "First", args: [], timeoutMs: 1_000 },
        { id: "second", label: "Second", args: [], timeoutMs: 1_000 },
      ],
      {},
      async (gate) => {
        calls.push(gate.id);
        return { error: null, signal: null, status: 17, timedOut: false, treeError: null };
      },
    ),
    /first failed with exit 17/u,
  );
  assert.deepEqual(calls, ["first"]);
});

test("owned detached daemons are stopped before private state is removed", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux /proc ownership assertion");
  const root = mkdtempSync(path.join(tmpdir(), "agenc-required-daemon-test-"));
  const env = createGateEnvironment(root);
  const expectedEntrypoint = path.join(
    REQUIRED_GATES_REPOSITORY_ROOT,
    "runtime",
    "dist",
    "bin",
    "agenc.js",
  );
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], { stdio: 'ignore' }).unref(); setInterval(() => {}, 5000);",
      expectedEntrypoint,
      "daemon",
      "start",
      "--foreground",
    ],
    {
      cwd: REQUIRED_GATES_REPOSITORY_ROOT,
      detached: true,
      env,
      stdio: "ignore",
    },
  );
  const spawned = once(child, "spawn");
  const closed = once(child, "close");
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already stopped by the cleanup under test.
    }
    rmSync(root, { force: true, recursive: true });
  });
  await spawned;
  writeFileSync(
    path.join(env.AGENC_HOME, "daemon-runtime.json"),
    `${JSON.stringify({ pid: child.pid })}\n`,
  );

  await stopOwnedDaemon(env);
  await closed;
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
});

test("daemon cleanup refuses a receipt for a process without exact ownership", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux /proc ownership assertion");
  const root = mkdtempSync(path.join(tmpdir(), "agenc-required-unowned-daemon-test-"));
  const env = createGateEnvironment(root);
  const expectedEntrypoint = path.join(
    REQUIRED_GATES_REPOSITORY_ROOT,
    "runtime",
    "dist",
    "bin",
    "agenc.js",
  );
  const child = spawn(
    process.execPath,
    [
      "-e",
      "setInterval(() => {}, 5000)",
      expectedEntrypoint,
      "daemon",
      "start",
      "--foreground",
    ],
    {
      cwd: REQUIRED_GATES_REPOSITORY_ROOT,
      detached: true,
      env: { ...env, AGENC_CONFIG_DIR: path.join(root, "wrong-config") },
      stdio: "ignore",
    },
  );
  const spawned = once(child, "spawn");
  const closed = once(child, "close");
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The explicit cleanup below already stopped it.
    }
    rmSync(root, { force: true, recursive: true });
  });
  await spawned;
  writeFileSync(
    path.join(env.AGENC_HOME, "daemon-runtime.json"),
    `${JSON.stringify({ pid: child.pid })}\n`,
  );

  await assert.rejects(stopOwnedDaemon(env), /refusing to stop unowned daemon/u);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  process.kill(-child.pid, "SIGKILL");
  await closed;
});

test("PR workflow has one stable, least-privilege, unskippable required check", () => {
  const workflow = readYaml(".github/workflows/required-gates.yml");
  assert.deepEqual(Object.keys(workflow.on).sort(), ["merge_group", "pull_request"]);
  assert.deepEqual(workflow.on.merge_group, { types: ["checks_requested"] });
  const pullRequest = workflow.on.pull_request ?? {};
  assert.equal("paths" in pullRequest, false);
  assert.equal("paths-ignore" in pullRequest, false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);

  const jobs = Object.values(workflow.jobs);
  assert.equal(jobs.length, 1);
  const job = workflow.jobs["required-gates"];
  assert.equal(job.name, "agenc-m0-required");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const declaredGateMinutes = REQUIRED_GATES.reduce(
    (total, { timeoutMs }) => total + timeoutMs,
    0,
  ) / 60_000;
  assert.ok(
    job["timeout-minutes"] >= declaredGateMinutes + 15,
    `job timeout ${job["timeout-minutes"]}m cannot contain ${declaredGateMinutes}m of gates plus setup`,
  );
  assert.deepEqual(job.permissions, { contents: "read" });
  const checkout = job.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(
    checkout.uses,
    "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  );
  assert.equal(checkout.with["persist-credentials"], false);
  const gate = job.steps.find(({ uses }) => uses === "./.github/actions/required-gates");
  assert.equal(gate.with["expected-sha"], "${{ github.sha }}");
});

test("shared action binds source before lifecycle code and provisions exact dependencies", () => {
  const action = readYaml(".github/actions/required-gates/action.yml");
  const steps = action.runs.steps;
  const bindIndex = steps.findIndex(({ name }) => name === "Bind the checkout before executing repository code");
  const installIndex = steps.findIndex(({ name }) => name === "Install the committed dependency graph");
  const gateIndex = steps.findIndex(({ name }) => name === "Run the exact required-gates contract");
  assert.equal(bindIndex, 0);
  assert.ok(installIndex > bindIndex);
  assert.ok(gateIndex > installIndex);
  assert.match(steps[bindIndex].run, /test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/);
  const setupNode = steps.find(({ uses }) => uses?.startsWith("actions/setup-node@"));
  assert.equal(
    setupNode.uses,
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  );
  assert.equal(setupNode.with["node-version"], "25.9.0");
  assert.equal(setupNode.with["package-manager-cache"], false);
  assert.match(steps.find(({ name }) => name === "Install the digest-pinned npm release").run,
    /scripts\/fetch-pinned-npm\.mjs/);
  const install = steps[installIndex];
  assert.equal(install.env.npm_config_build_from_source, "false");
  assert.match(install.run, /npm ci --no-audit --no-fund/);
  assert.match(
    steps.find(({ name }) => name === "Provision the digest-pinned hermetic test image").run,
    /docker pull "\$image"/,
  );
  assert.match(steps[gateIndex].run, /npm run check:required-gates/);
});

test("release artifacts cannot run before the same required gate", () => {
  const runtimeRelease = readYaml(".github/workflows/release-runtime.yml");
  const npmRelease = readYaml(".github/workflows/publish-npm.yml");

  assert.deepEqual(npmRelease.permissions, { contents: "read" });
  for (const [workflow, expectedName] of [
    [runtimeRelease, "agenc-runtime-release-gates"],
    [npmRelease, "agenc-npm-release-gates"],
  ]) {
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
    assert.equal(workflow.concurrency.queue, "max");
    const required = workflow.jobs["required-gates"];
    assert.equal(required.name, expectedName);
    assert.ok(needs(required, "release-source"));
    assert.equal(required.permissions.contents, "read");
    assert.ok(required["timeout-minutes"] >= 95);
    assert.equal(
      required.steps.find(({ uses }) => uses === "./.github/actions/required-gates")
        .with["expected-sha"],
      "${{ github.sha }}",
    );
  }
  assert.equal(
    runtimeRelease.concurrency.group,
    "release-runtime-${{ github.ref }}",
  );
  assert.equal(npmRelease.concurrency.group, "publish-npm-production");
  assert.ok(needs(runtimeRelease.jobs["linux-tarball"], "required-gates"));
  assert.ok(needs(runtimeRelease.jobs["native-tarball"], "required-gates"));
  assert.ok(needs(npmRelease.jobs.pack, "required-gates"));
  assert.ok(needs(npmRelease.jobs.publish, "pack"));
  const protectedNameOccurrences = [
    readYaml(".github/workflows/required-gates.yml"),
    runtimeRelease,
    npmRelease,
  ].flatMap((workflow) => Object.values(workflow.jobs).map((job) => job.name))
    .filter((name) => name === "agenc-m0-required");
  assert.equal(protectedNameOccurrences.length, 1);
});

test("every external action reference is pinned to one full commit SHA", () => {
  for (const file of [
    ".github/actions/required-gates/action.yml",
    ".github/workflows/required-gates.yml",
    ".github/workflows/release-runtime.yml",
    ".github/workflows/publish-npm.yml",
  ]) {
    for (const uses of collectUses(readYaml(file))) {
      if (uses.startsWith("./")) continue;
      assert.match(uses, /^[^@\s]+@[0-9a-f]{40}$/, `${file}: ${uses}`);
    }
  }
});
