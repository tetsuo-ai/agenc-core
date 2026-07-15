import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertApprovedDependencySources,
  assertCandidateIndexShape,
  assertDedicatedIdentityRecord,
  assertDockerCanaryCgroupRecords,
  assertDockerCanaryInspectRecord,
  assertDockerInfoBaseline,
  assertDockerPluginInventoryEmpty,
  assertJobFilesystemRootMetadata,
  assertLoadedSystemdUnitRecord,
  assertRootlessDockerSocketRecord,
  buildOfflineNativeBuildEnvironment,
  cleanupStaleJobRoots,
  findDockerCanaryCgroupPath,
  GateOutcomeFailure,
  parseDockerContainerIds,
  parseDockerDataRootMountRecord,
  parseDockerNetworkInventory,
  parseDockerSystemDf,
  parseJobMountRecord,
  parseTransientGateUnitInventory,
  pruneExpiredReadyEnvelopes,
  pruneGateLogs,
  runLocalGatePublisher,
  runLocalGateWorker,
  runLogged,
} from "./local-gatekeeper.mjs";
import {
  REQUIRED_DOCKER_IMAGE,
  REQUIRED_GATE_CONTEXT,
  REQUIRED_GATE_REPOSITORY_ROOT,
  REQUIRED_GATE_SCHEMA_VERSION,
} from "./required-gate-contract.mjs";
import { buildSystemdPublisherCommand } from "./systemd-worker-sandbox.mjs";

const SOURCE_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const CONTRACT_SHA = "a".repeat(64);
const CONTRACT = Object.freeze({
  schemaVersion: REQUIRED_GATE_SCHEMA_VERSION,
  context: REQUIRED_GATE_CONTEXT,
  sha256: CONTRACT_SHA,
});
const WORKER_NOW = () => {
  const values = [
    new Date("2026-07-15T12:00:00Z"),
    new Date("2026-07-15T12:01:00Z"),
    new Date("2026-07-15T12:01:01Z"),
  ];
  return () => values.shift();
};
const PUBLISH_NOW = () => new Date("2026-07-15T12:02:00Z");
const TEST_JOB_FILESYSTEM = Object.freeze({
  mount: async () => {},
  unmount: async () => {},
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pullRequest(sha = SOURCE_SHA) {
  return {
    state: "open",
    draft: false,
    head: {
      sha,
      ref: "feature/local-gate",
      repo: { full_name: "tetsuo-ai/agenc-core" },
    },
    base: { sha: BASE_SHA, ref: "main" },
  };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-local-gatekeeper-test-"));
  const stateDirectory = path.join(root, "state");
  const logDirectory = path.join(root, "logs");
  const workerHome = path.join(root, "worker");
  for (const directory of [stateDirectory, logDirectory, workerHome]) {
    mkdirSync(directory, { recursive: true });
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    root,
    config: {
      schemaVersion: 1,
      repository: "tetsuo-ai/agenc-core",
      approvedContractSha256: CONTRACT_SHA,
      executorId: "test-gatekeeper",
      githubAppId: 42,
      githubClientId: "Iv1.1234567890abcdef",
      githubInstallationId: 77,
      dockerDataDevice: "/dev/mapper/agenc-gate-docker",
      dockerDataRoot: path.join(root, "docker-data"),
      dockerUid: (process.getuid?.() ?? 1) + 1,
      dockerGid: (process.getgid?.() ?? 1) + 1,
      workerUid: process.getuid?.() ?? 1,
      workerGid: process.getgid?.() ?? 1,
      nodePath: process.execPath,
      npmPath: process.execPath,
      dockerHost: "unix:///run/user/1000/docker.sock",
      stateDirectory,
      logDirectory,
      workerHome,
    },
    privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
  };
}

function githubMock({ prShas = [SOURCE_SHA], mainShas = [SOURCE_SHA] } = {}) {
  let pullReads = 0;
  let mainReads = 0;
  let persistedCheck;
  const requests = [];
  const next = (values, index) => values[Math.min(index, values.length - 1)];
  const fetchImpl = async (url, options) => {
    const request = {
      url: String(url),
      method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    requests.push(request);
    if (request.url.endsWith("/git/ref/heads/main")) {
      const sha = next(mainShas, mainReads);
      mainReads += 1;
      return response({ ref: "refs/heads/main", object: { type: "commit", sha } });
    }
    if (request.url.endsWith("/pulls/1505")) {
      const sha = next(prShas, pullReads);
      pullReads += 1;
      return response(pullRequest(sha));
    }
    if (request.url.endsWith("/app/installations/77/access_tokens")) {
      return response({
        token: "installation-token-value-123",
        expires_at: "2026-07-15T13:00:00Z",
        permissions: { checks: "write", metadata: "read" },
        repository_selection: "selected",
        repositories: [{
          id: 123,
          name: "agenc-core",
          full_name: "tetsuo-ai/agenc-core",
        }],
      }, 201);
    }
    if (request.url.endsWith("/app/installations/77")) {
      return response({
        id: 77,
        app_id: 42,
        repository_selection: "selected",
        target_type: "Organization",
        account: { login: "tetsuo-ai", type: "Organization" },
        suspended_at: null,
        events: [],
        permissions: { checks: "write", statuses: "write", metadata: "read" },
      });
    }
    if (request.method === "GET" && request.url.includes("/check-suites?")) {
      return response({
        total_count: persistedCheck === undefined ? 0 : 1,
        check_suites: persistedCheck === undefined
          ? []
          : [{ id: 501, head_sha: SOURCE_SHA, app: { id: 42 } }],
      });
    }
    if (request.method === "GET" && request.url.includes("/check-suites/501/check-runs?")) {
      const checkRuns = persistedCheck === undefined ? [] : [persistedCheck];
      return response({ total_count: checkRuns.length, check_runs: checkRuns });
    }
    if (request.method === "POST" && request.url.endsWith("/check-runs")) {
      persistedCheck = {
        ...request.body,
        id: 91,
        app: { id: 42 },
        check_suite: { id: 501 },
      };
      return response(persistedCheck, 201);
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  };
  return { fetchImpl, requests };
}

test("candidate index rejects symlinks, gitlinks, and tracked scratch collisions", () => {
  const oid = "1".repeat(40);
  assert.doesNotThrow(() => assertCandidateIndexShape(`100644 ${oid} 0\tREADME.md\0`));
  for (const [record, pattern] of [
    [`120000 ${oid} 0\truntime/dist\0`, /unsupported mode 120000/u],
    [`160000 ${oid} 0\tthird-party/submodule\0`, /unsupported mode 160000/u],
    [`100644 ${oid} 0\truntime/node_modules/injected.js\0`, /collides with worker scratch/u],
    [`100644 ${oid} 0\t../outside\0`, /path is unsafe/u],
  ]) {
    assert.throws(() => assertCandidateIndexShape(record), pattern);
  }
});

test("candidate Git parsing is confined to transient worker units", () => {
  const source = readFileSync(
    path.join(REQUIRED_GATE_REPOSITORY_ROOT, "scripts/local-gatekeeper.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /runLogged\(git\b|runCapture\(git\b/u);
  assert.doesNotMatch(source, /--filter=blob:none/u);
  assert.match(source, /runSystemdWorkerLogged\(\{[\s\S]*command: git/u);
  assert.match(source, /runSystemdWorkerCaptured\(\{[\s\S]*command: git/u);
  assert.match(source, /label: "fetch exact remote PR head",[\s\S]*?networkAccess: true/u);
  assert.match(source, /label: "checkout exact PR head",[\s\S]*?parentUnit,/u);
});

test("dependency acquisition accepts only SHA-512-pinned npm registry artifacts", () => {
  const valid = {
    lockfileVersion: 3,
    packages: {
      "": { name: "agenc-core" },
      "node_modules/@tetsuo-ai/agenc": { resolved: "packages/agenc", link: true },
      "node_modules/example": {
        resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
    },
  };
  assert.doesNotThrow(() => assertApprovedDependencySources(valid));
  for (const mutate of [
    (value) => { value.packages["node_modules/example"].resolved = "https://evil.example/pkg.tgz"; },
    (value) => { value.packages["node_modules/example"].resolved = "http://registry.npmjs.org/pkg.tgz"; },
    (value) => { value.packages["node_modules/example"].resolved += "?token=secret"; },
    (value) => { value.packages["node_modules/example"].integrity = "sha1-deadbeef"; },
    (value) => {
      delete value.packages["node_modules/example"].resolved;
      delete value.packages["node_modules/example"].integrity;
      value.packages["node_modules/example"].name = "example";
      value.packages["node_modules/example"].version = "1.0.0";
    },
    (value) => {
      value.packages["node_modules/foreign-link"] = { resolved: "runtime", link: true };
    },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(
      () => assertApprovedDependencySources(changed),
      /approved registry URL|SHA-512-pinned|no pinned source/u,
    );
  }
});

test("native rebuild is source-only, offline, and bound to reviewed local headers and tools", () => {
  const environment = buildOfflineNativeBuildEnvironment({
    nodePrefix: "/opt/agenc-local-gatekeeper/node",
    nativeBuildTools: {
      cc: "/usr/bin/cc",
      cxx: "/usr/bin/c++",
      make: "/usr/bin/make",
      python: "/usr/bin/python3",
    },
  }, { PATH: "/usr/bin:/bin", npm_config_offline: "false" });
  assert.deepEqual(environment, {
    PATH: "/usr/bin:/bin",
    npm_config_offline: "true",
    CC: "/usr/bin/cc",
    CXX: "/usr/bin/c++",
    MAKE: "/usr/bin/make",
    npm_config_build_from_source: "true",
    npm_config_nodedir: "/opt/agenc-local-gatekeeper/node",
    npm_config_python: "/usr/bin/python3",
  });
  const source = readFileSync(
    path.join(REQUIRED_GATE_REPOSITORY_ROOT, "scripts/local-gatekeeper.mjs"),
    "utf8",
  );
  assert.match(source, /label: "prove offline native dependency load and execution"/u);
});

test("candidate and Docker accounts cannot inherit supplementary groups", () => {
  assert.doesNotThrow(() => assertDedicatedIdentityRecord({
    uid: 992,
    gid: 992,
    observedUid: 992,
    observedGid: 992,
    supplementaryGids: [992],
  }, "candidate worker account"));
  for (const record of [
    {
      uid: 992,
      gid: 992,
      observedUid: 993,
      observedGid: 992,
      supplementaryGids: [992],
    },
    {
      uid: 992,
      gid: 992,
      observedUid: 992,
      observedGid: 992,
      supplementaryGids: [27, 992],
    },
  ]) {
    assert.throws(
      () => assertDedicatedIdentityRecord(record, "candidate worker account"),
      /no supplementary groups/u,
    );
  }
  const source = readFileSync(
    path.join(REQUIRED_GATE_REPOSITORY_ROOT, "scripts/local-gatekeeper.mjs"),
    "utf8",
  );
  assert.match(source, /--clear-groups/u);
  assert.match(source, /--reuid=\$\{config\.dockerUid\}/u);
});

test("transient-unit inventory includes nested gates but excludes dispatchers", () => {
  assert.deepEqual(
    parseTransientGateUnitInventory([
      "agenc-local-gate-dispatcher@pr-1505.service loaded active running dispatcher",
      "agenc-local-gate-publish@pr-1505.service loaded active running publication-retry",
      "agenc-local-gate-context-seed@recover.service loaded inactive dead context-recovery",
      `agenc-local-gate-${"a".repeat(16)}.service loaded active running gate`,
      `agenc-local-gate-worker-${"b".repeat(16)}.service loaded active running worker`,
      `agenc-local-gate-publisher-${"c".repeat(32)}.service loaded failed failed publisher`,
      `agenc-local-gate-context-seed-credential-${"d".repeat(32)}.service loaded inactive dead seeder`,
      "",
    ].join("\n")),
    [
      `agenc-local-gate-${"a".repeat(16)}.service`,
      `agenc-local-gate-context-seed-credential-${"d".repeat(32)}.service`,
      `agenc-local-gate-publisher-${"c".repeat(32)}.service`,
      `agenc-local-gate-worker-${"b".repeat(16)}.service`,
    ],
  );
  assert.throws(
    () => parseTransientGateUnitInventory(
      "agenc-local-gate-unreviewed.service loaded active running unknown\n",
    ),
    /unexpected unit/u,
  );
});

test("loaded systemd policy rejects stale fragments and every extra drop-in", () => {
  const expected = {
    LoadState: "loaded",
    NeedDaemonReload: "no",
    FragmentPath: "/etc/systemd/system/agenc-local-gate-dispatcher@.service",
    DropInPaths: "",
  };
  const options = {
    label: "local-gate dispatcher",
    fragmentPath: expected.FragmentPath,
    dropInPaths: [],
  };
  assert.doesNotThrow(() => assertLoadedSystemdUnitRecord(expected, options));
  for (const drift of [
    { NeedDaemonReload: "yes" },
    { FragmentPath: "/run/systemd/system/agenc-local-gate-dispatcher@.service" },
    { DropInPaths: "/etc/systemd/system/agenc-local-gate-dispatcher@.service.d/99-override.conf" },
  ]) {
    assert.throws(
      () => assertLoadedSystemdUnitRecord({ ...expected, ...drift }, options),
      /stale, missing, or has unreviewed/u,
    );
  }
});

test("rootless Docker recovery accepts only an exact bounded container inventory", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  assert.deepEqual(parseDockerContainerIds(`${first}\n${second}\n`), [first, second]);
  assert.deepEqual(parseDockerContainerIds("\n"), []);
  for (const unsafe of ["short\n", `${first}\n${first}\n`, `${"A".repeat(64)}\n`]) {
    assert.throws(() => parseDockerContainerIds(unsafe), /unsafe or unexpectedly large/u);
  }
});

test("Docker data root must be an independent hardened ext4/xfs device mount", () => {
  const mountPath = "/var/lib/agenc-gate-docker";
  const valid = `71 30 8:17 / ${mountPath} rw,nosuid,nodev,relatime - ext4 /dev/sdb1 rw\n`;
  assert.deepEqual(parseDockerDataRootMountRecord(valid, mountPath), {
    majorMinor: "8:17",
    root: "/",
    mountOptions: ["nodev", "nosuid", "relatime", "rw"],
    optionalFields: [],
    fsType: "ext4",
    source: "/dev/sdb1",
    superOptions: ["rw"],
  });
  for (const changed of [
    valid.replace(" / ", " /subvolume "),
    valid.replace("nodev", "dev"),
    valid.replace("ext4", "btrfs"),
    valid.replace("/dev/sdb1", "tmpfs"),
    valid.replace("relatime", "relatime,noexec"),
    valid.replace(" - ext4", " shared:7 - ext4"),
  ]) {
    assert.throws(
      () => parseDockerDataRootMountRecord(changed, mountPath),
      /Docker data root/u,
    );
  }
});

test("Docker persistent inventory requires four exact object classes and bounded counts", () => {
  const output = [
    { Type: "Images", TotalCount: "1", Active: "0", Size: "1GB" },
    { Type: "Containers", TotalCount: "0", Active: "0", Size: "0B" },
    { Type: "Local Volumes", TotalCount: "0", Active: "0", Size: "0B" },
    { Type: "Build Cache", TotalCount: "0", Active: "0", Size: "0B" },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(parseDockerSystemDf(`${output}\n`), {
    images: { total: 1, active: 0 },
    containers: { total: 0, active: 0 },
    volumes: { total: 0, active: 0 },
    buildCache: { total: 0, active: 0 },
  });
  assert.throws(() => parseDockerSystemDf(output.split("\n").slice(0, 3).join("\n")), /incomplete/u);
  assert.throws(() => parseDockerSystemDf(output.replace('"TotalCount":"1"', '"TotalCount":"-1"')), /shape/u);
});

test("Docker network inventory is exact, full-length, and local", () => {
  const output = [
    { Name: "bridge", ID: "a".repeat(64), Driver: "bridge", Scope: "local", Internal: "false" },
    { Name: "host", ID: "b".repeat(64), Driver: "host", Scope: "local", Internal: "false" },
    { Name: "none", ID: "c".repeat(64), Driver: "null", Scope: "local", Internal: "false" },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(
    parseDockerNetworkInventory(`${output}\n`).map(({ name, driver }) => ({ name, driver })),
    [
      { name: "bridge", driver: "bridge" },
      { name: "host", driver: "host" },
      { name: "none", driver: "null" },
    ],
  );
  assert.throws(
    () => parseDockerNetworkInventory(output.replace("a".repeat(64), "a".repeat(12))),
    /network record/u,
  );
  assert.throws(
    () => parseDockerNetworkInventory(output.replace('"Name":"host"', '"Name":"bridge"')),
    /network inventory is unsafe/u,
  );
  assert.throws(
    () => parseDockerNetworkInventory(output.replace('"Internal":"false"', '"Internal":"true"')),
    /network record/u,
  );
});

test("Docker daemon policy rejects swarm and managed plugins", () => {
  const valid = {
    SecurityOptions: ["name=rootless", "name=seccomp,profile=builtin"],
    CgroupVersion: "2",
    CgroupDriver: "systemd",
    Containers: 0,
    Swarm: { LocalNodeState: "inactive" },
  };
  assert.doesNotThrow(() => assertDockerInfoBaseline(valid));
  assert.throws(
    () => assertDockerInfoBaseline({ ...valid, Swarm: { LocalNodeState: "active" } }),
    /outside swarm mode/u,
  );
  assert.doesNotThrow(() => assertDockerPluginInventoryEmpty("\n"));
  assert.throws(
    () => assertDockerPluginInventoryEmpty('{"Name":"unreviewed:latest"}\n'),
    /must not have managed plugins/u,
  );
});

test("Docker cgroup canary is located inside the dedicated user slice with exact limits", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-cgroup-test-"));
  const dockerUid = 993;
  const containerId = "d".repeat(64);
  const scope = path.join(
    root,
    "user.slice",
    `user-${dockerUid}.slice`,
    `user@${dockerUid}.service`,
    "app.slice",
    "docker.service",
    `docker-${containerId}.scope`,
  );
  mkdirSync(scope, { recursive: true });
  try {
    assert.equal(findDockerCanaryCgroupPath(root, dockerUid, containerId), scope);
    assert.doesNotThrow(() => assertDockerCanaryCgroupRecords({
      "cpu.max": "25000 100000",
      "memory.max": "134217728",
      "memory.swap.max": "0",
      "pids.max": "32",
      "cgroup.procs": "123\n124",
    }));
    for (const drift of [
      { "cpu.max": "max 100000" },
      { "memory.max": "max" },
      { "memory.swap.max": "134217728" },
      { "pids.max": "max" },
      { "cgroup.procs": "" },
    ]) {
      assert.throws(
        () => assertDockerCanaryCgroupRecords({
          "cpu.max": "25000 100000",
          "memory.max": "134217728",
          "memory.swap.max": "0",
          "pids.max": "32",
          "cgroup.procs": "123",
          ...drift,
        }),
        /Docker canary/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker cgroup canary inspect is exact and immutable", () => {
  const containerId = "e".repeat(64);
  const name = "agenc-gate-cgroup-0123456789abcdef";
  const valid = {
    Id: containerId,
    Name: `/${name}`,
    State: { Running: true },
    Config: { Image: REQUIRED_DOCKER_IMAGE, User: "65534:65534" },
    HostConfig: {
      ReadonlyRootfs: true,
      NetworkMode: "none",
      CgroupnsMode: "private",
      LogConfig: { Type: "none" },
      Memory: 134217728,
      MemorySwap: 134217728,
      NanoCpus: 250000000,
      PidsLimit: 32,
      RestartPolicy: { Name: "no" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges=true"],
    },
  };
  assert.doesNotThrow(() => assertDockerCanaryInspectRecord(valid, { containerId, name }));
  for (const changed of [
    { ...valid, State: { Running: false } },
    { ...valid, HostConfig: { ...valid.HostConfig, Memory: 0 } },
    { ...valid, HostConfig: { ...valid.HostConfig, NetworkMode: "bridge" } },
  ]) {
    assert.throws(
      () => assertDockerCanaryInspectRecord(changed, { containerId, name }),
      /runtime confinement/u,
    );
  }
});

test("dedicated rootless Docker socket rejects group or world access", () => {
  const config = { dockerUid: 993, dockerGid: 993 };
  assert.doesNotThrow(() => assertRootlessDockerSocketRecord({
    isSocket: true,
    uid: 993,
    gid: 993,
    mode: 0o140600,
  }, config));
  for (const mode of [0o140000, 0o140200, 0o140400, 0o140660, 0o140606, 0o140700]) {
    assert.throws(
      () => assertRootlessDockerSocketRecord({
        isSocket: true,
        uid: 993,
        gid: 993,
        mode,
      }, config),
      /exact 0600/u,
    );
  }
});

test("job filesystem inventory binds the exact tmpfs source and mount point", () => {
  const mountPath = "/var/lib/agenc-local-gatekeeper/pr-1505-job-" + "a".repeat(32);
  const record = parseJobMountRecord(
    `42 31 0:40 / ${mountPath} rw,nosuid,nodev - tmpfs agenc-local-gate-job-${"a".repeat(32)} rw,size=16777216k,nr_inodes=1000000\n`,
    mountPath,
  );
  assert.deepEqual(record, {
    mountOptions: ["nodev", "nosuid", "rw"],
    fsType: "tmpfs",
    source: `agenc-local-gate-job-${"a".repeat(32)}`,
    superOptions: ["nr_inodes=1000000", "rw", "size=16777216k"],
  });
  assert.equal(parseJobMountRecord("", mountPath), null);
});

test("stale bounded job roots are unmounted before their mount points are removed", async () => {
  const { root, config } = fixture();
  const name = `pr-1505-job-${"d".repeat(32)}`;
  const candidate = path.join(config.stateDirectory, name);
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(path.join(candidate, "stale"), "stale\n");
  const unmounted = [];
  try {
    await cleanupStaleJobRoots(config.stateDirectory, {
      unmount: async (mountPath) => {
        assert.equal(existsSync(path.join(mountPath, "stale")), true);
        unmounted.push(mountPath);
      },
    });
    assert.deepEqual(unmounted, [candidate]);
    assert.equal(existsSync(candidate), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale mounted job tmpfs is validated and unmounted from its 0711 root", async () => {
  const { root, config } = fixture();
  const id = "e".repeat(32);
  const candidate = path.join(config.stateDirectory, `main-job-${id}`);
  mkdirSync(candidate, { mode: 0o711 });
  chmodSync(candidate, 0o711);
  let mounted = true;
  let validated = false;
  try {
    await cleanupStaleJobRoots(config.stateDirectory, {
      readMount: (mountPath) => mounted && mountPath === candidate ? { fsType: "tmpfs" } : null,
      assertMounted: (mountPath, source) => {
        assert.equal(mountPath, candidate);
        assert.equal(source, `agenc-local-gate-job-${id}`);
        validated = true;
      },
      unmount: async (mountPath) => {
        assert.equal(mountPath, candidate);
        mounted = false;
      },
    });
    assert.equal(validated, true);
    assert.equal(existsSync(candidate), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted job tmpfs rejects a root whose ownership or exact 0711 mode drifted", () => {
  const metadata = (overrides = {}) => ({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    mode: 0o040711,
    ...overrides,
  });
  assert.doesNotThrow(() => assertJobFilesystemRootMetadata(metadata()));
  for (const drift of [
    { mode: 0o040777 },
    { uid: (process.getuid?.() ?? 0) + 1 },
    { gid: (process.getgid?.() ?? 0) + 1 },
    { isDirectory: () => false },
    { isSymbolicLink: () => true },
  ]) {
    assert.throws(
      () => assertJobFilesystemRootMetadata(metadata(drift)),
      /root-owned 0711 directory/u,
    );
  }
});

test("candidate stdout is a pipe and cannot truncate earlier trusted log evidence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-gate-log-pipe-"));
  const logPath = path.join(root, "gate.log");
  const logFd = openSync(logPath, "wx", 0o600);
  try {
    writeSync(logFd, "trusted sentinel\n");
    await runLogged(process.execPath, [
      "-e",
      [
        "const fs = require('node:fs');",
        "try { fs.ftruncateSync(1, 0); } catch { process.stdout.write('truncate denied\\n'); }",
        "process.stdout.write('candidate output\\n');",
      ].join(" "),
    ], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 5_000,
      logFd,
      label: "candidate pipe confinement",
    });
    const contents = readFileSync(logPath, "utf8");
    assert.match(contents, /^trusted sentinel\n/u);
    assert.match(contents, /truncate denied\ncandidate output\n/u);
  } finally {
    closeSync(logFd);
    rmSync(root, { recursive: true, force: true });
  }
});

async function successfulWorker({ config, github, verifyMain = false }) {
  return runLocalGateWorker({
    config,
    ...(verifyMain ? { verifyMain: true } : { pullRequestNumber: 1505 }),
    apiBaseUrl: "https://api.example.test",
    fetchImpl: github.fetchImpl,
    cleanupCandidateUnits: async () => {},
    verifyDockerBoundary: async () => {},
    mountCandidateFilesystem: TEST_JOB_FILESYSTEM.mount,
    unmountCandidateFilesystem: TEST_JOB_FILESYSTEM.unmount,
    executeCandidate: async ({ subject, pullRequest, logFd }) => {
      if (verifyMain) {
        assert.equal(subject.kind, "main");
        assert.equal(pullRequest, undefined);
      } else {
        assert.equal(pullRequest.headSha, SOURCE_SHA);
      }
      writeSync(logFd, "all local gates passed\n");
      return CONTRACT;
    },
    now: WORKER_NOW(),
  });
}

test("credential-free worker hands off success before the App-only publisher runs", async () => {
  const { root, config, privateKeyPem } = fixture();
  const github = githubMock();
  let keyRead = false;
  try {
    const worker = await successfulWorker({ config, github });
    assert.equal(worker.envelope.receipt.result, "success");
    assert.equal(worker.envelope.receipt.subject.sourceSha, SOURCE_SHA);
    assert.equal(github.requests.some(({ url }) => url.includes("/access_tokens")), false);
    assert.deepEqual(
      readdirSync(config.stateDirectory).sort(),
      ["ready"],
    );

    const published = await runLocalGatePublisher({
      config,
      subjectLabel: "pr-1505",
      jobId: worker.envelope.jobId,
      apiBaseUrl: "https://api.example.test",
      fetchImpl: github.fetchImpl,
      readPrivateKey: () => {
        keyRead = true;
        return privateKeyPem;
      },
      now: PUBLISH_NOW,
    });
    assert.equal(keyRead, true);
    assert.equal(published.gateFailed, false);
    assert.equal(published.check.app.id, 42);
    assert.equal(
      github.requests.filter(({ url }) => url.endsWith("/pulls/1505")).length,
      3,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second dispatch accepts and retains the first bounded gate log", async () => {
  const { root, config } = fixture();
  const github = githubMock();
  try {
    await successfulWorker({ config, github });
    await successfulWorker({ config, github });
    const logs = readdirSync(config.logDirectory).sort();
    assert.equal(logs.length, 2);
    assert.ok(logs.every((name) =>
      /^(?:main|pr-[1-9][0-9]{0,9})-[0-9a-f]{40}-[1-9][0-9]{12,14}-[0-9a-f]{32}\.log$/u.test(name)
    ));
    const retention = pruneGateLogs(config.logDirectory);
    assert.equal(retention.retainedCount, 2);
    assert.equal(retention.removed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired ready handoffs are pruned without rerunning local gates", async () => {
  const { root, config } = fixture();
  const github = githubMock();
  try {
    await successfulWorker({ config, github });
    const handoff = path.join(config.stateDirectory, "ready", "pr-1505.json");
    assert.equal(existsSync(handoff), true);
    assert.deepEqual(
      pruneExpiredReadyEnvelopes(config, new Date("2026-07-15T19:02:00Z")),
      ["pr-1505.json"],
    );
    assert.equal(existsSync(handoff), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authoritative local gate failure is the only worker failure published", async () => {
  const { root, config, privateKeyPem } = fixture();
  const github = githubMock();
  try {
    const worker = await runLocalGateWorker({
      config,
      pullRequestNumber: 1505,
      apiBaseUrl: "https://api.example.test",
      fetchImpl: github.fetchImpl,
      cleanupCandidateUnits: async () => {},
      verifyDockerBoundary: async () => {},
      mountCandidateFilesystem: TEST_JOB_FILESYSTEM.mount,
      unmountCandidateFilesystem: TEST_JOB_FILESYSTEM.unmount,
      executeCandidate: async ({ logFd }) => {
        writeSync(logFd, "deliberate local gate failure\n");
        throw new GateOutcomeFailure(
          "REQUIRED_GATE_FAILED",
          "gate failed",
          { contract: CONTRACT },
        );
      },
      now: WORKER_NOW(),
    });
    assert.equal(worker.envelope.receipt.result, "failure");

    const published = await runLocalGatePublisher({
      config,
      subjectLabel: "pr-1505",
      jobId: worker.envelope.jobId,
      apiBaseUrl: "https://api.example.test",
      fetchImpl: github.fetchImpl,
      readPrivateKey: () => privateKeyPem,
      now: PUBLISH_NOW,
    });
    assert.equal(published.gateFailed, true);
    const create = github.requests.find(
      ({ method, url }) => method === "POST" && url.endsWith("/check-runs"),
    );
    assert.equal(create.body.conclusion, "failure");
    assert.equal(create.body.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("infrastructure failure creates no handoff and cannot reach the App", async () => {
  const { root, config } = fixture();
  const github = githubMock();
  try {
    await assert.rejects(
      runLocalGateWorker({
        config,
        pullRequestNumber: 1505,
        apiBaseUrl: "https://api.example.test",
        fetchImpl: github.fetchImpl,
        cleanupCandidateUnits: async () => {},
        verifyDockerBoundary: async () => {},
        mountCandidateFilesystem: TEST_JOB_FILESYSTEM.mount,
        unmountCandidateFilesystem: TEST_JOB_FILESYSTEM.unmount,
        executeCandidate: async ({ logFd }) => {
          writeSync(logFd, "install failed\n");
          throw new Error("npm ci failed");
        },
      }),
      /npm ci failed/u,
    );
    assert.equal(github.requests.some(({ url }) => url.includes("/access_tokens")), false);
    assert.equal(github.requests.some(({ url }) => url.includes("/check-runs")), false);
    assert.deepEqual(readdirSync(config.stateDirectory), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate transient units are cleaned before the candidate workspace", async () => {
  const { root, config } = fixture();
  const github = githubMock();
  let workspacePath;
  let cleanupRan = false;
  try {
    await runLocalGateWorker({
      config,
      pullRequestNumber: 1505,
      apiBaseUrl: "https://api.example.test",
      fetchImpl: github.fetchImpl,
      mountCandidateFilesystem: TEST_JOB_FILESYSTEM.mount,
      unmountCandidateFilesystem: TEST_JOB_FILESYSTEM.unmount,
      executeCandidate: async ({ workspace, logFd }) => {
        workspacePath = workspace;
        writeFileSync(path.join(workspace, "candidate-marker"), "owned by candidate\n");
        writeSync(logFd, "all local gates passed\n");
        return CONTRACT;
      },
      cleanupCandidateUnits: async () => {
        assert.equal(existsSync(path.join(workspacePath, "candidate-marker")), true);
        cleanupRan = true;
      },
      verifyDockerBoundary: async () => {},
      now: WORKER_NOW(),
    });
    assert.equal(cleanupRan, true);
    assert.equal(existsSync(workspacePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moved PR head aborts before a ready handoff exists", async () => {
  const { root, config } = fixture();
  const github = githubMock({ prShas: [SOURCE_SHA, "3".repeat(40)] });
  try {
    await assert.rejects(
      successfulWorker({ config, github }),
      /gate subject moved/u,
    );
    assert.equal(github.requests.some(({ url }) => url.includes("/check-runs")), false);
    assert.deepEqual(readdirSync(config.stateDirectory), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publisher rereads the PR after worker teardown and refuses a moved head", async () => {
  const { root, config } = fixture();
  const github = githubMock({ prShas: [SOURCE_SHA, SOURCE_SHA, "3".repeat(40)] });
  let keyRead = false;
  try {
    const worker = await successfulWorker({ config, github });
    await assert.rejects(
      runLocalGatePublisher({
        config,
        subjectLabel: "pr-1505",
        jobId: worker.envelope.jobId,
        apiBaseUrl: "https://api.example.test",
        fetchImpl: github.fetchImpl,
        readPrivateKey: () => {
          keyRead = true;
          return "unreachable";
        },
        now: PUBLISH_NOW,
      }),
      /moved before App publication/u,
    );
    assert.equal(keyRead, false);
    assert.equal(github.requests.some(({ url }) => url.includes("/check-runs")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publisher refuses a stale or guessed job ID before reading the App key", async () => {
  const { root, config } = fixture();
  const github = githubMock();
  let keyRead = false;
  try {
    await successfulWorker({ config, github });
    await assert.rejects(
      runLocalGatePublisher({
        config,
        subjectLabel: "pr-1505",
        jobId: "f".repeat(32),
        apiBaseUrl: "https://api.example.test",
        fetchImpl: github.fetchImpl,
        readPrivateKey: () => {
          keyRead = true;
          return "unreachable";
        },
        now: PUBLISH_NOW,
      }),
      /job ID does not match/u,
    );
    assert.equal(keyRead, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merged-main gets a distinct exact-main worker handoff and App check", async () => {
  const { root, config, privateKeyPem } = fixture();
  const github = githubMock();
  try {
    const worker = await successfulWorker({ config, github, verifyMain: true });
    assert.deepEqual(worker.envelope.receipt.subject, {
      kind: "main",
      ref: "refs/heads/main",
      sourceSha: SOURCE_SHA,
    });
    const published = await runLocalGatePublisher({
      config,
      subjectLabel: "main",
      jobId: worker.envelope.jobId,
      apiBaseUrl: "https://api.example.test",
      fetchImpl: github.fetchImpl,
      readPrivateKey: () => privateKeyPem,
      now: PUBLISH_NOW,
    });
    assert.equal(published.gateFailed, false);
    assert.equal(
      github.requests.filter(({ url }) => url.endsWith("/git/ref/heads/main")).length,
      3,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("systemd deployment mounts the App key only in a random transient publisher", () => {
  const dispatcher = readFileSync(
    path.join(
      REQUIRED_GATE_REPOSITORY_ROOT,
      "packaging/systemd/agenc-local-gate-dispatcher@.service",
    ),
    "utf8",
  );
  assert.doesNotMatch(dispatcher, /LoadCredential/u);
  assert.match(dispatcher, /^ExecStart=.*--dispatch %i$/mu);
  assert.match(dispatcher, /^Slice=system-agencgate\.slice$/mu);
  assert.match(dispatcher, /^KillMode=control-group$/mu);
  assert.match(dispatcher, /^CPUQuota=800%$/mu);
  assert.match(dispatcher, /^LimitFSIZE=128M$/mu);
  const publicationRetry = readFileSync(
    path.join(
      REQUIRED_GATE_REPOSITORY_ROOT,
      "packaging/systemd/agenc-local-gate-publish@.service",
    ),
    "utf8",
  );
  assert.doesNotMatch(publicationRetry, /LoadCredential/u);
  assert.match(publicationRetry, /^ExecStart=.*--retry-publish %i$/mu);
  assert.match(publicationRetry, /^Slice=system-agencgate\.slice$/mu);
  const aggregateSlice = readFileSync(
    path.join(REQUIRED_GATE_REPOSITORY_ROOT, "packaging/systemd/system-agencgate.slice"),
    "utf8",
  );
  assert.match(aggregateSlice, /^MemoryMax=16G$/mu);
  assert.match(aggregateSlice, /^MemoryZSwapMax=0$/mu);
  assert.match(aggregateSlice, /^TasksMax=4096$/mu);
  const dockerUserSlice = readFileSync(
    path.join(
      REQUIRED_GATE_REPOSITORY_ROOT,
      "packaging/systemd/agenc-local-gate-docker-user.slice.conf",
    ),
    "utf8",
  );
  assert.match(dockerUserSlice, /^MemoryMax=16G$/mu);
  assert.match(dockerUserSlice, /^TasksMax=12288$/mu);
  const dockerService = readFileSync(
    path.join(
      REQUIRED_GATE_REPOSITORY_ROOT,
      "packaging/systemd/agenc-local-gate-docker.service.conf",
    ),
    "utf8",
  );
  assert.match(dockerService, /^UMask=0077$/mu);
  assert.match(dockerService, /^ExecStartPost=\/usr\/bin\/chmod 0600 %t\/docker\.sock$/mu);
  const dockerServiceUnit = readFileSync(
    path.join(
      REQUIRED_GATE_REPOSITORY_ROOT,
      "packaging/systemd/agenc-local-gate-docker.service",
    ),
    "utf8",
  );
  assert.match(dockerServiceUnit, /^ExecStart=.*--data-root=\/var\/lib\/agenc-gate-docker\b/mu);
  assert.match(dockerServiceUnit, /^Delegate=yes$/mu);
  const publisher = buildSystemdPublisherCommand({
    jobId: "a".repeat(32),
    subjectLabel: "pr-1505",
    parentUnit: "agenc-local-gate-dispatcher@pr-1505.service",
    nodePath: "/opt/agenc-local-gatekeeper/node/bin/node",
    scriptPath: "/opt/agenc-local-gatekeeper/repo/scripts/local-gatekeeper.mjs",
    credentialPath: "/etc/credstore.encrypted/agenc-local-gatekeeper-app-key",
    cwd: "/var/lib/agenc-local-gatekeeper",
  });
  assert.equal(publisher.unitName, `agenc-local-gate-publisher-${"a".repeat(32)}.service`);
  assert.ok(publisher.args.includes(
    "--property=LoadCredentialEncrypted=github-app-private-key:/etc/credstore.encrypted/agenc-local-gatekeeper-app-key",
  ));
  assert.equal(
    publisher.args.filter((value) => value === "--slice=system-agencgate.slice").length,
    1,
  );
  assert.ok(publisher.args.includes("--property=CapabilityBoundingSet="));
  assert.ok(publisher.args.includes("--property=ExitType=main"));
  assert.equal(
    publisher.args.some((value) => value.includes("After=agenc-local-gate-dispatcher@")),
    false,
  );
  assert.ok(publisher.args.includes("--property=ProtectHome=yes"));
  assert.ok(publisher.args.includes("--property=InaccessiblePaths=-/run/docker.sock"));
  assert.deepEqual(
    publisher.args.slice(-5),
    [
      "/opt/agenc-local-gatekeeper/node/bin/node",
      "/opt/agenc-local-gatekeeper/repo/scripts/local-gatekeeper.mjs",
      "--publish",
      "pr-1505",
      "a".repeat(32),
    ],
  );
  assert.throws(
    () => readFileSync(
      path.join(
        REQUIRED_GATE_REPOSITORY_ROOT,
        "packaging/systemd/agenc-local-gate-publisher@.service",
      ),
      "utf8",
    ),
    /ENOENT/u,
  );

  const manifest = JSON.parse(
    readFileSync(
      path.join(
        REQUIRED_GATE_REPOSITORY_ROOT,
        "packaging/github/agenc-local-gate-app-manifest.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(manifest.default_permissions, {
    checks: "write",
    statuses: "write",
  });
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.hook_attributes, undefined);
  assert.throws(
    () => readFileSync(
      path.join(REQUIRED_GATE_REPOSITORY_ROOT, ".github/workflows/required-gates.yml"),
      "utf8",
    ),
    /ENOENT/u,
  );
});

test("systemd accepts every hardened static unit without ignored directives", (t) => {
  if (process.platform !== "linux") t.skip("systemd unit validation is Linux-only");
  const systemdAnalyze = spawnSync("systemd-analyze", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (systemdAnalyze.status !== 0) t.skip("systemd-analyze is unavailable");

  const root = mkdtempSync(path.join(tmpdir(), "agenc-systemd-verify-"));
  try {
    for (const name of [
      "agenc-local-gate-context-seed@.service",
      "agenc-local-gate-dispatcher@.service",
      "agenc-local-gate-docker.service",
      "agenc-local-gate-publish@.service",
      "system-agencgate.slice",
    ]) {
      const source = readFileSync(
        path.join(REQUIRED_GATE_REPOSITORY_ROOT, "packaging/systemd", name),
        "utf8",
      );
      const testable = source
        .replace(/^ExecStart=.*$/mu, "ExecStart=/bin/true")
        .replace(/^LoadCredentialEncrypted=.*$/mu, "");
      const target = path.join(root, name);
      writeFileSync(target, testable, { mode: 0o600 });
      const verified = spawnSync("systemd-analyze", ["verify", target], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(
        verified.status,
        0,
        `systemd rejected ${name}: ${verified.stdout}${verified.stderr}`,
      );
      assert.doesNotMatch(verified.stderr, /Failed to parse|ignoring/iu);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
