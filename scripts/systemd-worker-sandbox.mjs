import path from "node:path";

export const LOCAL_GATE_AGGREGATE_SLICE = "system-agencgate.slice";
export const LOCAL_GATE_AGGREGATE_CGROUP = "/system.slice/system-agencgate.slice";
export const LOCAL_GATE_AGGREGATE_LIMITS = Object.freeze({
  cpuMax: "800000 100000",
  memoryHigh: "12884901888",
  memoryMax: "17179869184",
  memorySwapMax: "0",
  memoryZswapMax: "0",
  pidsMax: "4096",
});
export const LOCAL_GATE_DOCKER_LIMITS = Object.freeze({
  cpuMax: "800000 100000",
  memoryHigh: "15032385536",
  memoryMax: "17179869184",
  memorySwapMax: "0",
  memoryZswapMax: "0",
  pidsMax: "12288",
});
export const LOCAL_GATE_COMBINED_LIMITS = Object.freeze({
  cpuMax: "1600000 100000",
  memoryHigh: "27917287424",
  memoryMax: "34359738368",
  memorySwapMax: "0",
  memoryZswapMax: "0",
  pidsMax: "16384",
});

export function assertCgroupResourceProfile(records, expected) {
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    throw new TypeError("cgroup resource records are invalid");
  }
  const comparisons = [
    ["cpu.max", "cpuMax"],
    ["memory.high", "memoryHigh"],
    ["memory.max", "memoryMax"],
    ["memory.swap.max", "memorySwapMax"],
    ["memory.zswap.max", "memoryZswapMax"],
    ["pids.max", "pidsMax"],
  ];
  for (const [recordName, expectedName] of comparisons) {
    if (records[recordName] !== expected[expectedName]) {
      throw new Error(
        `cgroup ${recordName} is ${String(records[recordName])}; expected ${expected[expectedName]}`,
      );
    }
  }
  const controllers = new Set(String(records["cgroup.subtree_control"] ?? "").trim().split(/\s+/u));
  for (const controller of ["cpu", "memory", "pids"]) {
    if (!controllers.has(controller)) {
      throw new Error(`cgroup subtree does not delegate ${controller}`);
    }
  }
}

export function assertCgroupAncestorCapacity(records, minimum) {
  const numericAtLeast = (name, expectedName, value) => {
    if (value === "max") return;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || BigInt(value) < BigInt(minimum[expectedName])) {
      throw new Error(`ancestor cgroup ${name} is below the reviewed local-gate capacity`);
    }
  };
  numericAtLeast("memory.high", "memoryHigh", records["memory.high"]);
  numericAtLeast("memory.max", "memoryMax", records["memory.max"]);
  numericAtLeast("pids.max", "pidsMax", records["pids.max"]);
  const cpu = /^(max|[1-9][0-9]*) ([1-9][0-9]*)$/u.exec(records["cpu.max"] ?? "");
  const expectedCpu = /^([1-9][0-9]*) ([1-9][0-9]*)$/u.exec(minimum.cpuMax);
  if (
    cpu === null ||
    expectedCpu === null ||
    (cpu[1] !== "max" && BigInt(cpu[1]) * BigInt(expectedCpu[2]) <
      BigInt(expectedCpu[1]) * BigInt(cpu[2]))
  ) {
    throw new Error("ancestor cgroup CPU capacity is below the reviewed local-gate capacity");
  }
}

export function assertDockerCgroupPlacement({
  dockerUid,
  userManager,
  dockerService,
}) {
  if (!Number.isSafeInteger(dockerUid) || dockerUid <= 0) {
    throw new TypeError("Docker cgroup UID is invalid");
  }
  const userSlice = `/user.slice/user-${dockerUid}.slice`;
  const userManagerCgroup = `${userSlice}/user@${dockerUid}.service`;
  if (
    userManager?.ActiveState !== "active" ||
    userManager?.ControlGroup !== userManagerCgroup ||
    userManager?.Delegate !== "yes"
  ) {
    throw new Error("dedicated Docker user manager is outside its active delegated user slice");
  }
  const controllers = new Set(String(userManager.DelegateControllers ?? "").trim().split(/\s+/u));
  for (const controller of ["cpu", "memory", "pids"]) {
    if (!controllers.has(controller)) {
      throw new Error(`dedicated Docker user manager does not delegate ${controller}`);
    }
  }
  if (
    dockerService?.ActiveState !== "active" ||
    !/^[1-9][0-9]*$/u.test(String(dockerService.MainPID ?? "")) ||
    typeof dockerService.ControlGroup !== "string" ||
    !dockerService.ControlGroup.startsWith(`${userManagerCgroup}/`) ||
    !dockerService.ControlGroup.endsWith("/docker.service")
  ) {
    throw new Error("rootless Docker daemon is outside the capped dedicated user slice");
  }
}

function assertSafeUnitName(value) {
  if (typeof value !== "string" || !/^agenc-local-gate-[a-z0-9-]{1,128}$/u.test(value)) {
    throw new TypeError("transient worker unit name is invalid");
  }
  return value;
}

function assertParentUnit(value) {
  if (
    typeof value !== "string" ||
    !/^agenc-local-gate-(?:dispatcher|publish)@(main|pr-[1-9][0-9]{0,9})\.service$/u.test(value)
  ) {
    throw new TypeError("transient worker parent unit is invalid");
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    !/^\/(?:[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*)?$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a safe absolute path`);
  }
  return value;
}

function assertEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("worker environment must be an object");
  }
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        /[\r\n]/u.test(value)
      ) {
        throw new TypeError(`worker environment entry is invalid: ${name}`);
      }
      return `--setenv=${name}=${value}`;
    });
}

export function buildSystemdWorkerCommand({
  unitName,
  parentUnit,
  uid,
  gid,
  cwd,
  environment,
  command,
  args = [],
  readWritePaths = [],
  inaccessiblePaths = [],
  dockerAccess = false,
  dockerSocketPath,
  networkAccess = false,
  collect = false,
  runtimeMaxSeconds,
  memoryMax = "16G",
  cpuQuota = "800%",
  tasksMax = 4096,
}) {
  assertSafeUnitName(unitName);
  assertParentUnit(parentUnit);
  assertPositiveInteger(uid, "worker UID");
  assertPositiveInteger(gid, "worker GID");
  assertAbsolutePath(cwd, "worker cwd");
  assertAbsolutePath(command, "worker command");
  if (!Array.isArray(args) || args.some((value) =>
    typeof value !== "string" || value.includes("\0") || /[\r\n]/u.test(value))) {
    throw new TypeError("worker command arguments are invalid");
  }
  if (
    !Array.isArray(readWritePaths) ||
    readWritePaths.some((value) => {
      assertAbsolutePath(value, "worker writable path");
      return false;
    })
  ) {
    throw new TypeError("worker writable paths are invalid");
  }
  if (
    !Array.isArray(inaccessiblePaths) ||
    inaccessiblePaths.some((value) => {
      assertAbsolutePath(value, "worker inaccessible path");
      return false;
    })
  ) {
    throw new TypeError("worker inaccessible paths are invalid");
  }
  assertPositiveInteger(runtimeMaxSeconds, "worker runtime bound");
  assertPositiveInteger(tasksMax, "worker task bound");
  if (typeof collect !== "boolean") throw new TypeError("worker collection flag is invalid");
  if (typeof networkAccess !== "boolean") throw new TypeError("worker network flag is invalid");
  if (dockerAccess && networkAccess) {
    throw new TypeError("Docker and direct network access are mutually exclusive");
  }
  if (dockerAccess) {
    const expectedSocket = `/run/user/${uid}/docker.sock`;
    if (dockerSocketPath !== expectedSocket) {
      throw new TypeError(`Docker worker socket must be ${expectedSocket}`);
    }
  } else if (dockerSocketPath !== undefined) {
    throw new TypeError("non-Docker worker cannot receive a Docker socket");
  }
  if (typeof memoryMax !== "string" || !/^[1-9][0-9]*[MG]$/u.test(memoryMax)) {
    throw new TypeError("worker memory bound is invalid");
  }
  if (typeof cpuQuota !== "string" || !/^[1-9][0-9]*%$/u.test(cpuQuota)) {
    throw new TypeError("worker CPU quota is invalid");
  }

  const properties = [
    "Type=exec",
    "ExitType=main",
    "KillMode=control-group",
    "SendSIGKILL=yes",
    "TimeoutStopSec=30s",
    `RuntimeMaxSec=${runtimeMaxSeconds}s`,
    "Restart=no",
    `BindsTo=${parentUnit}`,
    `PartOf=${parentUnit}`,
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    `SupplementaryGroups=${gid}`,
    "ProtectSystem=strict",
    `ProtectHome=${dockerAccess ? "tmpfs" : "yes"}`,
    "TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=512M,nr_inodes=65536,mode=1777",
    "TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,size=128M,nr_inodes=16384,mode=1777",
    "PrivateDevices=yes",
    "PrivateIPC=yes",
    "ProtectHostname=yes",
    "KeyringMode=private",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    ...(
      networkAccess
        ? ["RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"]
        : [
            "PrivateNetwork=yes",
            "IPAddressDeny=any",
            "RestrictAddressFamilies=AF_UNIX",
          ]
    ),
    "RestrictNamespaces=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "RestrictRealtime=yes",
    "SystemCallArchitectures=native",
    `TasksMax=${tasksMax}`,
    `CPUQuota=${cpuQuota}`,
    `MemoryMax=${memoryMax}`,
    "MemorySwapMax=0",
    "OOMPolicy=kill",
    "LimitFSIZE=128M",
    "LimitCORE=0",
    "LimitNOFILE=4096",
    "UMask=0077",
    ...(!networkAccess ? ["TemporaryFileSystem=/run:ro"] : []),
    "InaccessiblePaths=-/run/dbus/system_bus_socket",
    "InaccessiblePaths=-/run/systemd/private",
    ...inaccessiblePaths.map((value) => `InaccessiblePaths=${value}`),
    ...readWritePaths.map((value) => `ReadWritePaths=${value}`),
    ...(
      dockerAccess
        ? [`BindReadOnlyPaths=${dockerSocketPath}`]
        : [
            "InaccessiblePaths=-/var/run/docker.sock",
            "InaccessiblePaths=-/run/docker.sock",
          ]
    ),
  ];

  return Object.freeze({
    unitName: `${unitName}.service`,
    command: "/usr/bin/systemd-run",
    args: Object.freeze([
      "--system",
      `--slice=${LOCAL_GATE_AGGREGATE_SLICE}`,
      "--no-ask-password",
      "--expand-environment=no",
      "--quiet",
      "--wait",
      ...(collect ? ["--collect"] : []),
      "--pipe",
      "--service-type=exec",
      `--unit=${unitName}`,
      `--uid=${uid}`,
      `--gid=${gid}`,
      `--working-directory=${cwd}`,
      ...properties.map((value) => `--property=${value}`),
      ...assertEnvironment(environment),
      "--",
      command,
      ...args,
    ]),
  });
}

export const JOB_FILESYSTEM_MAX_BYTES = 16 * 1024 * 1024 * 1024;
export const JOB_FILESYSTEM_MAX_INODES = 1_000_000;

export function buildSystemdJobMountCommand({ jobId, parentUnit, mountPath }) {
  if (typeof jobId !== "string" || !/^[0-9a-f]{32}$/u.test(jobId)) {
    throw new TypeError("job filesystem ID is invalid");
  }
  assertParentUnit(parentUnit);
  assertAbsolutePath(mountPath, "job filesystem mount path");
  return Object.freeze({
    source: `agenc-local-gate-job-${jobId}`,
    command: "/usr/bin/systemd-mount",
    args: Object.freeze([
      "--no-ask-password",
      "--quiet",
      "--collect",
      `--property=BindsTo=${parentUnit}`,
      `--property=PartOf=${parentUnit}`,
      `--property=Slice=${LOCAL_GATE_AGGREGATE_SLICE}`,
      `--options=rw,nosuid,nodev,size=16G,nr_inodes=${JOB_FILESYSTEM_MAX_INODES},mode=0711`,
      "--tmpfs",
      `agenc-local-gate-job-${jobId}`,
      mountPath,
    ]),
  });
}

export function buildSystemdJobUnmountCommand(mountPath) {
  assertAbsolutePath(mountPath, "job filesystem mount path");
  return Object.freeze({
    command: "/usr/bin/systemd-mount",
    args: Object.freeze([
      "--no-ask-password",
      "--quiet",
      "--umount",
      mountPath,
    ]),
  });
}

export function buildSystemdPublisherCommand({
  jobId,
  subjectLabel,
  parentUnit,
  nodePath,
  scriptPath,
  credentialPath,
  cwd,
}) {
  if (typeof jobId !== "string" || !/^[0-9a-f]{32}$/u.test(jobId)) {
    throw new TypeError("transient publisher job ID is invalid");
  }
  if (subjectLabel !== "main" && !/^pr-[1-9][0-9]{0,9}$/u.test(subjectLabel)) {
    throw new TypeError("transient publisher subject is invalid");
  }
  assertParentUnit(parentUnit);
  for (const [value, label] of [
    [nodePath, "publisher Node executable"],
    [scriptPath, "publisher script"],
    [credentialPath, "publisher encrypted credential"],
    [cwd, "publisher working directory"],
  ]) {
    assertAbsolutePath(value, label);
  }
  const unitName = `agenc-local-gate-publisher-${jobId}`;
  return Object.freeze({
    unitName: `${unitName}.service`,
    command: "/usr/bin/systemd-run",
    args: Object.freeze([
      "--system",
      `--slice=${LOCAL_GATE_AGGREGATE_SLICE}`,
      "--no-ask-password",
      "--expand-environment=no",
      "--quiet",
      "--wait",
      "--collect",
      "--pipe",
      "--service-type=exec",
      `--unit=${unitName}`,
      "--uid=0",
      "--gid=0",
      `--working-directory=${cwd}`,
      "--property=Type=exec",
      "--property=ExitType=main",
      "--property=KillMode=control-group",
      "--property=SendSIGKILL=yes",
      "--property=TimeoutStopSec=30s",
      "--property=RuntimeMaxSec=300s",
      "--property=Restart=no",
      `--property=BindsTo=${parentUnit}`,
      `--property=PartOf=${parentUnit}`,
      `--property=LoadCredentialEncrypted=github-app-private-key:${credentialPath}`,
      "--property=NoNewPrivileges=yes",
      "--property=CapabilityBoundingSet=",
      "--property=AmbientCapabilities=",
      "--property=SupplementaryGroups=0",
      "--property=ProtectSystem=strict",
      "--property=ProtectHome=yes",
      "--property=PrivateTmp=yes",
      "--property=PrivateDevices=yes",
      "--property=PrivateIPC=yes",
      "--property=ProtectHostname=yes",
      "--property=KeyringMode=private",
      "--property=ProtectKernelTunables=yes",
      "--property=ProtectKernelModules=yes",
      "--property=ProtectKernelLogs=yes",
      "--property=ProtectControlGroups=yes",
      "--property=ProtectClock=yes",
      "--property=ProtectProc=invisible",
      "--property=ProcSubset=pid",
      "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "--property=RestrictNamespaces=yes",
      "--property=RestrictSUIDSGID=yes",
      "--property=LockPersonality=yes",
      "--property=RestrictRealtime=yes",
      "--property=SystemCallArchitectures=native",
      "--property=TasksMax=64",
      "--property=CPUQuota=100%",
      "--property=MemoryMax=512M",
      "--property=MemorySwapMax=0",
      "--property=OOMPolicy=kill",
      "--property=LimitFSIZE=16M",
      "--property=LimitCORE=0",
      "--property=LimitNOFILE=1024",
      "--property=UMask=0077",
      "--property=InaccessiblePaths=-/var/run/docker.sock",
      "--property=InaccessiblePaths=-/run/docker.sock",
      "--property=InaccessiblePaths=-/run/dbus/system_bus_socket",
      "--property=InaccessiblePaths=-/run/systemd/private",
      "--setenv=HOME=/nonexistent",
      "--setenv=LANG=C.UTF-8",
      "--setenv=LC_ALL=C.UTF-8",
      "--setenv=NODE_OPTIONS=",
      "--setenv=PATH=/usr/bin:/bin",
      "--setenv=TZ=UTC",
      "--",
      nodePath,
      scriptPath,
      "--publish",
      subjectLabel,
      jobId,
    ]),
  });
}
