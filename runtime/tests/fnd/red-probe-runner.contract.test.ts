import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, matchesGlob, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRedProbeAssertion,
  RED_PROBE_EXPECTED_EXIT_CODE as HELPER_EXPECTED_EXIT_CODE,
  RED_PROBE_PROTOCOL_PREFIX as HELPER_PROTOCOL_PREFIX,
  RED_PROBE_PROTOCOL_VERSION as HELPER_PROTOCOL_VERSION,
  RED_PROBE_TASK_IDS as HELPER_TASK_IDS,
} from "../helpers/red-probe.js";
import {
  assertPortableWindowsLaunch,
  auditRedProbes,
  createRedProbeProtocolState,
  loadRedProbeManifest,
  measurePortableWindowsLaunch,
  observeRedProbeProtocolLine,
  RED_PROBE_EXPECTED_EXIT_CODE as RUNNER_EXPECTED_EXIT_CODE,
  RED_PROBE_HEARTBEAT_PREFIX as RUNNER_HEARTBEAT_PREFIX,
  RED_PROBE_PROTOCOL_PREFIX as RUNNER_PROTOCOL_PREFIX,
  RED_PROBE_PROTOCOL_VERSION as RUNNER_PROTOCOL_VERSION,
  RED_PROBE_TASK_IDS as RUNNER_TASK_IDS,
  WINDOWS_PORTABLE_LAUNCH_MAXIMUM_CODE_UNITS,
} from "../../scripts/run-fnd-red-probes.mjs";
import {
  DEFAULT_TEST_EXCLUDE,
  DEFAULT_TEST_INCLUDE,
  NATIVE_TEST_INCLUDE,
} from "../../vitest.config.js";

const runtimeRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = resolve(runtimeRoot, "..");
const redProbeFile =
  "tests/fnd/red-probes/intentional-transition-omission.red-probe.ts";
const fixtureProbeFile = "tests/fnd/red-probes/contract-fixture.red-probe.ts";
const canonicalHelperTypeImport =
  'import type { RedProbeAssertion } from "../../helpers/red-probe.js";';
const auditSha = "d2b228e87ea63bd6a5d93e6f599f36bce88d672b";
const testId = "contract-fixture";
const testTask = "FND-001";
const testFingerprint = "FND-001:HARNESS-SELF-TEST:CONTRACT-FIXTURE";
const inventoryOverflowFileCount = 320;
const jsonNodeOverflowCount = 16_384;
const sourceAstNodeOverflowItems = 16_500;
const defaultFixtureTimeoutMs = 15_000;
const fullInventorySettlementHeadroomMs = 60_000;
const fullInventoryAuditTimeoutMs = loadRedProbeManifest(
  runtimeRoot,
).probes.reduce(
  (totalMs: number, probe: { readonly timeoutMs: number }) =>
    totalMs + probe.timeoutMs,
  fullInventorySettlementHeadroomMs,
);
const coldModuleLoadMilliseconds = 500;
const coldModuleFixtureTimeoutMs = 5_000;
const preReadyHardDeadlineMilliseconds = 5_000;
const preReadyBlockingImportMilliseconds = 10_000;
const reporterHandoffSymbolKey = "agenc.red-probe.report-expected-failure.v1";
const finalAuthenticationDomain = "AGENC_RED_PROBE_FINAL_V1\0";
const markdownLoaderSha256 =
  "7fe828cfce5d415c2ac59b6d4b0226c41ebd86f531fb20a87c469359c571510f";
const protocolAuthenticationSecret = Buffer.alloc(32, 0x11);
const alternateProtocolAuthenticationSecret = Buffer.alloc(32, 0x22);
const protocolEntry = Object.freeze({
  fingerprint: testFingerprint,
  id: testId,
  task: testTask,
});
const temporaryRoots: string[] = [];

interface FixtureOptions {
  readonly source?: string;
  readonly fingerprint?: string;
  readonly task?: string;
  readonly temporaryDirectory?: string;
  readonly timeoutMs?: number;
}

const expectedTaskIds = [
  "FND-001",
  "A1",
  "A2a",
  "A2b",
  "A3",
  "A4",
  "B1",
  "B2",
  "B3a",
  "B3b",
  "C1",
  "C2",
  "C3a",
  "C3b",
  "D1",
  "D2",
  "D3",
  "E1a",
  "E1b",
  "E2",
  "E3",
] as const;

interface ProbeSourceOptions {
  readonly actual?: string;
  readonly afterAssertion?: readonly string[];
  readonly beforeAssertion?: readonly string[];
  readonly expected?: string;
  readonly fingerprint?: string;
  readonly imports?: readonly string[];
  readonly task?: string;
  readonly id?: string;
}

function probeSource(options: ProbeSourceOptions = {}): string {
  const identity = {
    id: options.id ?? testId,
    task: options.task ?? testTask,
    fingerprint: options.fingerprint ?? testFingerprint,
  };
  const body = [
    `const identity = ${JSON.stringify(identity)};`,
    ...(options.beforeAssertion ?? []),
    `expectDeepStrictEqualRedProbe(identity, ${options.actual ?? "1"}, ${options.expected ?? "2"});`,
    ...(options.afterAssertion ?? []),
  ].flatMap((line) => line.split("\n").map((part) => `  ${part}`));
  return [
    canonicalHelperTypeImport,
    ...(options.imports ?? []),
    "export default async function runRedProbe(",
    "  expectDeepStrictEqualRedProbe: RedProbeAssertion,",
    "): Promise<void> {",
    ...body,
    "}",
    "",
  ].join("\n");
}

function createFixture(options: FixtureOptions = {}): string {
  const fixtureRoot = realpathSync(
    mkdtempSync(
      join(options.temporaryDirectory ?? tmpdir(), "agenc-red-probe-contract-"),
    ),
  );
  temporaryRoots.push(fixtureRoot);
  const probeDirectory = join(fixtureRoot, "tests/fnd/red-probes");
  const helperDirectory = join(fixtureRoot, "tests/helpers");
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  mkdirSync(probeDirectory, { recursive: true });
  mkdirSync(helperDirectory, { recursive: true });
  copyFileSync(
    resolve(runtimeRoot, "tests/helpers/red-probe.ts"),
    join(helperDirectory, "red-probe.ts"),
  );
  copyFileSync(
    resolve(runtimeRoot, "tests/helpers/red-probe-bootstrap.mjs"),
    join(helperDirectory, "red-probe-bootstrap.mjs"),
  );
  copyFileSync(
    resolve(runtimeRoot, "tests/helpers/red-probe-markdown-loader.mjs"),
    join(helperDirectory, "red-probe-markdown-loader.mjs"),
  );
  const fingerprint = options.fingerprint ?? testFingerprint;
  const task = options.task ?? testTask;
  const source = options.source ?? probeSource({ fingerprint, task });
  const manifest = {
    schemaVersion: 1,
    auditSha,
    probeCount: 1,
    probes: [
      {
        id: testId,
        classification: "harness-self-test",
        file: fixtureProbeFile,
        fingerprint,
        sourceSha256: sha256(source),
        task,
        timeoutMs: options.timeoutMs ?? defaultFixtureTimeoutMs,
      },
    ],
  };
  writeFileSync(
    join(probeDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(probeDirectory, "contract-fixture.red-probe.ts"),
    source,
    "utf8",
  );
  return fixtureRoot;
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function protocolHeartbeatLine(sequence: number): string {
  return `${RUNNER_HEARTBEAT_PREFIX}${JSON.stringify({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    outcome: "heartbeat",
    id: testId,
    task: testTask,
    fingerprint: testFingerprint,
    sequence,
  })}\n`;
}

function protocolFinalLine(
  authenticationSecret = protocolAuthenticationSecret,
): string {
  const evidence = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    outcome: "expected-red",
    id: testId,
    task: testTask,
    fingerprint: testFingerprint,
    assertions: 1,
    skipped: 0,
    todos: 0,
    markdownSupport: {
      loaderSha256: markdownLoaderSha256,
      runtimeSourceRootUrl: pathToFileURL(
        `${resolve(runtimeRoot, "src")}${sep}`,
      ).href,
      assets: [],
    },
  };
  const authenticationTag = createHmac("sha256", authenticationSecret)
    .update(finalAuthenticationDomain, "utf8")
    .update(JSON.stringify(evidence), "utf8")
    .digest("hex");
  return `${RUNNER_PROTOCOL_PREFIX}${JSON.stringify({
    ...evidence,
    authenticationTag,
  })}\n`;
}

function observeProtocolLines(
  lines: readonly string[],
  authenticationSecret = protocolAuthenticationSecret,
) {
  return lines.reduce(
    (state, line) =>
      observeRedProbeProtocolLine(
        protocolEntry,
        state,
        line,
        authenticationSecret,
        {
          loaderSha256: markdownLoaderSha256,
          runtimeSourceRoot: resolve(runtimeRoot, "src"),
          runtimeSourceRootUrl: pathToFileURL(
            `${resolve(runtimeRoot, "src")}${sep}`,
          ).href,
        },
      ),
    createRedProbeProtocolState(),
  );
}

function replaceManifest(runtimeRootFixture: string, source: string): void {
  writeFileSync(
    join(runtimeRootFixture, "tests/fnd/red-probes/manifest.json"),
    source,
    "utf8",
  );
}

function writeFixtureHelperModule(
  fixtureRoot: string,
  name: string,
  source: string,
): void {
  writeFileSync(join(fixtureRoot, "tests/helpers", name), source, "utf8");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return !processIsAlive(pid);
}

function resolveTestOwnedAuditRunRoot(
  candidate: string,
  runBase: string,
): string {
  const expectedBase = resolve(runBase);
  const resolvedCandidate = resolve(candidate);
  if (
    candidate !== resolvedCandidate ||
    dirname(resolvedCandidate) !== expectedBase ||
    !/^agr-[A-Za-z0-9]{6}$/u.test(basename(resolvedCandidate))
  ) {
    throw new Error("standalone audit reported an unsafe run root");
  }
  return resolvedCandidate;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("FND red-probe supervisor", () => {
  it(
    "audits the registered nonempty harness self-probe with zero skips and todos",
    async () => {
      await expect(auditRedProbes()).resolves.toEqual({
        files: 1,
        expectedRed: 1,
        assertions: 1,
        skipped: 0,
        todos: 0,
      });
    },
    // Each probe has its own hard deadline. The outer test must cover the
    // complete sequential inventory plus bounded supervisor settlement so a
    // loaded hosted runner reports the owning probe instead of Vitest timeout.
    fullInventoryAuditTimeoutMs,
  );

  it("loads and authenticates one bounded runtime markdown dependency", async () => {
    const markdown = "repository-owned prompt asset\n";
    const temporaryTarget = realpathSync(
      mkdtempSync(join(tmpdir(), "agenc-red-probe-temp-target-")),
    );
    const temporaryAlias = `${temporaryTarget}-alias`;
    temporaryRoots.push(temporaryAlias, temporaryTarget);
    symlinkSync(
      temporaryTarget,
      temporaryAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const fixtureRoot = createFixture({
      temporaryDirectory: temporaryAlias,
      source: probeSource({
        imports: ['import markdown from "../../../src/policy.md";'],
        actual: "markdown",
        expected: JSON.stringify("replacement prompt asset\n"),
      }),
    });
    writeFileSync(join(fixtureRoot, "src/policy.md"), markdown, {
      mode: 0o600,
    });
    expect(fixtureRoot).toBe(realpathSync(fixtureRoot));

    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).resolves.toEqual(
      {
        files: 1,
        expectedRed: 1,
        assertions: 1,
        skipped: 0,
        todos: 0,
      },
    );
  });

  it("orders authenticated markdown assets by canonical code units", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: [
          'import lower from "../../../src/a.md";',
          'import upper from "../../../src/A.md";',
        ],
        actual: "[lower, upper]",
        expected: JSON.stringify(["different lower\n", "different upper\n"]),
      }),
    });
    writeFileSync(join(fixtureRoot, "src/a.md"), "lower\n", { mode: 0o600 });
    writeFileSync(join(fixtureRoot, "src/A.md"), "upper\n", { mode: 0o600 });

    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).resolves.toEqual(
      {
        files: 1,
        expectedRed: 1,
        assertions: 1,
        skipped: 0,
        todos: 0,
      },
    );
  });

  it("starts heartbeat silence only after bounded cold module loading", async () => {
    const source = probeSource({
      imports: [
        'import { coldCapability } from "../../../src/cold-capability.js";',
      ],
      actual: "coldCapability()",
      expected: "2",
    });
    const fixtureRoot = createFixture({
      source,
      timeoutMs: coldModuleFixtureTimeoutMs,
    });
    writeFileSync(
      join(fixtureRoot, "src/cold-capability.ts"),
      [
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${coldModuleLoadMilliseconds});`,
        "export function coldCapability(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: { heartbeatSilenceMs: 250 },
      }),
    ).resolves.toEqual({
      files: 1,
      expectedRed: 1,
      assertions: 1,
      skipped: 0,
      todos: 0,
    });
  });

  it("keeps the hard deadline and descendant containment active before readiness", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: ['import "../../helpers/pre-ready-hang.js";'],
      }),
      timeoutMs: preReadyHardDeadlineMilliseconds,
    });
    const marker = join(fixtureRoot, "pre-ready-descendant.pid");
    writeFixtureHelperModule(
      fixtureRoot,
      "pre-ready-hang.ts",
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const child = spawn(process.execPath, ["--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });`,
        'if (child.pid === undefined) throw new Error("missing descendant pid");',
        `writeFileSync(${JSON.stringify(marker)}, String(child.pid), "utf8");`,
        "child.unref();",
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${preReadyBlockingImportMilliseconds});`,
        "",
      ].join("\n"),
    );

    await expect(
      auditRedProbes({ runtimeRoot: fixtureRoot }),
    ).rejects.toThrow(
      `timed out after ${preReadyHardDeadlineMilliseconds}ms`,
    );
    const descendantPid = Number.parseInt(readFileSync(marker, "utf8"), 10);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it("keeps the TypeScript helper and Node supervisor protocol constants exact", () => {
    expect(RUNNER_PROTOCOL_VERSION).toBe(1);
    expect(RUNNER_EXPECTED_EXIT_CODE).toBe(86);
    expect(RUNNER_PROTOCOL_PREFIX).toBe("AGENC_RED_PROBE_V1 ");
    expect(RUNNER_HEARTBEAT_PREFIX).toBe("AGENC_RED_PROBE_HEARTBEAT_V1 ");
    expect(RUNNER_TASK_IDS).toEqual(expectedTaskIds);
    expect(HELPER_PROTOCOL_VERSION).toBe(RUNNER_PROTOCOL_VERSION);
    expect(HELPER_EXPECTED_EXIT_CODE).toBe(RUNNER_EXPECTED_EXIT_CODE);
    expect(HELPER_PROTOCOL_PREFIX).toBe(RUNNER_PROTOCOL_PREFIX);
    expect(HELPER_TASK_IDS).toEqual(RUNNER_TASK_IDS);
  });

  it("accepts a deterministic multi-heartbeat sequence followed by one final record", () => {
    const state = observeProtocolLines([
      protocolHeartbeatLine(1),
      protocolHeartbeatLine(2),
      protocolHeartbeatLine(3),
      protocolFinalLine(),
    ]);
    expect(state).toEqual({
      expectedSequence: 4,
      finalRecordObserved: true,
      protocolInvalid: false,
      recordsObserved: 4,
    });
  });

  it("rejects authenticated final evidence before the ready heartbeat", () => {
    const state = observeProtocolLines([
      protocolHeartbeatLine(1),
      protocolFinalLine(),
    ]);
    expect(state.finalRecordObserved).toBe(false);
    expect(state.protocolInvalid).toBe(true);
    expect(state.recordsObserved).toBe(2);
  });

  it.each([
    {
      name: "non-one initial sequence",
      lines: [protocolHeartbeatLine(2)],
    },
    {
      name: "duplicate sequence",
      lines: [protocolHeartbeatLine(1), protocolHeartbeatLine(1)],
    },
    {
      name: "out-of-order sequence",
      lines: [protocolHeartbeatLine(1), protocolHeartbeatLine(3)],
    },
  ])("rejects a $name", ({ lines }) => {
    expect(observeProtocolLines(lines).protocolInvalid).toBe(true);
  });

  it("rejects final-evidence authentication mutations and cross-run replays", () => {
    const validFinal = protocolFinalLine();
    const mutatedFinal = validFinal.replace(
      /"authenticationTag":"([0-9a-f])/u,
      (_match, firstNibble: string) =>
        `"authenticationTag":"${firstNibble === "0" ? "1" : "0"}`,
    );
    expect(
      observeProtocolLines([
        protocolHeartbeatLine(1),
        protocolHeartbeatLine(2),
        mutatedFinal,
      ])
        .protocolInvalid,
    ).toBe(true);
    expect(
      observeProtocolLines(
        [protocolHeartbeatLine(1), protocolHeartbeatLine(2), validFinal],
        alternateProtocolAuthenticationSecret,
      ).protocolInvalid,
    ).toBe(true);
    expect(
      observeProtocolLines([
        protocolHeartbeatLine(1),
        protocolHeartbeatLine(2),
        protocolFinalLine(alternateProtocolAuthenticationSecret),
      ]).protocolInvalid,
    ).toBe(true);
  });

  it("rejects every record after the final record", () => {
    const state = observeProtocolLines([
      protocolHeartbeatLine(1),
      protocolHeartbeatLine(2),
      protocolFinalLine(),
      protocolHeartbeatLine(3),
    ]);
    expect(state.finalRecordObserved).toBe(true);
    expect(state.protocolInvalid).toBe(true);
    expect(state.recordsObserved).toBe(4);
  });

  it("reserves explicit Windows launch headroom for argv and environment transport", () => {
    const measurement = measurePortableWindowsLaunch(
      "C:\\Program Files\\nodejs\\node.exe",
      ["--import", "data:text/javascript;base64,Y29uc3QgdmFsdWU9MTs="],
      {
        AGENC_RED_PROBE_BOOTSTRAP_V1: '{"schemaVersion":1}',
        Path: "C:\\Windows\\System32",
      },
    );
    expect(measurement.maximumCodeUnits).toBe(
      WINDOWS_PORTABLE_LAUNCH_MAXIMUM_CODE_UNITS,
    );
    expect(measurement.headroomCodeUnits).toBe(8_192);
    expect(measurement.targetCommandLineCodeUnits).toBeLessThan(
      measurement.maximumCodeUnits,
    );
    expect(measurement.brokerEnvironmentCodeUnits).toBeLessThan(
      measurement.maximumCodeUnits,
    );
    expect(() =>
      assertPortableWindowsLaunch("node.exe", [], {
        OVERSIZED_VALUE: "x".repeat(WINDOWS_PORTABLE_LAUNCH_MAXIMUM_CODE_UNITS),
      }),
    ).toThrow("portable Windows launches reserve 8192 of 32767 code units");
  });

  it("keeps each factory assertion bound to only its owning reporter", () => {
    const firstReports: unknown[] = [];
    const secondReports: unknown[] = [];
    const firstAssertion = createRedProbeAssertion((identity) => {
      firstReports.push(identity);
    });
    const secondAssertion = createRedProbeAssertion((identity) => {
      secondReports.push(identity);
    });
    firstAssertion(protocolEntry, 1, 2);
    secondAssertion(protocolEntry, 3, 4);
    expect(firstReports).toEqual([protocolEntry]);
    expect(secondReports).toEqual([protocolEntry]);
    expect(() => firstAssertion(protocolEntry, 5, 6)).toThrow(
      "red-probe assertion may only be attempted once",
    );
    expect(() => createRedProbeAssertion(undefined as never)).toThrow(
      "red-probe reporter must be a function",
    );
  });

  it("accepts only the exact canonical TODO task identifiers", () => {
    for (const task of expectedTaskIds) {
      const fixtureRoot = createFixture({ task });
      expect(loadRedProbeManifest(fixtureRoot).probes[0]?.task).toBe(task);
    }
    for (const task of ["", "FND-002", "A2", "A2c", "E1", "a1", "C03a"]) {
      const fixtureRoot = createFixture({ task });
      expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
        "has a noncanonical task",
      );
    }
  });

  it("rejects an empty manifest instead of accepting vacuous discovery", () => {
    const fixtureRoot = createFixture();
    rmSync(
      join(fixtureRoot, "tests/fnd/red-probes/contract-fixture.red-probe.ts"),
    );
    replaceManifest(
      fixtureRoot,
      `{"schemaVersion":1,"auditSha":"${auditSha}","probeCount":0,"probes":[]}\n`,
    );
    expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
      "must declare a nonempty exact probe count",
    );
  });

  it("rejects duplicate manifest keys", () => {
    const fixtureRoot = createFixture();
    replaceManifest(
      fixtureRoot,
      `{"schemaVersion":1,"schemaVersion":1,"auditSha":"${auditSha}","probeCount":1,"probes":[]}\n`,
    );
    expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
      "duplicate object key",
    );
  });

  it("rejects manifest trees beyond the bounded iterative depth", () => {
    const fixtureRoot = createFixture();
    const nesting = 80;
    replaceManifest(
      fixtureRoot,
      `${"[".repeat(nesting)}null${"]".repeat(nesting)}\n`,
    );
    expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
      "exceeds the 64-level limit",
    );
  });

  it("rejects manifest trees beyond the bounded iterative node count", () => {
    const fixtureRoot = createFixture();
    replaceManifest(
      fixtureRoot,
      `${JSON.stringify(Array.from({ length: jsonNodeOverflowCount }, () => 0))}\n`,
    );
    expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
      "exceeds the 16384-node limit",
    );
  });

  it("requires the exact audited SHA and canonical entry order", () => {
    const fixtureRoot = createFixture();
    const manifestPath = join(
      fixtureRoot,
      "tests/fnd/red-probes/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      auditSha: string;
      probeCount: number;
      probes: Array<Record<string, unknown>>;
    };
    manifest.auditSha = "0000000000000000000000000000000000000000";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
      `auditSha must equal ${auditSha}`,
    );

    manifest.auditSha = auditSha;
    manifest.probeCount = 2;
    manifest.probes = [
      {
        ...manifest.probes[0],
        id: "z-contract-fixture",
        file: "tests/fnd/red-probes/z-contract-fixture.red-probe.ts",
        fingerprint: "FND-001:HARNESS-SELF-TEST:Z-CONTRACT-FIXTURE",
      },
      {
        ...manifest.probes[0],
        id: "a-contract-fixture",
        file: "tests/fnd/red-probes/a-contract-fixture.red-probe.ts",
        fingerprint: "FND-001:HARNESS-SELF-TEST:A-CONTRACT-FIXTURE",
      },
    ];
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
      "not in canonical id order",
    );
  });

  it("requires an exact lowercase SHA-256 source digest", () => {
    const fixtureRoot = createFixture();
    const manifestPath = join(
      fixtureRoot,
      "tests/fnd/red-probes/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      probes: Array<{ sourceSha256: string }>;
    };
    manifest.probes[0]!.sourceSha256 = "A".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
      "has a noncanonical sourceSha256",
    );
  });

  it("bounds manifest identifiers used in heartbeat records and run roots", () => {
    const fixtureRoot = createFixture();
    const manifestPath = join(
      fixtureRoot,
      "tests/fnd/red-probes/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      probes: Array<{ id: string }>;
    };
    manifest.probes[0]!.id = "a".repeat(65);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    expect(() => loadRedProbeManifest(fixtureRoot)).toThrow(
      "has a noncanonical id",
    );
  });

  it("rejects discovered probes that are absent from the manifest", async () => {
    const fixtureRoot = createFixture();
    writeFileSync(
      join(fixtureRoot, "tests/fnd/red-probes/unregistered.red-probe.ts"),
      "process.exitCode = 0;\n",
      "utf8",
    );
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "red-probe inventory mismatch",
    );
  });

  it("bounds inventory entries before accumulating discovered probes", async () => {
    const fixtureRoot = createFixture();
    const probeDirectory = join(fixtureRoot, "tests/fnd/red-probes");
    for (let index = 0; index < inventoryOverflowFileCount; index += 1) {
      writeFileSync(
        join(
          probeDirectory,
          `overflow-${String(index).padStart(3, "0")}.red-probe.ts`,
        ),
        "",
        "utf8",
      );
    }
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "321-entry limit",
    );
  });

  it("bounds inventory recursion depth without recursive traversal", async () => {
    const fixtureRoot = createFixture();
    let directory = join(fixtureRoot, "tests/fnd/red-probes");
    for (let depth = 0; depth < 17; depth += 1) {
      directory = join(directory, `depth-${String(depth).padStart(2, "0")}`);
    }
    mkdirSync(directory, { recursive: true });
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "16-level directory limit",
    );
  });

  it("bounds the total number of inventory directories", async () => {
    const fixtureRoot = createFixture();
    const probeDirectory = join(fixtureRoot, "tests/fnd/red-probes");
    for (let index = 0; index < 64; index += 1) {
      mkdirSync(
        join(probeDirectory, `directory-${String(index).padStart(2, "0")}`),
      );
    }
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "64-directory limit",
    );
  });

  it("bounds cumulative UTF-8 inventory path bytes", async () => {
    const fixtureRoot = createFixture();
    const probeDirectory = join(fixtureRoot, "tests/fnd/red-probes");
    for (let index = 0; index < 255; index += 1) {
      const name = `${"p".repeat(220)}-${String(index).padStart(3, "0")}.red-probe.ts`;
      writeFileSync(join(probeDirectory, name), "", "utf8");
    }
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "65536-byte path limit",
    );
  });

  it("rejects a probe whose reviewed source bytes changed", async () => {
    const fixtureRoot = createFixture();
    writeFileSync(
      join(fixtureRoot, "tests/fnd/red-probes/contract-fixture.red-probe.ts"),
      "process.exitCode = 0;\n",
      "utf8",
    );
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "source digest does not match its manifest",
    );
  });

  it("rejects concurrent source growth beyond the fixed max-plus-one read", async () => {
    const fixtureRoot = createFixture();
    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: {
          afterProbeFileOpened({ path }: { readonly path: string }) {
            appendFileSync(path, Buffer.alloc(65_536));
          },
        },
      }),
    ).rejects.toThrow("exceeds 65536 bytes");
  });

  it("rejects a same-content pathname swap while the source is open", async () => {
    const fixtureRoot = createFixture();
    const sourcePath = join(fixtureRoot, fixtureProbeFile);
    const originalBytes = readFileSync(sourcePath);
    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: {
          afterProbeFileOpened({ path }: { readonly path: string }) {
            renameSync(path, join(fixtureRoot, "opened-source.ts"));
            writeFileSync(path, originalBytes);
          },
        },
      }),
    ).rejects.toThrow("changed while it was read");
  });

  it("rejects multiply linked probe source identities", async () => {
    const fixtureRoot = createFixture();
    const sourcePath = join(fixtureRoot, fixtureProbeFile);
    linkSync(sourcePath, join(fixtureRoot, "second-source-link.ts"));
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "not one single-link regular file",
    );
  });

  it("executes the exact verified bytes after the source pathname is swapped", async () => {
    const fixtureRoot = createFixture();
    let swapObserved = false;
    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: {
          afterProbeVerified({ path }: { readonly path: string }) {
            renameSync(path, join(fixtureRoot, "verified-source.ts"));
            writeFileSync(
              path,
              'throw new Error("replacement executed");\n',
              "utf8",
            );
            swapObserved = true;
          },
        },
      }),
    ).resolves.toEqual({
      files: 1,
      expectedRed: 1,
      assertions: 1,
      skipped: 0,
      todos: 0,
    });
    expect(swapObserved).toBe(true);
  });

  it("executes the exact verified bootstrap bytes after its pathname is swapped", async () => {
    const fixtureRoot = createFixture();
    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: {
          afterProbeVerified() {
            writeFileSync(
              join(fixtureRoot, "tests/helpers/red-probe-bootstrap.mjs"),
              'throw new Error("replacement bootstrap executed");\n',
              "utf8",
            );
          },
        },
      }),
    ).resolves.toMatchObject({ expectedRed: 1 });
  });

  it("does not let a swapped helper forge an equal-value probe", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({ actual: "1", expected: "1" }),
    });
    const replacement = [
      "export function createRedProbeAssertion() {",
      "  return () => undefined;",
      "}",
      "",
    ].join("\n");
    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: {
          afterProbeVerified() {
            writeFileSync(
              join(fixtureRoot, "tests/helpers/red-probe.ts"),
              replacement,
              "utf8",
            );
          },
        },
      }),
    ).rejects.toThrow("did not exit expected-red");
  });

  it("does not credit a dependency for the registered probe assertion", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        actual: "1",
        expected: "1",
        imports: ['import "../../helpers/dependency-reporter.mjs";'],
      }),
    });
    // Keep the singleton arm revert-sensitive to the original cached-helper
    // false green while exercising the replacement factory when it is visible.
    writeFixtureHelperModule(
      fixtureRoot,
      "dependency-reporter.mjs",
      [
        "try {",
        '  const helper = await import("./red-probe.ts");',
        `  const identity = ${JSON.stringify({
          fingerprint: testFingerprint,
          id: testId,
          task: testTask,
        })};`,
        '  if (typeof helper.expectDeepStrictEqualRedProbe === "function") {',
        '    process.once("uncaughtException", () => undefined);',
        "    helper.expectDeepStrictEqualRedProbe(identity, 1, 2);",
        "  } else {",
        "    const dependencyAssertion = helper.createRedProbeAssertion(() => undefined);",
        "    dependencyAssertion(identity, 1, 2);",
        "  }",
        "} catch {}",
        "",
      ].join("\n"),
    );

    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "did not exit expected-red",
    );
  });

  it("rejects a dependency loader hook that intercepts heartbeat writes and forges final evidence", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        actual: "1",
        expected: "1",
        imports: [
          'import { forgedCompletion } from "../../helpers/stdout-write-forger.js";',
        ],
        afterAssertion: ["await forgedCompletion;"],
      }),
      timeoutMs: 5_000,
    });
    writeFixtureHelperModule(
      fixtureRoot,
      "stdout-write-forger.ts",
      [
        'import { writeSync } from "node:fs";',
        'import { registerHooks } from "node:module";',
        "const stdout = process.stdout;",
        "const keepAlive = setInterval(() => undefined, 100);",
        "let forged = false;",
        "let resolveForgedCompletion!: () => void;",
        "export const forgedCompletion = new Promise<void>((resolve) => {",
        " resolveForgedCompletion = resolve;",
        "});",
        "function installInterception() {",
        " stdout._write = function interceptWrite(chunk, encoding, callback) {",
        '  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);',
        "  writeSync(1, chunk);",
        "  callback();",
        `  if (forged || !text.startsWith(${JSON.stringify(RUNNER_HEARTBEAT_PREFIX)})) return;`,
        `  const heartbeat = JSON.parse(text.slice(${RUNNER_HEARTBEAT_PREFIX.length}));`,
        "  if (heartbeat.sequence < 2) return;",
        "  forged = true;",
        "  clearInterval(keepAlive);",
        '  const evidence = typeof heartbeat.challenge === "string"',
        "    ? {",
        `        protocolVersion: ${RUNNER_PROTOCOL_VERSION},`,
        '        outcome: "expected-red",',
        "        id: heartbeat.id,",
        "        task: heartbeat.task,",
        "        fingerprint: heartbeat.fingerprint,",
        "        challenge: heartbeat.challenge,",
        "        assertions: 1,",
        "        skipped: 0,",
        "        todos: 0,",
        "      }",
        "    : {",
        `        protocolVersion: ${RUNNER_PROTOCOL_VERSION},`,
        '        outcome: "expected-red",',
        "        id: heartbeat.id,",
        "        task: heartbeat.task,",
        "        fingerprint: heartbeat.fingerprint,",
        "        assertions: 1,",
        "        skipped: 0,",
        "        todos: 0,",
        '        authenticationTag: "0".repeat(64),',
        "      };",
        `  writeSync(1, ${JSON.stringify(RUNNER_PROTOCOL_PREFIX)} + JSON.stringify(evidence) + "\\n");`,
        `  process.exitCode = ${RUNNER_EXPECTED_EXIT_CODE};`,
        "  resolveForgedCompletion();",
        " };",
        "}",
        'const triggerUrl = "data:text/javascript,agenc-red-probe-writer-hook";',
        "const loaderHooks = registerHooks({",
        " load(url, context, nextLoad) {",
        "  if (url !== triggerUrl) return nextLoad(url, context);",
        "  installInterception();",
        '  return { format: "module", shortCircuit: true, source: "export default undefined;" };',
        " },",
        "});",
        "void import(triggerUrl);",
        "void loaderHooks;",
        "",
      ].join("\n"),
    );

    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "unrelated or noncanonical output",
    );
  });

  it("does not let a dependency authorize success through a public lifecycle event", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: [
          'import { emitEarlyLifecycleAndExit } from "../../helpers/early-lifecycle-exit.js";',
        ],
        afterAssertion: [
          "emitEarlyLifecycleAndExit();",
          'throw new Error("unrelated failure hidden after expected-red");',
        ],
      }),
    });
    writeFixtureHelperModule(
      fixtureRoot,
      "early-lifecycle-exit.ts",
      [
        "export function emitEarlyLifecycleAndExit(): never {",
        '  process.emit("beforeExit", 0);',
        "  process.exit();",
        "}",
        "",
      ].join("\n"),
    );

    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "did not exit expected-red",
    );
  });

  it("keeps the standalone audit alive until a residual descendant is settled", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: ['import "../../helpers/residual-descendant.js";'],
      }),
      timeoutMs: 5_000,
    });
    const descendantMarker = join(fixtureRoot, "residual-descendant.pid");
    const runRootMarker = join(fixtureRoot, "audit-run-root.txt");
    const runBase = join(fixtureRoot, "audit-run-base");
    const standaloneAudit = join(fixtureRoot, "standalone-audit.mjs");
    writeFixtureHelperModule(
      fixtureRoot,
      "residual-descendant.ts",
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const descendant = spawn(process.execPath, ["--eval", ${JSON.stringify(
          "setTimeout(() => process.exit(0), 4_000);",
        )}], { stdio: "ignore" });`,
        'if (descendant.pid === undefined) throw new Error("missing descendant pid");',
        `writeFileSync(${JSON.stringify(descendantMarker)}, String(descendant.pid), "utf8");`,
        "descendant.unref();",
        "const watchdogObservationDelayMs = 250;",
        "const watchdogObservationCell = new Int32Array(new SharedArrayBuffer(4));",
        "Atomics.wait(watchdogObservationCell, 0, 0, watchdogObservationDelayMs);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      standaloneAudit,
      [
        'import { writeFileSync } from "node:fs";',
        `import { runRedProbeCli } from ${JSON.stringify(
          pathToFileURL(resolve(runtimeRoot, "scripts/run-fnd-red-probes.mjs"))
            .href,
        )};`,
        "const fixtureRoot = process.env.AGENC_RED_PROBE_TEST_FIXTURE_ROOT;",
        "const runBase = process.env.AGENC_RED_PROBE_TEST_RUN_BASE;",
        "const runRootMarker = process.env.AGENC_RED_PROBE_TEST_RUN_ROOT_MARKER;",
        "delete process.env.AGENC_RED_PROBE_TEST_FIXTURE_ROOT;",
        "delete process.env.AGENC_RED_PROBE_TEST_RUN_BASE;",
        "delete process.env.AGENC_RED_PROBE_TEST_RUN_ROOT_MARKER;",
        'if (!fixtureRoot || !runBase || !runRootMarker) throw new Error("missing standalone fixture inputs");',
        "process.exitCode = await runRedProbeCli({",
        "  runtimeRoot: fixtureRoot,",
        "  testing: {",
        "    runBase,",
        "    afterRunRootCreated({ runRoot }) {",
        '      writeFileSync(runRootMarker, runRoot, "utf8");',
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    let descendantPid: number | undefined;
    let runRoot: string | undefined;
    try {
      const result = spawnSync(process.execPath, [standaloneAudit], {
        cwd: runtimeRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENC_RED_PROBE_TEST_FIXTURE_ROOT: fixtureRoot,
          AGENC_RED_PROBE_TEST_RUN_BASE: runBase,
          AGENC_RED_PROBE_TEST_RUN_ROOT_MARKER: runRootMarker,
        },
        timeout: 15_000,
      });
      if (existsSync(descendantMarker)) {
        descendantPid = Number.parseInt(
          readFileSync(descendantMarker, "utf8"),
          10,
        );
      }
      if (existsSync(runRootMarker)) {
        runRoot = resolveTestOwnedAuditRunRoot(
          readFileSync(runRootMarker, "utf8"),
          runBase,
        );
      }

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(13);
      expect(result.stderr).not.toMatch(/unsettled top-level await/iu);
      if (process.platform === "win32") {
        // The Windows broker owns the full Job Object and kills remaining job
        // members as it closes the kernel boundary. Unlike the Linux
        // subreaper, it has no separate residual-status channel.
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(
          "red probes: files=1 expected-red=1 assertions=1 skipped=0 todo=0\n",
        );
        expect(result.stderr).toBe("");
      } else {
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("red-probe audit failed:");
        expect(result.stderr).toContain("stop=residual_process");
      }
      expect(descendantPid).toSatisfy(
        (pid: number | undefined) => Number.isSafeInteger(pid) && pid! > 1,
      );
      expect(await waitForProcessExit(descendantPid!, 2_000)).toBe(true);
      expect(runRoot).toBeDefined();
      expect(existsSync(runRoot!)).toBe(false);
    } finally {
      if (
        descendantPid !== undefined &&
        Number.isSafeInteger(descendantPid) &&
        descendantPid > 1 &&
        processIsAlive(descendantPid)
      ) {
        // The fixture has its own finite lifetime, so a failed containment
        // assertion never authorizes this test to signal a marker-supplied PID.
        await waitForProcessExit(descendantPid, 5_000);
      }
    }
  });

  it("removes the bootstrap configuration before probe dependencies execute", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: ['import "../../helpers/configuration-observer.js";'],
      }),
    });
    const marker = join(fixtureRoot, "configuration-observer.txt");
    writeFileSync(
      join(fixtureRoot, "tests/helpers/configuration-observer.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, String(process.env.AGENC_RED_PROBE_BOOTSTRAP_V1), "utf8");`,
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(
      auditRedProbes({ runtimeRoot: fixtureRoot }),
    ).resolves.toMatchObject({ expectedRed: 1 });
    expect(readFileSync(marker, "utf8")).toBe("undefined");
  });

  it("keeps the authentication secret out of the launch environment", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        actual: "1",
        expected: "1",
        imports: [
          'import "../../helpers/environment-authentication-forger.js";',
        ],
      }),
    });
    const marker = join(
      fixtureRoot,
      "environment-authentication-observation.json",
    );
    let initialConfiguration: Readonly<Record<string, unknown>> | undefined;
    writeFixtureHelperModule(
      fixtureRoot,
      "environment-authentication-forger.ts",
      [
        'import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";',
        'const variable = "AGENC_RED_PROBE_BOOTSTRAP_V1";',
        "let encoded = process.env[variable];",
        'let source = encoded === undefined ? "missing" : "process.env";',
        'if (existsSync("/proc/self/environ")) {',
        "  const prefix = `${variable}=`;",
        '  const entry = readFileSync("/proc/self/environ").toString("utf8").split("\\0").find(value => value.startsWith(prefix));',
        "  if (entry !== undefined) {",
        "    encoded = entry.slice(prefix.length);",
        '    source = "/proc/self/environ";',
        "  }",
        "}",
        "let configuration = Object.create(null);",
        "if (encoded !== undefined) {",
        "  try { configuration = JSON.parse(encoded); } catch {}",
        "}",
        'const authenticationSecretPresent = typeof configuration.authenticationSecret === "string";',
        "const residualStdinBytes = readFileSync(0).byteLength;",
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ authenticationSecretPresent, initialConfigurationPresent: encoded !== undefined, residualStdinBytes, source }), "utf8");`,
        `const evidence = { protocolVersion: ${RUNNER_PROTOCOL_VERSION}, outcome: "expected-red", id: configuration.id ?? ${JSON.stringify(testId)}, task: configuration.task ?? ${JSON.stringify(testTask)}, fingerprint: configuration.fingerprint ?? ${JSON.stringify(testFingerprint)}, assertions: 1, skipped: 0, todos: 0, authenticationTag: "0".repeat(64) };`,
        `writeSync(1, ${JSON.stringify(RUNNER_PROTOCOL_PREFIX)} + JSON.stringify(evidence) + "\\n");`,
        `process.exitCode = ${RUNNER_EXPECTED_EXIT_CODE};`,
        "",
      ].join("\n"),
    );

    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: {
          afterProbeEnvironmentCreated({
            bootstrapConfiguration,
          }: {
            readonly bootstrapConfiguration: Readonly<Record<string, unknown>>;
          }) {
            initialConfiguration = bootstrapConfiguration;
          },
        },
      }),
    ).rejects.toThrow("unrelated or noncanonical output");
    expect(initialConfiguration).toBeDefined();
    expect(Object.hasOwn(initialConfiguration!, "authenticationSecret")).toBe(
      false,
    );
    const observation = JSON.parse(readFileSync(marker, "utf8")) as {
      readonly authenticationSecretPresent: boolean;
      readonly initialConfigurationPresent: boolean;
      readonly residualStdinBytes: number;
      readonly source: string;
    };
    expect(observation.authenticationSecretPresent).toBe(false);
    expect(observation.residualStdinBytes).toBe(0);
    if (observation.source === "/proc/self/environ") {
      expect(observation.initialConfigurationPresent).toBe(true);
    }
  });

  it("removes the reporter handoff before probe dependencies execute", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: ['import "../../helpers/handoff-observer.js";'],
      }),
    });
    const marker = join(fixtureRoot, "handoff-observer.txt");
    writeFixtureHelperModule(
      fixtureRoot,
      "handoff-observer.ts",
      [
        'import { writeFileSync } from "node:fs";',
        `const handoff = Object.getOwnPropertyDescriptor(globalThis, Symbol.for(${JSON.stringify(reporterHandoffSymbolKey)}));`,
        `writeFileSync(${JSON.stringify(marker)}, handoff === undefined ? "absent" : "present", "utf8");`,
        "",
      ].join("\n"),
    );
    await expect(
      auditRedProbes({ runtimeRoot: fixtureRoot }),
    ).resolves.toMatchObject({ expectedRed: 1 });
    expect(readFileSync(marker, "utf8")).toBe("absent");
  });

  it.each([
    {
      name: "direct global lookup",
      expression: "globalThis",
    },
    {
      name: "Function-constructor lookup",
      expression: 'Function("return globalThis")()',
    },
  ])(
    "does not let an imported dependency forge through $name",
    async ({ expression }) => {
      const fixtureRoot = createFixture({
        source: probeSource({
          actual: "1",
          expected: "1",
          imports: ['import "../../helpers/reporter-forger.js";'],
        }),
      });
      writeFixtureHelperModule(
        fixtureRoot,
        "reporter-forger.ts",
        [
          `const root = ${expression};`,
          `const reporter = root[Symbol.for(${JSON.stringify(reporterHandoffSymbolKey)})];`,
          `if (typeof reporter === "function") reporter(${JSON.stringify({
            fingerprint: testFingerprint,
            id: testId,
            task: testTask,
          })});`,
          "",
        ].join("\n"),
      );
      await expect(
        auditRedProbes({ runtimeRoot: fixtureRoot }),
      ).rejects.toThrow("did not exit expected-red");
    },
  );

  it("pins the deep-equality predicate before dependencies can replace builtin exports", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        actual: "1",
        expected: "1",
        imports: ['import "../../helpers/builtin-forger.js";'],
      }),
    });
    writeFixtureHelperModule(
      fixtureRoot,
      "builtin-forger.ts",
      [
        'import { createRequire, syncBuiltinESMExports } from "node:module";',
        "const require = createRequire(import.meta.url);",
        'const util = require("node:util");',
        "util.isDeepStrictEqual = () => false;",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "did not exit expected-red",
    );
  });

  it("rejects a caught public-network exception even after the probe reproduces red", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        actual: "caughtBlockedNetworkAttempt",
        expected: "false",
        imports: [
          'import { caughtBlockedNetworkAttempt } from "../../helpers/caught-network-attempt.js";',
        ],
      }),
    });
    writeFixtureHelperModule(
      fixtureRoot,
      "caught-network-attempt.ts",
      [
        'import { connect } from "node:net";',
        "let caughtBlockedNetworkAttempt = false;",
        "try {",
        '  connect({ host: "192.0.2.1", port: 443 });',
        "} catch (error) {",
        '  if (!(error instanceof Error) || error.code !== "AGENC_TEST_PUBLIC_NETWORK_BLOCKED") throw error;',
        "  caughtBlockedNetworkAttempt = true;",
        "}",
        "export { caughtBlockedNetworkAttempt };",
        "",
      ].join("\n"),
    );
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "red probes attempted public network access",
    );
  });

  it("does not mask a dependency-provided nonzero exit status", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: ['import "../../helpers/nonzero-exit.js";'],
      }),
      timeoutMs: 5_000,
    });
    writeFileSync(
      join(fixtureRoot, "tests/helpers/nonzero-exit.ts"),
      [
        "setInterval(() => undefined, 1_000);",
        "process.exitCode = 23;",
        "process.exit = (() => undefined) as typeof process.exit;",
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "did not exit expected-red: exit=23",
    );
  });

  it("rejects canonical final evidence paired with a different child exit", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: ['import "../../helpers/exit-pairing.mjs";'],
      }),
    });
    writeFixtureHelperModule(
      fixtureRoot,
      "exit-pairing.mjs",
      [
        'process.once("beforeExit", () => {',
        "  process.exitCode = 0;",
        "});",
        "",
      ].join("\n"),
    );
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "did not exit expected-red",
    );
  });

  it.each([
    {
      name: "unexpected pass",
      source: probeSource({ actual: "1", expected: "1" }),
      error: "did not exit expected-red",
    },
    {
      name: "unrelated crash",
      source: probeSource({
        beforeAssertion: ['throw new Error("unrelated failure");'],
      }),
      error: "did not exit expected-red",
    },
    {
      name: "wrong fingerprint",
      source: probeSource({
        fingerprint: "FND-001:HARNESS-SELF-TEST:WRONG-FINGERPRINT",
      }),
      error: "did not exit expected-red",
    },
    {
      name: "wrong probe id",
      source: probeSource({ id: "impersonating-probe" }),
      error: "did not exit expected-red",
    },
    {
      name: "wrong task",
      source: probeSource({ task: "FND-999" }),
      error: "did not exit expected-red",
    },
    {
      name: "unrelated stderr",
      source: probeSource({
        imports: ['import { writeSync } from "node:fs";'],
        beforeAssertion: ['writeSync(2, "unrelated\\n");'],
      }),
      error: "unrelated or noncanonical output",
    },
    {
      name: "timeout",
      source: probeSource({
        beforeAssertion: ["setInterval(() => undefined, 1_000);"],
      }),
      timeoutMs: 100,
      error: "timed out after 100ms",
    },
    {
      name: "output overflow",
      source: probeSource({
        imports: ['import { writeSync } from "node:fs";'],
        beforeAssertion: [
          "const overflowChunk = Buffer.alloc(256, 120);",
          "let overflowBytes = 0;",
          "while (overflowBytes < 32_768) overflowBytes += writeSync(1, overflowChunk);",
        ],
      }),
      error: "exceeded the child-output limit",
    },
  ])("rejects $name", async ({ source, timeoutMs, error }) => {
    const fixtureRoot = createFixture({ source, timeoutMs });
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      error,
    );
  });

  it("rejects a getter-thrown AssertionError without platform-dependent fatal formatting", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        imports: [
          'import { AssertionError } from "node:assert";',
          'import "../../helpers/assertion-error-exit.mjs";',
        ],
        beforeAssertion: [
          "const actual = { get value() {",
          '  throw new AssertionError({ actual: 1, expected: 2, operator: "deepStrictEqual" });',
          "} };",
        ],
        actual: "actual",
        expected: "{ value: 2 }",
      }),
    });
    writeFixtureHelperModule(
      fixtureRoot,
      "assertion-error-exit.mjs",
      [
        'import { AssertionError } from "node:assert";',
        'process.once("uncaughtException", (error) => {',
        "  if (!(error instanceof AssertionError)) throw error;",
        "  process.exitCode = 1;",
        "});",
        "",
      ].join("\n"),
    );

    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "did not exit expected-red",
    );
  });

  it("aborts a probe whose trusted heartbeat stalls before its hard deadline", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        beforeAssertion: [
          "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);",
        ],
      }),
      timeoutMs: 10_000,
    });
    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: { heartbeatSilenceMs: 2_000 },
      }),
    ).rejects.toThrow("missed a trusted heartbeat for 2000ms");
  });

  it("terminates resistant descendants when a probe times out", async () => {
    const fixtureRoot = createFixture();
    const marker = join(fixtureRoot, "descendant.pid");
    let supervisedRunRoot: string | undefined;
    const source = probeSource({
      imports: [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
      ],
      beforeAssertion: [
        "const child = spawn('node', ['--eval', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], {",
        "  detached: true,",
        '  stdio: "ignore",',
        "});",
        'if (child.pid === undefined) throw new Error("missing descendant pid");',
        `writeFileSync(${JSON.stringify(marker)}, String(child.pid), "utf8");`,
        "child.unref();",
        "setInterval(() => undefined, 1_000);",
      ],
    });
    writeFileSync(
      join(fixtureRoot, "tests/fnd/red-probes/contract-fixture.red-probe.ts"),
      source,
      "utf8",
    );
    const manifestPath = join(
      fixtureRoot,
      "tests/fnd/red-probes/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      probes: Array<{ sourceSha256: string; timeoutMs: number }>;
    };
    manifest.probes[0]!.timeoutMs = coldModuleFixtureTimeoutMs;
    manifest.probes[0]!.sourceSha256 = sha256(source);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    await expect(
      auditRedProbes({
        runtimeRoot: fixtureRoot,
        testing: {
          afterRunRootCreated({ runRoot }: { readonly runRoot: string }) {
            supervisedRunRoot = runRoot;
          },
        },
      }),
    ).rejects.toThrow(
      `timed out after ${coldModuleFixtureTimeoutMs}ms`,
    );
    const descendantPid = Number.parseInt(readFileSync(marker, "utf8"), 10);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow();
    expect(supervisedRunRoot).toBeDefined();
    expect(existsSync(supervisedRunRoot!)).toBe(false);
  });

  it("rejects skip, todo, conditional, and test.fails controls in probes", async () => {
    for (const control of [
      "skip(() => undefined);\n",
      "todo(() => undefined);\n",
      "test.skip(() => undefined);\n",
      "test.fails(() => undefined);\n",
      "test.runIf(true)(() => undefined);\n",
      'test["skip"](() => undefined);\n',
      "const selected = test.todo; selected(() => undefined);\n",
    ]) {
      const source = probeSource({ beforeAssertion: [control] });
      const fixtureRoot = createFixture({ source });
      await expect(
        auditRedProbes({ runtimeRoot: fixtureRoot }),
      ).rejects.toThrow(/forbidden test/u);
    }
  });

  it("rejects static, dynamic, and require-based test-framework imports", async () => {
    for (const source of [
      probeSource({ imports: ['import { test } from "vitest";'] }),
      probeSource({ beforeAssertion: ['await import("vitest");'] }),
      probeSource({ beforeAssertion: ['require("bun:test");'] }),
      probeSource({
        beforeAssertion: [
          'const moduleName = "vitest";',
          "await import(moduleName);",
        ],
      }),
      probeSource({
        beforeAssertion: [
          'const moduleName = "bun:test";',
          "require(moduleName);",
        ],
      }),
    ]) {
      const fixtureRoot = createFixture({ source });
      await expect(
        auditRedProbes({ runtimeRoot: fixtureRoot }),
      ).rejects.toThrow(/test framework|dynamic import|require loading/u);
    }
  });

  it("bounds source-policy AST depth with iterative traversal", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        beforeAssertion: [
          `const deeplyNested = ${"(".repeat(160)}1${")".repeat(160)};`,
        ],
      }),
    });
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "128-level source-policy limit",
    );
  });

  it("bounds source-policy AST nodes before policy accumulation", async () => {
    const fixtureRoot = createFixture({
      source: probeSource({
        beforeAssertion: [
          `const manyNodes = [${Array.from(
            { length: sourceAstNodeOverflowItems },
            () => "!0",
          ).join(",")}];`,
        ],
      }),
    });
    await expect(auditRedProbes({ runtimeRoot: fixtureRoot })).rejects.toThrow(
      "32768-node source-policy limit",
    );
  });

  it("rejects direct, global, aliased, computed, and imported process output", async () => {
    const forgedEvidence = `${RUNNER_PROTOCOL_PREFIX}${JSON.stringify({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      outcome: "expected-red",
      id: testId,
      task: testTask,
      fingerprint: testFingerprint,
      assertions: 1,
      skipped: 0,
      todos: 0,
      authenticationTag: "0".repeat(64),
    })}\n`;
    for (const source of [
      probeSource({
        beforeAssertion: [
          `process.stdout.write(${JSON.stringify(forgedEvidence)});`,
          `process.exitCode = ${RUNNER_EXPECTED_EXIT_CODE};`,
        ],
      }),
      probeSource({
        beforeAssertion: [
          `globalThis["process"]["stdout"].write(${JSON.stringify(forgedEvidence)});`,
        ],
      }),
      probeSource({
        beforeAssertion: [
          "const proc = process;",
          `proc.stdout.write(${JSON.stringify(forgedEvidence)});`,
        ],
      }),
      probeSource({
        beforeAssertion: [
          `process["stdout"]["write"](${JSON.stringify(forgedEvidence)});`,
        ],
      }),
      probeSource({
        imports: ['import { stdout } from "node:process";'],
        beforeAssertion: [`stdout.write(${JSON.stringify(forgedEvidence)});`],
      }),
    ]) {
      const fixtureRoot = createFixture({ source });
      await expect(
        auditRedProbes({ runtimeRoot: fixtureRoot }),
      ).rejects.toThrow(/forbidden global access|imports process access/u);
    }
  });

  it("requires one canonical root runner and one direct capability call", async () => {
    const validSource = probeSource();
    const directAssertion = "  expectDeepStrictEqualRedProbe(identity, 1, 2);";
    for (const source of [
      validSource.replace(`${canonicalHelperTypeImport}\n`, ""),
      validSource.replace(
        "export default async function runRedProbe(",
        "export default function runRedProbe(",
      ),
      validSource.replace(
        directAssertion,
        [
          "  const assertion = expectDeepStrictEqualRedProbe;",
          "  assertion(identity, 1, 2);",
        ].join("\n"),
      ),
      validSource.replace(
        directAssertion,
        [
          "  function assertLater() {",
          "    expectDeepStrictEqualRedProbe(identity, 1, 2);",
          "  }",
          "  assertLater();",
        ].join("\n"),
      ),
      validSource.replace(
        directAssertion,
        `${directAssertion}\n  expectDeepStrictEqualRedProbe(identity, 3, 4);`,
      ),
      validSource.replace(
        directAssertion,
        `  void arguments[0];\n${directAssertion}`,
      ),
    ]) {
      const fixtureRoot = createFixture({ source });
      await expect(
        auditRedProbes({ runtimeRoot: fixtureRoot }),
      ).rejects.toThrow(
        /canonical red-probe helper|canonical root runner|aliases the red-probe assertion|direct root-runner|forbidden global access/u,
      );
    }
  });
});

describe("red-probe discovery wiring", () => {
  it("keeps red probes outside ordinary Vitest, native, and Bun discovery", () => {
    const includedByDefault = DEFAULT_TEST_INCLUDE.some((pattern) =>
      matchesGlob(redProbeFile, pattern),
    );
    expect(includedByDefault).toBe(false);
    expect(DEFAULT_TEST_EXCLUDE).toContain("**/*.red-probe.ts");
    expect(NATIVE_TEST_INCLUDE).not.toContain(redProbeFile);

    const bunRunner = readFileSync(
      resolve(runtimeRoot, "scripts/run-bun-tests-isolated.mjs"),
      "utf8",
    );
    expect(bunRunner).toContain(
      "if (entry.isFile() && /\\.test\\.tsx?$/.test(entry.name))",
    );
    expect(/\.test\.tsx?$/u.test(basename(redProbeFile))).toBe(false);
  });

  it("keeps both required JSON control files visible to Git", () => {
    for (const file of [
      "runtime/tests/fnd/red-probes/manifest.json",
      "runtime/tsconfig.test-support.json",
    ]) {
      const result = spawnSync(
        "git",
        ["check-ignore", "--no-index", "--quiet", "--", file],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${file} is ignored`).toBe(1);
      const discoverable = spawnSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "--", file],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(discoverable.status, discoverable.stderr).toBe(0);
      expect(discoverable.stdout.trim()).toBe(file);
    }
  });
});
