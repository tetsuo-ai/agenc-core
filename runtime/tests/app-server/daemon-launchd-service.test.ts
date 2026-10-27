import { describe, expect, it } from "vitest";

import {
  findLaunchdDaemonJob,
  kickstartLaunchdDaemonJob,
  launchdProgramAgenCHome,
  type LaunchdCommandResult,
  type LaunchdDaemonJobDeps,
} from "./daemon-launchd-service.js";

function installerWrapper(agencHome: string): string {
  const metadata = Buffer.from(
    JSON.stringify({
      nodeBin: "/Users/a/.agenc/runtime/0.19.1/node_modules/.agenc-node/bin/node",
      runtimeBin: "/Users/a/.agenc/runtime/0.19.1/node_modules/@tetsuo-ai/runtime/bin/agenc",
      agencHome,
    }),
  ).toString("base64url");
  return [
    "#!/bin/sh",
    `# AgenC wrapper metadata v1: ${metadata}`,
    'if [ -z "${AGENC_HOME:-}" ]; then',
    `  export AGENC_HOME='${agencHome}'`,
    "fi",
    "",
  ].join("\n");
}

const HOMEBREW_WRAPPER = [
  "#!/bin/sh",
  'if [ -z "${AGENC_HOME:-}" ]; then',
  '  export AGENC_HOME="${HOME}/.agenc"',
  "fi",
  "",
].join("\n");

function printed(program: string): LaunchdCommandResult {
  return {
    status: 0,
    stdout: [
      "gui/501/dev.agenc.daemon = {",
      "\tactive count = 1",
      "\tpath = /Users/a/Library/LaunchAgents/dev.agenc.daemon.plist",
      "\tstate = running",
      "",
      `\tprogram = ${program}`,
      "\targuments = {",
      `\t\t${program}`,
      "\t\tdaemon",
      "\t}",
      "}",
      "",
    ].join("\n"),
  };
}

function deps(
  jobs: Record<string, LaunchdCommandResult>,
  files: Record<string, string>,
  calls: string[][] = [],
): LaunchdDaemonJobDeps {
  return {
    uid: 501,
    accountHome: "/Users/a",
    launchctl: (args) => {
      calls.push([...args]);
      return jobs[args.join(" ")] ?? { status: 113, stdout: "" };
    },
    readText: (path) => files[path] ?? null,
    sameDirectory: (left, right) => left === right,
  };
}

describe("launchd jobs that run the AgenC daemon", () => {
  it("reads the home from each wrapper the installers write", () => {
    expect(launchdProgramAgenCHome(installerWrapper("/Users/a/.agenc"), "/Users/a"))
      .toBe("/Users/a/.agenc");
    expect(
      launchdProgramAgenCHome(
        '#!/bin/sh\nexport AGENC_HOME="${AGENC_HOME:-/Users/a/.agenc}"\nexec "/n" "/r" "$@"\n',
        "/Users/a",
      ),
    ).toBe("/Users/a/.agenc");
    expect(launchdProgramAgenCHome(HOMEBREW_WRAPPER, "/Users/a")).toBe("/Users/a/.agenc");
    expect(launchdProgramAgenCHome("#!/bin/sh\nexec agenc \"$@\"\n", "/Users/a")).toBeUndefined();
    expect(
      launchdProgramAgenCHome("# AgenC wrapper metadata v1: bm90LWpzb24\n", "/Users/a"),
    ).toBeUndefined();
  });

  it("finds the installer job that runs this home", () => {
    const calls: string[][] = [];
    const job = findLaunchdDaemonJob(
      "/Users/a/.agenc",
      deps(
        { "print gui/501/dev.agenc.daemon": printed("/Users/a/.local/bin/agenc") },
        { "/Users/a/.local/bin/agenc": installerWrapper("/Users/a/.agenc") },
        calls,
      ),
    );
    expect(job).toEqual({ label: "dev.agenc.daemon", target: "gui/501/dev.agenc.daemon" });
    expect(calls).toEqual([["print", "gui/501/dev.agenc.daemon"]]);
  });

  it("falls back to the brew services job", () => {
    const job = findLaunchdDaemonJob(
      "/Users/a/.agenc",
      deps(
        { "print gui/501/homebrew.mxcl.agenc": printed("/opt/homebrew/opt/agenc/bin/agenc") },
        { "/opt/homebrew/opt/agenc/bin/agenc": HOMEBREW_WRAPPER },
      ),
    );
    expect(job).toEqual({ label: "homebrew.mxcl.agenc", target: "gui/501/homebrew.mxcl.agenc" });
  });

  it("never claims a job that runs another home", () => {
    // A second install with its own HOME (a test home, another AgenC home)
    // must leave the account's real job alone.
    expect(
      findLaunchdDaemonJob(
        "/private/tmp/clean/.agenc",
        deps(
          {
            "print gui/501/dev.agenc.daemon": printed("/Users/a/.local/bin/agenc"),
            "print gui/501/homebrew.mxcl.agenc": printed("/opt/homebrew/opt/agenc/bin/agenc"),
          },
          {
            "/Users/a/.local/bin/agenc": installerWrapper("/Users/a/.agenc"),
            "/opt/homebrew/opt/agenc/bin/agenc": HOMEBREW_WRAPPER,
          },
        ),
      ),
    ).toBeNull();
    expect(findLaunchdDaemonJob("/Users/a/.agenc", deps({}, {}))).toBeNull();
  });

  it("returns the pid launchctl kickstart prints", () => {
    const job = { label: "dev.agenc.daemon", target: "gui/501/dev.agenc.daemon" };
    const calls: string[][] = [];
    expect(
      kickstartLaunchdDaemonJob(job, deps({ "kickstart -p gui/501/dev.agenc.daemon": { status: 0, stdout: "6123\n" } }, {}, calls)),
    ).toEqual({ pid: 6123 });
    expect(calls).toEqual([["kickstart", "-p", "gui/501/dev.agenc.daemon"]]);
    expect(kickstartLaunchdDaemonJob(job, deps({}, {}))).toEqual({
      error: "launchctl kickstart gui/501/dev.agenc.daemon exited 113",
    });
  });
});
