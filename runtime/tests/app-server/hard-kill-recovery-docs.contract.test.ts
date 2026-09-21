import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DEFAULT_DAEMON_START_MAX_WAIT_MS } from "../../src/app-server/daemon-cli.js";
import {
  AGENC_DAEMON_LOST_TURN_PROBE_MS,
  AGENC_DAEMON_LOST_TURN_REASON,
} from "../../src/tui/daemon-session.js";

describe("hard-killed daemon recovery docs", () => {
  it("pins connectability readiness, hydrating start, and the TUI 10 s probe", async () => {
    expect(AGENC_DAEMON_LOST_TURN_PROBE_MS).toBe(10_000);
    expect(AGENC_DAEMON_LOST_TURN_REASON).toBe(
      "the daemon stopped responding; the turn cannot continue here",
    );
    expect(DEFAULT_DAEMON_START_MAX_WAIT_MS).toBe(600_000);

    const daemon = await readFile("../docs/reference/daemon.md", "utf8");

    expect(daemon).toContain("### Recovery after a disappeared daemon");
    expect(daemon).toContain("accept a connection");
    expect(daemon).toContain("isAgenCDaemonPidAndCookieReady");
    expect(daemon).toContain("canConnectToUnixSocket");
    expect(daemon).toContain("gave up after 3");
    expect(daemon).toContain("lacked a portable instance identity");
    expect(daemon).toContain("do not delete the socket by hand");
    expect(daemon).toContain("AGENC_DAEMON_START_MAX_WAIT_MS");
    expect(daemon).toContain("**600000**");
    expect(daemon).toContain("still starting");
    expect(daemon).toContain("do not");
    expect(daemon).toContain("inherit the 600 s hydration ceiling");
    expect(daemon).toContain("AGENC_DAEMON_LOST_TURN_PROBE_MS");
    expect(daemon).toContain("**10 s**");
    expect(daemon).toContain("session.snapshot");
    expect(daemon).toContain("the daemon stopped responding; the turn cannot continue here");
    expect(daemon).toContain("Print mode and the SDK have no 10 s lost-turn");
  });

  it("points INDEX, architecture, CLI, env, SDK, and TUI notes at the same contract", async () => {
    const [index, architecture, cli, env, sdk, tui] = await Promise.all([
      readFile("../docs/INDEX.md", "utf8"),
      readFile("../docs/ARCHITECTURE.md", "utf8"),
      readFile("../docs/reference/cli.md", "utf8"),
      readFile("../docs/reference/env.md", "utf8"),
      readFile("../docs/sdk.md", "utf8"),
      readFile("src/tui/README.md", "utf8"),
    ]);

    expect(index).toContain("daemon.md#recovery-after-a-disappeared-daemon");
    expect(architecture).toContain(
      "reference/daemon.md#recovery-after-a-disappeared-daemon",
    );
    expect(cli).toContain("daemon.md#recovery-after-a-disappeared-daemon");
    expect(env).toContain("daemon.md#recovery-after-a-disappeared-daemon");
    expect(sdk).toContain("daemon.md#recovery-after-a-disappeared-daemon");
    expect(tui).toContain(
      "docs/reference/daemon.md#recovery-after-a-disappeared-daemon",
    );
    expect(tui).toContain("AGENC_DAEMON_LOST_TURN_PROBE_MS");
  });
});
