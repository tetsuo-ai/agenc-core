import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const checkerSource = readFileSync(
  path.join(import.meta.dirname, "check-agent-surface-contract.mjs"),
  "utf8",
);
const pinnedSource = "pinned source\n";
const pinnedSourceHash = createHash("sha256").update(pinnedSource).digest("hex");

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJsonSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function matrixPath(root) {
  return path.join(root, "parity", "agent-surface-contract.json");
}

function readMatrix(root) {
  return JSON.parse(readFileSync(matrixPath(root), "utf8"));
}

function writeMatrix(root, matrix) {
  writeJson(matrixPath(root), matrix);
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-agent-surface-contract-"));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "parity"));
  mkdirSync(path.join(root, "runtime", "src"), { recursive: true });
  mkdirSync(path.join(root, "runtime", "tests"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "check-agent-surface-contract.mjs"), checkerSource);
  writeFileSync(path.join(root, "runtime", "src", "agent.ts"), "export {};\n");
  writeFileSync(path.join(root, "runtime", "tests", "agent.test.ts"), "export {};\n");
  writeMatrix(root, {
    contractName: "agent-surface-contract-test",
    scope: "test fixture",
    sourceRoot: "../unavailable-source",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    targetRoot: "..",
    sourceFiles: [{ path: "core/src/agent.rs", sha256: pinnedSourceHash }],
    targetFiles: ["runtime/src/agent.ts"],
    testFiles: ["runtime/tests/agent.test.ts"],
    rows: [
      {
        id: "agent",
        status: "required",
        source: ["core/src/agent.rs"],
        target: ["runtime/src/agent.ts"],
        requiredBehaviors: ["keeps the fixture contract"],
        edgeCases: ["runs without a sibling source checkout"],
        tests: ["runtime/tests/agent.test.ts"],
        commands: ["node --version"],
      },
    ],
  });
  return root;
}

function runChecker(root, args = [], { runCommands = false, env = {} } = {}) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "check-agent-surface-contract.mjs"),
      runCommands ? "--run-commands" : "--no-run-commands",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

function runGit(root, args) {
  mkdirSync(path.join(root, ".git-hooks-disabled"), { recursive: true });
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = path.join(root, ".gitconfig-disabled");
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_NO_REPLACE_OBJECTS;
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "commit.gpgSign=false",
      "-c",
      `core.hooksPath=${path.join(root, ".git-hooks-disabled")}`,
      "-c",
      "init.templateDir=",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function commitFixture(root, message) {
  runGit(root, ["add", "."]);
  runGit(root, [
    "-c",
    "user.name=AgenC Contract Test",
    "-c",
    "user.email=contract-test@invalid.example",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

test("default validation runs commands without an external source checkout", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runChecker(root, [], { runCommands: true });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /frozen source ledger validated/);
  assert.match(result.stdout, /source checkout verification skipped/);
  assert.match(result.stdout, /agent-surface-contract: ok/);
});

test("explicit source verification checks Git identity, hashes, and paths with spaces", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missing = runChecker(root, ["--verify-source"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /sourceRoot does not exist/);

  const sourceRoot = path.join(root, "checked out source");
  mkdirSync(path.join(sourceRoot, "core", "src"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "core", "src", "agent.rs"), pinnedSource);
  const notGit = runChecker(root, ["--verify-source", "--source-root", sourceRoot]);
  assert.equal(notGit.status, 1);
  assert.match(notGit.stderr, /sourceRoot is not a Git checkout/);

  runGit(sourceRoot, ["init", "--quiet", "--object-format=sha1"]);
  const expectedCommit = commitFixture(sourceRoot, "pinned source");
  const matrix = readMatrix(root);
  matrix.sourceCommit = expectedCommit;
  writeMatrix(root, matrix);

  const verified = runChecker(root, ["--verify-source", "--source-root", sourceRoot]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, new RegExp(`source checkout verified at ${expectedCommit}`));

  writeFileSync(path.join(sourceRoot, "unrelated.txt"), "new commit\n");
  const wrongCommit = commitFixture(sourceRoot, "move head");
  const moved = runChecker(root, ["--verify-source", "--source-root", sourceRoot]);
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /source Git HEAD .* does not match sourceCommit/);

  matrix.sourceCommit = wrongCommit;
  const dirtySource = "changed\n";
  matrix.sourceFiles[0].sha256 = createHash("sha256").update(dirtySource).digest("hex");
  writeMatrix(root, matrix);
  writeFileSync(path.join(sourceRoot, "core", "src", "agent.rs"), dirtySource);
  const changed = runChecker(root, ["--verify-source", "--source-root", sourceRoot]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /sourceCommit blob hash does not match pinned SHA-256/);
  assert.match(changed.stderr, /source worktree differs from sourceCommit/);
});

test("source verification ignores Git replace refs", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "replace-ref-source");
  mkdirSync(path.join(sourceRoot, "core", "src"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "core", "src", "agent.rs"), pinnedSource);
  runGit(sourceRoot, ["init", "--quiet", "--object-format=sha1"]);
  const originalCommit = commitFixture(sourceRoot, "original source");

  const replacementSource = "replacement source\n";
  writeFileSync(path.join(sourceRoot, "core", "src", "agent.rs"), replacementSource);
  const replacementCommit = commitFixture(sourceRoot, "replacement source");
  runGit(sourceRoot, ["replace", originalCommit, replacementCommit]);
  runGit(sourceRoot, ["checkout", "--detach", "--quiet", originalCommit]);
  writeFileSync(path.join(sourceRoot, "core", "src", "agent.rs"), replacementSource);

  const matrix = readMatrix(root);
  matrix.sourceCommit = originalCommit;
  matrix.sourceFiles[0].sha256 = createHash("sha256")
    .update(replacementSource)
    .digest("hex");
  writeMatrix(root, matrix);

  const result = runChecker(root, ["--verify-source", "--source-root", sourceRoot]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /sourceCommit blob hash does not match pinned SHA-256/);
});

test("source verification accepts in-repository directories beginning with two dots", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRepo = path.join(root, "source-repo");
  const sourceRoot = path.join(sourceRepo, "..source");
  mkdirSync(path.join(sourceRoot, "core", "src"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "core", "src", "agent.rs"), pinnedSource);
  runGit(sourceRepo, ["init", "--quiet", "--object-format=sha1"]);
  const expectedCommit = commitFixture(sourceRepo, "nested source root");

  const matrix = readMatrix(root);
  matrix.sourceCommit = expectedCommit;
  writeMatrix(root, matrix);

  const result = runChecker(root, ["--verify-source", "--source-root", sourceRoot]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`source checkout verified at ${expectedCommit}`));
});

test("source-root overrides are rejected outside explicit verification", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runChecker(root, ["--source-root", path.join(root, "anything")]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--source-root requires --verify-source/);
});

test("CLI parsing rejects typoed, duplicate, and conflicting options", async (t) => {
  const cases = [
    {
      name: "unknown verification typo",
      args: ["--verify-soruce"],
      error: /unknown option: --verify-soruce/,
    },
    {
      name: "duplicate option",
      args: ["--verify-source", "--verify-source"],
      error: /duplicate option: --verify-source/,
    },
    {
      name: "conflicting command modes",
      args: ["--run-commands"],
      error: /conflicting options: --run-commands and --no-run-commands/,
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, (st) => {
      const root = createFixture();
      st.after(() => rmSync(root, { recursive: true, force: true }));

      const result = runChecker(root, fixtureCase.args);

      assert.equal(result.status, 1);
      assert.match(result.stderr, fixtureCase.error);
    });
  }
});

test("offline validation rejects unsafe or ambiguous source metadata", async (t) => {
  const cases = [
    {
      name: "undeclared row source",
      mutate(matrix) {
        matrix.rows[0].source = ["core/src/unpinned.rs"];
      },
      error: /source reference is not declared in sourceFiles: core\/src\/unpinned\.rs/,
    },
    {
      name: "duplicate source",
      mutate(matrix) {
        matrix.sourceFiles.push({ ...matrix.sourceFiles[0] });
      },
      error: /source file is duplicated: core\/src\/agent\.rs/,
    },
    {
      name: "traversal source",
      mutate(matrix) {
        matrix.sourceFiles[0].path = "../agent.rs";
      },
      error: /sourceFiles entry path must be a normalized relative file: \.\.\/agent\.rs/,
    },
    {
      name: "malformed source digest",
      mutate(matrix) {
        matrix.sourceFiles[0].sha256 = "ABC123";
      },
      error: /source file hash must be a lowercase SHA-256/,
    },
    {
      name: "undeclared target",
      mutate(matrix) {
        matrix.rows[0].target = ["runtime/src/other.ts"];
      },
      error: /target reference is not declared in targetFiles: runtime\/src\/other\.ts/,
    },
    {
      name: "review-path row id",
      mutate(matrix) {
        matrix.rows[0].id = "../outside-review";
      },
      error: /id must use lowercase kebab-case/,
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, (st) => {
      const root = createFixture();
      st.after(() => rmSync(root, { recursive: true, force: true }));
      const matrix = readMatrix(root);
      fixtureCase.mutate(matrix);
      writeMatrix(root, matrix);

      const result = runChecker(root);

      assert.equal(result.status, 1);
      assert.match(result.stderr, fixtureCase.error);
    });
  }
});

test("row command failures and timeouts remain fail-closed", async (t) => {
  await t.test("nonzero exit", (st) => {
    const root = createFixture();
    st.after(() => rmSync(root, { recursive: true, force: true }));
    const matrix = readMatrix(root);
    matrix.rows[0].commands = ['node -e "process.exit(7)"'];
    writeMatrix(root, matrix);

    const result = runChecker(root, [], { runCommands: true });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent: command 1 exited 7/);
  });

  await t.test("timeout", async (st) => {
    const root = createFixture();
    st.after(() => rmSync(root, { recursive: true, force: true }));
    const marker = path.join(root, "timeout-child-survived");
    const timeoutChild = path.join(root, "timeout-child.mjs");
    writeFileSync(
      timeoutChild,
      `import { writeFileSync } from "node:fs";\n` +
        `process.on("SIGTERM", () => {});\n` +
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "survived\\n"), 200);\n` +
        `setTimeout(() => {}, 1500);\n`,
    );
    const matrix = readMatrix(root);
    matrix.rows[0].commands = [`node ${JSON.stringify(timeoutChild)}`];
    writeMatrix(root, matrix);

    const startedAt = Date.now();
    const result = runChecker(
      root,
      ["--command-timeout-ms", "50"],
      { runCommands: true },
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent: command 1 timed out after 50ms/);
    assert.ok(elapsedMs < 750, `timeout took ${elapsedMs}ms`);
    await delay(300);
    assert.equal(existsSync(marker), false, "timed-out descendant survived the command tree kill");
  });
});

test("checker cancellation terminates the active command tree", async (t) => {
  const root = createFixture();
  const marker = path.join(root, "cancelled-child-survived");
  let checker;
  t.after(() => {
    if (checker?.exitCode === null && checker?.signalCode === null) checker.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  const cancellationChild = path.join(root, "cancellation-child.mjs");
  writeFileSync(
    cancellationChild,
    `import { writeFileSync } from "node:fs";\n` +
      `process.on("SIGTERM", () => {});\n` +
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "survived\\n"), 200);\n` +
      `setTimeout(() => {}, 1500);\n`,
  );
  const matrix = readMatrix(root);
  matrix.rows[0].commands = [`node ${JSON.stringify(cancellationChild)}`];
  writeMatrix(root, matrix);

  checker = spawn(
    process.execPath,
    [path.join(root, "scripts", "check-agent-surface-contract.mjs"), "--run-commands"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  let stdout = "";
  await new Promise((resolve, reject) => {
    const startupTimeout = setTimeout(
      () => reject(new Error(`checker command did not start; stdout=${stdout}`)),
      5_000,
    );
    checker.stdout.setEncoding("utf8");
    checker.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("agent-surface-contract: running agent command 1")) {
        clearTimeout(startupTimeout);
        resolve();
      }
    });
    checker.once("exit", (code, signal) => {
      if (!stdout.includes("agent-surface-contract: running agent command 1")) {
        clearTimeout(startupTimeout);
        reject(new Error(`checker exited before command start: code=${code} signal=${signal}`));
      }
    });
  });

  checker.kill("SIGTERM");
  const outcome = await new Promise((resolve) => {
    checker.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.notEqual(outcome.code, 0);
  await delay(300);
  assert.equal(existsSync(marker), false, "cancelled descendant survived the command tree kill");
});

test("reviewed mode binds approval to the exact matrix and source commit", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reviews = path.join(root, "parity", "agent-surface-contract.reviews");
  mkdirSync(reviews);
  const matrix = readMatrix(root);
  writeJson(path.join(reviews, "agent.json"), {
    contractName: matrix.contractName,
    rowId: "agent",
    verdict: "APPROVED",
  });
  writeJson(path.join(reviews, "_contract.json"), {
    contractName: matrix.contractName,
    sourceCommit: matrix.sourceCommit,
    contractSha256: canonicalJsonSha256(matrix),
    verdict: "APPROVED",
  });

  const approved = runChecker(root, ["--require-reviews"]);
  assert.equal(approved.status, 0, approved.stderr);

  writeJson(path.join(reviews, "agent.json"), {
    contractName: matrix.contractName,
    rowId: "different-row",
    verdict: "APPROVED",
  });
  const copiedRow = runChecker(root, ["--require-reviews"]);
  assert.equal(copiedRow.status, 1);
  assert.match(copiedRow.stderr, /agent review rowId does not match/);
  writeJson(path.join(reviews, "agent.json"), {
    contractName: matrix.contractName,
    rowId: "agent",
    verdict: "APPROVED",
  });

  matrix.scope = "changed after review";
  writeMatrix(root, matrix);
  const stale = runChecker(root, ["--require-reviews"]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /contract review contractSha256 does not match/);
});

test("ambient row-review state cannot disable explicit review verification", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runChecker(root, ["--require-reviews"], {
    env: { AGENC_AGENT_SURFACE_CONTRACT_ROW_REVIEW: "1" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent review is missing/);
  assert.match(result.stderr, /contract review is missing/);
});
