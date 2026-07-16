import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  assertExactSource,
  classifySystemdWorkerResult,
  createGateEnvironment,
  createRequiredGatesRoot,
  environmentForGate,
  REQUIRED_GATES,
  REQUIRED_GATES_REPOSITORY_ROOT,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
  runGate,
  runGateSequence,
  stopOwnedDaemon,
} from "./run-required-gates.mjs";
import {
  buildSystemdJobMountCommand,
  buildSystemdJobUnmountCommand,
  buildSystemdWorkerCommand,
  assertCgroupAncestorCapacity,
  assertCgroupResourceProfile,
  assertDockerCgroupPlacement,
  LOCAL_GATE_AGGREGATE_LIMITS,
  LOCAL_GATE_AGGREGATE_SLICE,
  LOCAL_GATE_COMBINED_LIMITS,
} from "./systemd-worker-sandbox.mjs";
import {
  computeRequiredGateContract,
  REQUIRED_GATE_CONTEXT,
  REQUIRED_GATE_POLICY_PATHS,
} from "./required-gate-contract.mjs";
import { proveDockerDaemonQuiescence } from "./docker-quiescence.mjs";

const runnerPath = path.join(
  REQUIRED_GATES_REPOSITORY_ROOT,
  "scripts",
  "run-required-gates.mjs",
);

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
        id: "launcher-tests",
        args: ["test", "--workspace=@tetsuo-ai/agenc"],
      },
      { id: "gate-policy-tests", args: ["run", "test:required-gates"] },
      {
        id: "agent-surface-tests",
        args: ["run", "test:agent-surface-contract"],
      },
      {
        id: "stable-tests",
        args: ["runtime/scripts/run-hermetic-test-boundary.mjs", "run"],
      },
      {
        id: "agent-surface",
        args: ["run", "check:agent-surface-contract", "--", "--no-run-commands"],
      },
      { id: "runtime-build", args: ["run", "build"] },
      { id: "sbom", args: ["run", "check:sbom"] },
      {
        id: "tui-startup",
        args: ["runtime/scripts/check-tui-runtime-startup.mjs"],
      },
    ],
  );
  assert.ok(REQUIRED_GATES.every(({ timeoutMs }) =>
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 20 * 60_000
  ));
  assert.deepEqual(
    REQUIRED_GATES.filter(({ dockerAccess }) => dockerAccess).map(({ id }) => id),
    ["stable-tests"],
  );
  assert.ok(REQUIRED_GATES.every(({ executable, writablePaths, freezePaths }) =>
    ["node", "npm", "trusted-node"].includes(executable) &&
    [writablePaths, freezePaths].every((paths) => paths.every((relativePath) =>
      !path.isAbsolute(relativePath) && !relativePath.includes("..")
    ))
  ));
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
    encoding: "utf8",
  });
  assert.equal(npm.status, 0, npm.stderr);
  assert.equal(npm.stdout.trim(), REQUIRED_NPM_VERSION);
});

test("Docker cleanup waits through late daemon-side container materialization", async () => {
  const late = "a".repeat(64);
  const observations = [[], [], [late], [], [], [], [], []];
  const removed = [];
  const stable = await proveDockerDaemonQuiescence({
    listContainers: async () => observations.shift() ?? [],
    removeContainers: async (containers) => removed.push(...containers),
    emptySamples: 5,
    sampleIntervalMs: 0,
    wait: async () => {},
  });
  assert.deepEqual(removed, [late]);
  assert.deepEqual(stable.recoveredIds, [late]);
  assert.equal(stable.observations, 8);
});

test("Docker preflight cannot green from a single empty inventory", async () => {
  const late = "b".repeat(64);
  const observations = [[], [], [late]];
  await assert.rejects(
    proveDockerDaemonQuiescence({
      listContainers: async () => observations.shift() ?? [],
      emptySamples: 5,
      sampleIntervalMs: 0,
      wait: async () => {},
    }),
    /retained 1 container/u,
  );
});

test("required-gates CLI exposes only the reviewed inventory and contract", () => {
  const listed = spawnSync(process.execPath, [runnerPath, "--list-json"], {
    cwd: REQUIRED_GATES_REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), REQUIRED_GATES);

  const contract = spawnSync(process.execPath, [runnerPath, "--contract-json"], {
    cwd: REQUIRED_GATES_REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(contract.status, 0, contract.stderr);
  const parsedContract = JSON.parse(contract.stdout);
  assert.equal(parsedContract.context, REQUIRED_GATE_CONTEXT);
  assert.match(parsedContract.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(
    parsedContract.files.map(({ path: relativePath }) => relativePath),
    REQUIRED_GATE_POLICY_PATHS,
  );

  const typo = spawnSync(process.execPath, [runnerPath, "--list-jsno"], {
    cwd: REQUIRED_GATES_REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(typo.status, 20);
  assert.match(typo.stderr, /unknown option: --list-jsno/);
});

test("required gate rejects a mismatched expected SHA before any gate starts", () => {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: REQUIRED_GATES_REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENC_REQUIRED_GATES_SHA: "0000000000000000000000000000000000000000",
    },
  });
  assert.equal(result.status, 20);
  assert.match(result.stderr, /does not match expected SHA/);
  assert.doesNotMatch(result.stdout, /required-gates: running/);
});

test("ending source validation rejects a commit that moved after the gate", () => {
  const expected = "1".repeat(40);
  assert.throws(
    () => assertExactSource(expected, (args) => {
      if (args[0] === "rev-parse") return "2".repeat(40);
      if (args[0] === "status") return "";
      throw new Error(`unexpected fake git arguments: ${args.join(" ")}`);
    }),
    /does not match expected SHA/u,
  );
});

test("required gate contract is deterministic and mutation-sensitive", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-gate-contract-"));
  try {
    writeFileSync(path.join(root, "a"), "alpha\n");
    writeFileSync(path.join(root, "b"), "beta\n");
    const first = computeRequiredGateContract({ repositoryRoot: root, policyPaths: ["a", "b"] });
    const second = computeRequiredGateContract({ repositoryRoot: root, policyPaths: ["a", "b"] });
    assert.deepEqual(first, second);
    writeFileSync(path.join(root, "b"), "changed\n");
    const changed = computeRequiredGateContract({ repositoryRoot: root, policyPaths: ["a", "b"] });
    assert.notEqual(changed.sha256, first.sha256);
    assert.notEqual(changed.files[1].sha256, first.files[1].sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact freeze rejects nested and root symlinks", (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink assertion");
  // The authoritative gate mounts the candidate checkout read-only. Keep this
  // fixture in the gate-private TMPDIR and import the trusted runner in a child
  // with an explicitly injected repository root, matching that confinement.
  const fixture = mkdtempSync(path.join(tmpdir(), "agenc-artifact-freeze-test-"));
  try {
    const target = path.join(fixture, "target");
    const nested = path.join(fixture, "nested");
    mkdirSync(target);
    mkdirSync(nested);
    writeFileSync(path.join(target, "payload.txt"), "trusted artifact\n");
    const nestedLink = path.join(nested, "00-linked-payload.txt");
    symlinkSync("../target/payload.txt", nestedLink);

    const rootLink = path.join(fixture, "linked-dist");
    symlinkSync("target", rootLink, "dir");
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          "import assert from 'node:assert/strict';",
          "const runner = await import(process.argv[2]);",
          "const nested = process.argv[3];",
          "const rootLink = process.argv[4];",
          "assert.throws(() => runner.freezeArtifactTree(nested), /artifact contains a symbolic link.*00-linked-payload\\.txt/u);",
          "assert.throws(() => runner.artifactTreeDigest(nested), /artifact contains a symbolic link.*00-linked-payload\\.txt/u);",
          "assert.throws(() => runner.freezeArtifactTree(rootLink), /artifact contains a symbolic link.*linked-dist/u);",
          "assert.throws(() => runner.artifactTreeDigest(rootLink), /artifact contains a symbolic link.*linked-dist/u);",
        ].join("\n"),
        "/dev/null",
        pathToFileURL(runnerPath).href,
        nested,
        rootLink,
      ],
      {
        cwd: REQUIRED_GATES_REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENC_REQUIRED_GATES_REPOSITORY_ROOT: fixture,
        },
      },
    );
    assert.equal(probe.status, 0, probe.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
    DOCKER_HOST: process.env.DOCKER_HOST,
    AGENC_REQUIRED_GATES_DOCKER_HOST: process.env.AGENC_REQUIRED_GATES_DOCKER_HOST,
    npm_config_script_shell: process.env.npm_config_script_shell,
    npm_config_userconfig: process.env.npm_config_userconfig,
  };
  process.env.CORP_DEPLOY_TOKEN = "must-not-survive";
  process.env.NODE_OPTIONS = "--require=/tmp/untrusted-loader.cjs";
  process.env.NPM_TOKEN = "must-not-survive";
  process.env.SSH_AUTH_SOCK = "/tmp/untrusted-agent.sock";
  process.env.XAI_API_KEY = "must-not-survive";
  process.env.GH_TOKEN = "must-not-survive";
  process.env.DOCKER_HOST = "tcp://attacker.invalid:2375";
  delete process.env.AGENC_REQUIRED_GATES_DOCKER_HOST;
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
    assert.equal(env.DOCKER_HOST, undefined);
    assert.equal(env.npm_config_script_shell, "/bin/sh");
    assert.equal(env.npm_config_userconfig, "/nonexistent/agenc-required-gates-user-npmrc");
    assert.equal(env.npm_config_globalconfig, "/dev/null");
    assert.equal(env.AGENC_AUTH_BACKEND, "local");
    assert.ok(env.AGENC_HOME.startsWith(root));
    assert.ok(env.HOME.startsWith(root));
    assert.ok(env.TMPDIR.startsWith(root));
    assert.ok(env.npm_config_cache.startsWith(root));
    assert.equal(env.npm_config_offline, "true");
    assert.deepEqual(
      Object.keys(env).filter((key) => /TOKEN|SECRET|SOCK/u.test(key)),
      [],
    );
    process.env.AGENC_REQUIRED_GATES_DOCKER_HOST = "unix:///run/user/992/docker.sock";
    const rootless = createGateEnvironment(path.join(root, "rootless"));
    assert.equal(rootless.DOCKER_HOST, undefined);
    assert.equal(
      environmentForGate(rootless, { dockerAccess: true }).DOCKER_HOST,
      "unix:///run/user/992/docker.sock",
    );
    assert.equal(
      environmentForGate(rootless, { dockerAccess: false }).DOCKER_HOST,
      undefined,
    );
    process.env.AGENC_REQUIRED_GATES_DOCKER_HOST = "unix:///var/run/docker.sock";
    assert.throws(
      () => environmentForGate(
        createGateEnvironment(path.join(root, "rootful")),
        { dockerAccess: true },
      ),
      /only an explicit rootless Docker user socket/u,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("transient systemd workers bind to the dispatcher and expose Docker only to the stable gate", () => {
  const common = {
    unitName: "agenc-local-gate-deadbeef",
    parentUnit: "agenc-local-gate-dispatcher@pr-1505.service",
    uid: 992,
    gid: 992,
    cwd: "/var/lib/agenc-local-gatekeeper/job/source",
    environment: { CI: "1", PATH: "/opt/node/bin:/usr/bin:/bin" },
    command: "/opt/node/bin/node",
    args: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js", "run", "typecheck"],
    readWritePaths: ["/var/lib/agenc-local-gatekeeper/job/runs/typecheck"],
    inaccessiblePaths: ["/var/lib/agenc-gate-worker"],
    runtimeMaxSeconds: 300,
  };
  const isolated = buildSystemdWorkerCommand({ ...common, dockerAccess: false });
  assert.equal(isolated.unitName, "agenc-local-gate-deadbeef.service");
  assert.equal(
    isolated.args.filter((value) => value === `--slice=${LOCAL_GATE_AGGREGATE_SLICE}`).length,
    1,
  );
  assert.ok(isolated.args.includes("--property=BindsTo=agenc-local-gate-dispatcher@pr-1505.service"));
  assert.ok(isolated.args.includes("--property=ExitType=main"));
  assert.ok(isolated.args.includes("--property=PrivateNetwork=yes"));
  assert.ok(isolated.args.includes("--property=RestrictAddressFamilies=AF_UNIX"));
  assert.ok(isolated.args.includes("--property=ProtectHome=yes"));
  assert.ok(isolated.args.includes("--property=SupplementaryGroups=992"));
  assert.ok(isolated.args.includes("--property=InaccessiblePaths=-/run/docker.sock"));
  assert.ok(isolated.args.includes("--property=InaccessiblePaths=/var/lib/agenc-gate-worker"));
  assert.ok(isolated.args.includes("--property=TemporaryFileSystem=/run:ro"));
  assert.ok(isolated.args.includes(
    "--property=TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=512M,nr_inodes=65536,mode=1777",
  ));
  assert.ok(isolated.args.includes(
    "--property=TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,size=128M,nr_inodes=16384,mode=1777",
  ));
  assert.equal(isolated.args.includes("--property=PrivateTmp=yes"), false);
  assert.equal(isolated.args.includes("--collect"), false);
  assert.equal(
    isolated.args.some((value) => value.includes("After=agenc-local-gate-dispatcher@")),
    false,
  );

  const installer = buildSystemdWorkerCommand({
    ...common,
    networkAccess: true,
  });
  assert.ok(installer.args.includes("--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"));
  assert.equal(installer.args.includes("--property=PrivateNetwork=yes"), false);
  assert.equal(installer.args.includes("--property=IPAddressDeny=any"), false);
  assert.equal(installer.args.includes("--property=TemporaryFileSystem=/run:ro"), false);

  const docker = buildSystemdWorkerCommand({
    ...common,
    dockerAccess: true,
    dockerSocketPath: "/run/user/992/docker.sock",
  });
  assert.ok(docker.args.includes("--property=ProtectHome=tmpfs"));
  assert.ok(docker.args.includes("--property=BindReadOnlyPaths=/run/user/992/docker.sock"));
  assert.ok(docker.args.includes("--property=TemporaryFileSystem=/run:ro"));
  assert.equal(
    docker.args.some((value) => value.includes("InaccessiblePaths=") && value.includes("docker.sock")),
    false,
  );
  assert.throws(
    () => buildSystemdWorkerCommand({
      ...common,
      cwd: "/var/lib/agenc-local-gatekeeper/%n/source",
      dockerAccess: false,
    }),
    /safe absolute path/u,
  );
  assert.throws(
    () => buildSystemdWorkerCommand({
      ...common,
      dockerAccess: true,
      dockerSocketPath: "/run/user/992/docker.sock",
      networkAccess: true,
    }),
    /mutually exclusive/u,
  );
  assert.throws(
    () => buildSystemdWorkerCommand({
      ...common,
      readWritePaths: ["/var/lib/agenc-local-gatekeeper/path with space"],
      dockerAccess: false,
    }),
    /safe absolute path/u,
  );
});

test("bounded job filesystems are exact dispatcher-bound tmpfs mounts", () => {
  const mountPath = `/var/lib/agenc-local-gatekeeper/pr-1505-job-${"a".repeat(32)}`;
  const mounted = buildSystemdJobMountCommand({
    jobId: "a".repeat(32),
    parentUnit: "agenc-local-gate-dispatcher@pr-1505.service",
    mountPath,
  });
  assert.equal(mounted.command, "/usr/bin/systemd-mount");
  assert.equal(mounted.source, `agenc-local-gate-job-${"a".repeat(32)}`);
  assert.ok(mounted.args.includes(
    "--property=BindsTo=agenc-local-gate-dispatcher@pr-1505.service",
  ));
  assert.ok(mounted.args.includes(
    "--property=PartOf=agenc-local-gate-dispatcher@pr-1505.service",
  ));
  assert.ok(mounted.args.includes("--property=Slice=system-agencgate.slice"));
  assert.ok(mounted.args.includes(
    "--options=rw,nosuid,nodev,size=16G,nr_inodes=1000000,mode=0711",
  ));
  assert.equal(mounted.args.includes("--no-block"), false);
  assert.deepEqual(
    buildSystemdJobUnmountCommand(mountPath).args.slice(-2),
    ["--umount", mountPath],
  );
});

test("aggregate cgroup records enforce exact local-gate limits and parent capacity", () => {
  const exact = {
    "cpu.max": "800000 100000",
    "memory.high": "12884901888",
    "memory.max": "17179869184",
    "memory.swap.max": "0",
    "memory.zswap.max": "0",
    "pids.max": "4096",
    "cgroup.subtree_control": "cpu memory pids",
  };
  assert.doesNotThrow(() => assertCgroupResourceProfile(exact, LOCAL_GATE_AGGREGATE_LIMITS));
  for (const drift of [
    { "memory.max": "max" },
    { "memory.zswap.max": "max" },
    { "pids.max": "4097" },
    { "cgroup.subtree_control": "cpu memory" },
  ]) {
    assert.throws(
      () => assertCgroupResourceProfile({ ...exact, ...drift }, LOCAL_GATE_AGGREGATE_LIMITS),
      /cgroup/u,
    );
  }
  assert.doesNotThrow(() => assertCgroupAncestorCapacity({
    "cpu.max": "max 100000",
    "memory.high": "max",
    "memory.max": "34359738368",
    "pids.max": "8192",
  }, LOCAL_GATE_AGGREGATE_LIMITS));
  assert.throws(() => assertCgroupAncestorCapacity({
    "cpu.max": "400000 100000",
    "memory.high": "12884901888",
    "memory.max": "17179869184",
    "pids.max": "4096",
  }, LOCAL_GATE_AGGREGATE_LIMITS), /CPU capacity/u);
  assert.doesNotThrow(() => assertCgroupAncestorCapacity({
    "cpu.max": "max 100000",
    "memory.high": "max",
    "memory.max": "51539607552",
    "pids.max": "32768",
  }, LOCAL_GATE_COMBINED_LIMITS));
  assert.throws(() => assertCgroupAncestorCapacity({
    "cpu.max": "1600000 100000",
    "memory.high": "27917287424",
    "memory.max": "17179869184",
    "pids.max": "16384",
  }, LOCAL_GATE_COMBINED_LIMITS), /below the reviewed/u);
});

test("rootless Docker daemon must remain beneath the capped delegated user slice", () => {
  const record = {
    dockerUid: 993,
    userManager: {
      ActiveState: "active",
      ControlGroup: "/user.slice/user-993.slice/user@993.service",
      Delegate: "yes",
      DelegateControllers: "cpu memory pids",
    },
    dockerService: {
      ActiveState: "active",
      MainPID: "4242",
      ControlGroup: "/user.slice/user-993.slice/user@993.service/app.slice/docker.service",
    },
  };
  assert.doesNotThrow(() => assertDockerCgroupPlacement(record));
  for (const drift of [
    { userManager: { ...record.userManager, DelegateControllers: "cpu memory" } },
    { dockerService: { ...record.dockerService, ControlGroup: "/user.slice/user-993.slice/escape/docker.service" } },
  ]) {
    assert.throws(() => assertDockerCgroupPlacement({ ...record, ...drift }), /Docker|delegate/u);
  }
});

test("systemd result classification publishes only authoritative command outcomes", () => {
  const failed = {
    ActiveState: "failed",
    SubState: "failed",
    Result: "exit-code",
    ExecMainCode: "1",
    ExecMainStatus: "7",
    ControlGroup: "",
  };
  assert.deepEqual(
    classifySystemdWorkerResult({ error: null, status: 7, signal: null }, failed),
    { error: null, status: 7, signal: null, timedOut: false, treeError: null },
  );
  assert.match(
    classifySystemdWorkerResult(
      { error: null, status: 1, signal: null },
      { ...failed, ExecMainStatus: "203" },
    ).error.message,
    /infrastructure/u,
  );
  assert.match(
    classifySystemdWorkerResult({ error: null, status: 1, signal: null }, null).error.message,
    /without an inspectable transient unit/u,
  );
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
    assert.match(root, /^\/tmp\/agr-/u);
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

test("gate temp root preserves Unix socket headroom for nested contract suites", async (t) => {
  if (process.platform === "win32") return t.skip("Unix socket path assertion");
  const root = createRequiredGatesRoot();
  const env = createGateEnvironment(root);
  const socketDirectory = path.join(
    env.TMPDIR,
    "agenc-vitest-hermetic-home-ABCDEF",
    "tmp",
    "agenc-agent-connection-state-ABCDEF",
  );
  const socketPath = path.join(socketDirectory, "daemon.sock");
  mkdirSync(socketDirectory, { mode: 0o700, recursive: true });
  const server = createServer();
  t.after(() => {
    if (server.listening) server.close();
    rmSync(root, { force: true, recursive: true });
  });

  assert.ok(
    Buffer.byteLength(socketPath) < 104,
    `nested Unix socket path needs cross-platform headroom: ${socketPath}`,
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
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
