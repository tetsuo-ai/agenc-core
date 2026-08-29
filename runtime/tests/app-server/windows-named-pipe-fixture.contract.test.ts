import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

const source = readFileSync(
  join(import.meta.dirname, "windows-named-pipe.win32.test.ts"),
  "utf8",
);

const pipeFixtureTitle =
  "the authenticated daemon client round-trips over a private Windows named pipe";
const lifecycleFixtureTitle =
  "the built Windows CLI completes daemon start, status, SDK, reload, and stop";

test("both Windows named-pipe fixtures use the exception-safe user-profile root harness", () => {
  const fixtures = [
    {
      source: extractTestSource(pipeFixtureTitle, lifecycleFixtureTitle),
      prefix: "agenc-daemon-pipe-",
    },
    {
      source: extractTestSource(
        lifecycleFixtureTitle,
        "type WindowsFixtureCleanup",
      ),
      prefix: "agenc-daemon-lifecycle-",
    },
  ];

  for (const fixture of fixtures) {
    expect(fixture.source).toMatch(
      new RegExp(
        `withWindowsPrivateFixtureRoot\\(\\s*"${fixture.prefix}"`,
        "u",
      ),
    );
    expect(fixture.source).toContain("async (root, registerCleanup) =>");
    expect(fixture.source).not.toContain("mkdtemp(");
    expect(fixture.source).not.toContain("tmpdir()");
  }
});

test("the Windows fixture harness cleans acquired resources before removing its private root", () => {
  const helper = extractSource(
    "type WindowsFixtureCleanup",
    "function runBuiltDaemonCli",
  );
  const mkdtempIndex = helper.indexOf("await mkdtemp(");
  const securityIndex = helper.indexOf("assertWindowsPrivatePathSecurity(");
  const actionIndex = helper.indexOf("await action(root, registerCleanup)");
  const cleanupIndex = helper.indexOf("cleanupActions.length - 1");
  const removeRootIndex = helper.indexOf("await rm(root,");
  const reportErrorsIndex = helper.lastIndexOf("throwWindowsFixtureErrors(");

  expect(mkdtempIndex).toBeGreaterThanOrEqual(0);
  expect(securityIndex).toBeGreaterThan(mkdtempIndex);
  expect(actionIndex).toBeGreaterThan(securityIndex);
  expect(cleanupIndex).toBeGreaterThan(actionIndex);
  expect(removeRootIndex).toBeGreaterThan(cleanupIndex);
  expect(reportErrorsIndex).toBeGreaterThan(removeRootIndex);
  expect(helper).toContain("errors.push(error);");
  expect(helper).toContain("new AggregateError(errors,");
});

test("the Windows fixtures register server and daemon cleanup before starting them", () => {
  const pipeFixture = extractTestSource(
    pipeFixtureTitle,
    lifecycleFixtureTitle,
  );
  const conditionalServerCloseIndex = pipeFixture.indexOf(
    "if (server !== null)",
  );
  const createServerIndex = pipeFixture.indexOf("new AgenCUnixSocketServer(");
  const listenIndex = pipeFixture.indexOf("await configuredServer.listen()");

  expect(conditionalServerCloseIndex).toBeGreaterThanOrEqual(0);
  expect(createServerIndex).toBeGreaterThan(conditionalServerCloseIndex);
  expect(listenIndex).toBeGreaterThan(createServerIndex);

  const lifecycleFixture = extractTestSource(
    lifecycleFixtureTitle,
    "type WindowsFixtureCleanup",
  );
  const killCleanupIndex = lifecycleFixture.indexOf(
    'process.kill(daemonPid, "SIGKILL")',
  );
  const stopCleanupIndex = lifecycleFixture.indexOf("const cleanupStop =");
  const startIndex = lifecycleFixture.indexOf(
    'runBuiltDaemonCli(binAgenc, ["daemon", "start"], env)',
  );

  // Cleanup handlers run in reverse registration order: graceful stop, exact
  // PID kill fallback, then private-root removal in the shared harness.
  expect(killCleanupIndex).toBeGreaterThanOrEqual(0);
  expect(stopCleanupIndex).toBeGreaterThan(killCleanupIndex);
  expect(startIndex).toBeGreaterThan(stopCleanupIndex);
});

function extractTestSource(title: string, nextMarker: string): string {
  const titleMarker = JSON.stringify(title);
  const titleIndex = source.indexOf(titleMarker);
  expect(titleIndex).toBeGreaterThanOrEqual(0);

  const testStart = source.lastIndexOf("test(", titleIndex);
  expect(testStart).toBeGreaterThanOrEqual(0);

  const end = source.indexOf(nextMarker, titleIndex + titleMarker.length);
  expect(end).toBeGreaterThan(testStart);
  return source.slice(testStart, end);
}

function extractSource(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
