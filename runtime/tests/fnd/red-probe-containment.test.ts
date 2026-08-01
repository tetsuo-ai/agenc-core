import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const runtimeRoot = fileURLToPath(new URL("../../", import.meta.url));
const redProbeRunnerUrl = new URL(
  "../../scripts/run-fnd-red-probes.mjs",
  import.meta.url,
).href;
const auditSha = "d2b228e87ea63bd6a5d93e6f599f36bce88d672b";
const fixtureId = "windows-containment";
const fixtureFingerprint = "FND-001:HARNESS-SELF-TEST:WINDOWS-CONTAINMENT";
const fixtureFile = "tests/fnd/red-probes/windows-containment.red-probe.ts";
const helperTypeImport =
  'import type { RedProbeAssertion } from "../../helpers/red-probe.js";';
const standaloneAuditTimeoutMs = 15_000;
const temporaryRoots: string[] = [];
const possibleDescendantPids: number[] = [];

interface FixtureOptions {
  readonly source: string;
  readonly timeoutMs: number;
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalProbe(
  beforeAssertion: readonly string[],
  imports: readonly string[] = [],
): string {
  return [
    helperTypeImport,
    ...imports,
    "export default async function runRedProbe(",
    "  expectDeepStrictEqualRedProbe: RedProbeAssertion,",
    "): Promise<void> {",
    `  const identity = ${JSON.stringify({
      id: fixtureId,
      task: "FND-001",
      fingerprint: fixtureFingerprint,
    })};`,
    ...beforeAssertion.flatMap((line) =>
      line.split("\n").map((part) => `  ${part}`),
    ),
    "  expectDeepStrictEqualRedProbe(identity, 1, 2);",
    "}",
    "",
  ].join("\n");
}

function createFixture(options: FixtureOptions): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "agenc-red-containment-"));
  temporaryRoots.push(fixtureRoot);
  const probeDirectory = join(fixtureRoot, "tests/fnd/red-probes");
  const helperDirectory = join(fixtureRoot, "tests/helpers");
  mkdirSync(probeDirectory, { recursive: true });
  mkdirSync(helperDirectory, { recursive: true });
  copyFileSync(
    join(runtimeRoot, "tests/helpers/red-probe.ts"),
    join(helperDirectory, "red-probe.ts"),
  );
  copyFileSync(
    join(runtimeRoot, "tests/helpers/red-probe-bootstrap.mjs"),
    join(helperDirectory, "red-probe-bootstrap.mjs"),
  );
  writeFileSync(join(fixtureRoot, fixtureFile), options.source, "utf8");
  writeFileSync(
    join(probeDirectory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      auditSha,
      probeCount: 1,
      probes: [
        {
          id: fixtureId,
          task: "FND-001",
          classification: "harness-self-test",
          file: fixtureFile,
          fingerprint: fixtureFingerprint,
          sourceSha256: sha256(options.source),
          timeoutMs: options.timeoutMs,
        },
      ],
    })}\n`,
    "utf8",
  );
  return fixtureRoot;
}

function runFixtureAudit(fixtureRoot: string): {
  readonly result: SpawnSyncReturns<string>;
  readonly runRootMarker: string;
} {
  const standaloneAudit = join(fixtureRoot, "standalone-audit.mjs");
  const runRootMarker = join(fixtureRoot, "audit-run-root.txt");
  writeFileSync(
    standaloneAudit,
    [
      'import { writeFileSync } from "node:fs";',
      `import { runRedProbeCli } from ${JSON.stringify(redProbeRunnerUrl)};`,
      "const fixtureRoot = process.env.AGENC_RED_PROBE_TEST_FIXTURE_ROOT;",
      "const runRootMarker = process.env.AGENC_RED_PROBE_TEST_RUN_ROOT_MARKER;",
      "delete process.env.AGENC_RED_PROBE_TEST_FIXTURE_ROOT;",
      "delete process.env.AGENC_RED_PROBE_TEST_RUN_ROOT_MARKER;",
      'if (!fixtureRoot || !runRootMarker) throw new Error("missing standalone audit inputs");',
      "process.exitCode = await runRedProbeCli({",
      "  runtimeRoot: fixtureRoot,",
      "  testing: {",
      "    afterRunRootCreated({ runRoot }) {",
      '      writeFileSync(runRootMarker, runRoot, "utf8");',
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = spawnSync(process.execPath, [standaloneAudit], {
    cwd: runtimeRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENC_RED_PROBE_TEST_FIXTURE_ROOT: fixtureRoot,
      AGENC_RED_PROBE_TEST_RUN_ROOT_MARKER: runRootMarker,
    },
    timeout: standaloneAuditTimeoutMs,
  });
  return { result, runRootMarker };
}

function expectFailedAudit(
  result: SpawnSyncReturns<string>,
  expectedMessage: string,
): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("red-probe audit failed:");
  expect(result.stderr).toContain(expectedMessage);
}

afterEach(() => {
  for (const pid of possibleDescendantPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The containment contract normally removes the process first.
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("red-probe forced containment", () => {
  it("enforces the hard deadline after an expected-red assertion", () => {
    const fixtureRoot = createFixture({
      source: canonicalProbe(["setInterval(() => undefined, 1_000);"]),
      timeoutMs: 100,
    });

    const { result } = runFixtureAudit(fixtureRoot);
    expectFailedAudit(result, "timed out after 100ms");
  });

  it("enforces the aggregate child-output limit", () => {
    const fixtureRoot = createFixture({
      source: canonicalProbe(
        ["writeSync(1, Buffer.alloc(32_768, 120));"],
        ['import { writeSync } from "node:fs";'],
      ),
      timeoutMs: 5_000,
    });

    const { result } = runFixtureAudit(fixtureRoot);
    expectFailedAudit(result, "exceeded the child-output limit");
  });

  it("kills a resistant detached descendant and removes the run root", () => {
    const fixtureRoot = createFixture({
      source: "",
      timeoutMs: 500,
    });
    const marker = join(fixtureRoot, "descendant.pid");
    const source = canonicalProbe(
      [
        `const child = spawn("node", ["--eval", ${JSON.stringify(
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
        )}], {`,
        "  detached: true,",
        '  stdio: "ignore",',
        "});",
        'if (child.pid === undefined) throw new Error("missing descendant pid");',
        `writeFileSync(${JSON.stringify(marker)}, String(child.pid), "utf8");`,
        "child.unref();",
        "setInterval(() => undefined, 1_000);",
      ],
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
      ],
    );
    writeFileSync(join(fixtureRoot, fixtureFile), source, "utf8");
    const manifestPath = join(
      fixtureRoot,
      "tests/fnd/red-probes/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      probes: Array<{ sourceSha256: string }>;
    };
    manifest.probes[0]!.sourceSha256 = sha256(source);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const { result, runRootMarker } = runFixtureAudit(fixtureRoot);
    expectFailedAudit(result, "timed out after 500ms");

    const descendantPid = Number.parseInt(readFileSync(marker, "utf8"), 10);
    const runRoot = readFileSync(runRootMarker, "utf8");
    possibleDescendantPids.push(descendantPid);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow();
    possibleDescendantPids.pop();
    expect(runRoot).not.toBe("");
    expect(existsSync(runRoot)).toBe(false);
  });
});
