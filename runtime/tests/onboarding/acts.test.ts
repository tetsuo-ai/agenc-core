/**
 * Onboarding acts (onboarding-plan-2026-07 O-2/O-3/O-5/O-6): identity
 * scaffold + naming ritual gate, channel wizard with live-validated tokens
 * and the pairing walkthrough, guardrails-before-autonomy ordering, posture
 * recap, and the gateway env-file — all through scripted IO seams.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createScriptedActIO } from "../../src/onboarding/acts/io.js";
import { runIdentityAct } from "../../src/onboarding/acts/identity.js";
import { runChannelAct } from "../../src/onboarding/acts/channel.js";
import {
  appendTomlSectionIfAbsent,
  enableHooksInGatewayConfig,
  runAutonomyAct,
} from "../../src/onboarding/acts/autonomy.js";
import {
  buildOnboardingSurfaceSummary,
  runRecap,
} from "../../src/onboarding/acts/recap.js";
import {
  markOnboardingActComplete,
  readOnboardingActs,
} from "../../src/onboarding/acts/state.js";
import {
  mergeGatewayEnv,
  readGatewayEnvFile,
  writeGatewayEnvEntries,
} from "../../src/gateway/env-file.js";
import {
  parseAgenCOnboardCliArgs,
  buildOnboardStatusReport,
  formatOnboardStatusText,
} from "../../src/bin/onboard-cli.js";

let home: string;
let ws: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-acts-"));
  chmodSync(home, 0o700);
  ws = join(home, "agent-ws");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ENV = () => ({ AGENC_HOME: home, HOME: home });

describe("identity act (O-2)", () => {
  test("scaffolds SOUL/USER/BOOTSTRAP, trusts the workspace, runs the ritual", async () => {
    const { io } = createScriptedActIO([
      ws, // workspace
      "direct", // tone
      "concise", // verbosity
      "Tetsuo", // name
      "ships fast", // context
      "y", // run ritual
    ]);
    const ritual = vi.fn(async (workspace: string) => {
      // Simulate the agent completing the ritual.
      writeFileSync(join(workspace, "IDENTITY.md"), "Your name is Koi.");
      rmSync(join(workspace, "BOOTSTRAP.md"));
      return { ok: true, output: "I am Koi." };
    });
    const code = await runIdentityAct({
      agencHome: home,
      io,
      env: ENV(),
      runRitualTurn: ritual,
    });

    expect(code).toBe(0);
    expect(readFileSync(join(ws, "SOUL.md"), "utf8")).toContain("direct");
    expect(readFileSync(join(ws, "USER.md"), "utf8")).toContain("Tetsuo");
    expect(existsSync(join(ws, "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(ws, "BOOTSTRAP.md"))).toBe(false);
    expect(ritual).toHaveBeenCalledOnce();
    // Workspace trusted so first sessions skip the trust prompt.
    const trusted = JSON.parse(
      readFileSync(join(home, "trusted-projects.json"), "utf8"),
    ) as { trustedProjects: { path: string }[] };
    expect(trusted.trustedProjects.some((p) => p.path.includes("agent-ws"))).toBe(
      true,
    );
    // Funnel state recorded locally.
    expect(readOnboardingActs(home).acts.identity?.detail?.workspace).toBe(ws);
  });

  test("never clobbers existing persona files; existing IDENTITY skips the ritual", async () => {
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "SOUL.md"), "hand-written soul");
    writeFileSync(join(ws, "USER.md"), "hand-written user");
    writeFileSync(join(ws, "IDENTITY.md"), "Your name is Hikari.");
    const ritual = vi.fn();
    const { io, output } = createScriptedActIO([ws]);
    const code = await runIdentityAct({
      agencHome: home,
      io,
      env: ENV(),
      runRitualTurn: ritual as never,
    });

    expect(code).toBe(0);
    expect(readFileSync(join(ws, "SOUL.md"), "utf8")).toBe("hand-written soul");
    expect(readFileSync(join(ws, "USER.md"), "utf8")).toBe("hand-written user");
    expect(ritual).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("already has an identity");
  });
});

describe("gateway env file", () => {
  test("round-trips entries at 0600 and merges UNDER the real env", () => {
    writeGatewayEnvEntries(home, { AGENC_TELEGRAM_BOT_TOKEN: "tok-123" });
    expect(statSync(join(home, "gateway", "env")).mode & 0o777).toBe(0o600);
    expect(readGatewayEnvFile(home).AGENC_TELEGRAM_BOT_TOKEN).toBe("tok-123");
    // Explicit env always wins.
    const merged = mergeGatewayEnv(home, {
      AGENC_TELEGRAM_BOT_TOKEN: "explicit",
    });
    expect(merged.AGENC_TELEGRAM_BOT_TOKEN).toBe("explicit");
    // Second write merges, not replaces.
    writeGatewayEnvEntries(home, { AGENC_DISCORD_BOT_TOKEN: "d-1" });
    expect(readGatewayEnvFile(home)).toMatchObject({
      AGENC_TELEGRAM_BOT_TOKEN: "tok-123",
      AGENC_DISCORD_BOT_TOKEN: "d-1",
    });
  });
});

describe("channel act (O-3)", () => {
  const validators = {
    telegram: vi.fn(async (token: string) =>
      token === "good-token"
        ? { ok: true, detail: "@testbot" }
        : { ok: false, detail: "401" },
    ),
    discord: vi.fn(async () => ({ ok: true })),
    slack: vi.fn(async () => ({ ok: true, detail: "bot user U1" })),
  };

  test("telegram: validates live (retry on bad token), stores 0600, runs the pairing walkthrough", async () => {
    const stopped = vi.fn();
    const startGatewayFn = vi.fn(async () => {
      // The 'user pairs from their phone': the gateway would write this.
      mkdirSync(join(home, "gateway"), { recursive: true });
      writeFileSync(
        join(home, "gateway", "pairing.json"),
        JSON.stringify({ version: 1, paired: { telegram: ["42"] } }),
      );
      return {
        gateway: {} as never,
        channels: ["telegram"],
        stop: stopped,
      };
    });
    const { io, output } = createScriptedActIO([
      "telegram", // surface
      "bad-token", // first attempt fails validation
      "y", // try again
      "good-token", // verified
      "y", // start the live smoke
      "y", // did the agent reply?
    ]);
    const code = await runChannelAct({
      agencHome: home,
      io,
      env: ENV(),
      validators,
      startGatewayFn: startGatewayFn as never,
      pairingPollIntervalMs: 5,
      pairingTimeoutMs: 2000,
    });

    expect(code).toBe(0);
    expect(validators.telegram).toHaveBeenCalledTimes(2);
    expect(readGatewayEnvFile(home).AGENC_TELEGRAM_BOT_TOKEN).toBe("good-token");
    expect(statSync(join(home, "gateway", "env")).mode & 0o777).toBe(0o600);
    // The gateway env file rode into the smoke run.
    const startEnv = (startGatewayFn.mock.calls[0][0] as { env: Record<string, string> })
      .env;
    expect(startEnv.AGENC_TELEGRAM_BOT_TOKEN).toBe("good-token");
    expect(stopped).toHaveBeenCalled();
    expect(output.join("\n")).toContain("Paired: 42");
    expect(readOnboardingActs(home).acts.channel?.detail?.channel).toBe(
      "telegram",
    );
  });

  test("webchat needs no token and surfaces the operator URL", async () => {
    const startGatewayFn = vi.fn(async () => ({
      gateway: {} as never,
      channels: ["webchat"],
      webchatUrl: "http://127.0.0.1:9999/?token=abc",
      stop: vi.fn(),
    }));
    const { io, output } = createScriptedActIO([
      "webchat",
      "y", // start smoke
      "y", // replied
    ]);
    const code = await runChannelAct({
      agencHome: home,
      io,
      env: ENV(),
      validators,
      startGatewayFn: startGatewayFn as never,
    });
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("http://127.0.0.1:9999/?token=abc");
    expect(existsSync(join(home, "gateway", "env"))).toBe(false);
  });
});

describe("autonomy act (O-5): guardrails before autonomy", () => {
  test("sets the budget cap, then heartbeat/cron/hooks configure", async () => {
    mkdirSync(ws, { recursive: true });
    markOnboardingActComplete(home, "identity", { workspace: ws });
    const { io, output } = createScriptedActIO([
      "2.5", // daily cap
      "y", // enable heartbeat
      ws, // workspace
      "", // deliver channel (none)
      "y", // add cron job
      ws, // workspace
      "0 9 * * *",
      "morning briefing please",
      "", // no channel
      "y", // enable hooks
    ]);
    const code = await runAutonomyAct({
      agencHome: home,
      io,
      env: ENV(),
      now: () => Date.parse("2026-07-09T10:00:00Z"),
    });

    expect(code).toBe(0);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).toContain("[budget]");
    expect(toml).toContain("daily_usd = 2.5");
    expect(toml).toContain("[heartbeat]");
    expect(readFileSync(join(ws, "HEARTBEAT.md"), "utf8")).toContain(
      "HEARTBEAT_OK",
    );
    const tasks = JSON.parse(
      readFileSync(join(ws, ".agenc", "scheduled_tasks.json"), "utf8"),
    ) as { tasks: { cron: string; prompt: string }[] };
    expect(tasks.tasks[0]).toMatchObject({
      cron: "0 9 * * *",
      prompt: "morning briefing please",
    });
    const gatewayConfig = JSON.parse(
      readFileSync(join(home, "gateway", "config.json"), "utf8"),
    ) as { hooks?: { enabled?: boolean } };
    expect(gatewayConfig.hooks?.enabled).toBe(true);
    // The hooks token was minted for the curl example.
    expect(existsSync(join(home, "gateway", "hooks-token"))).toBe(true);
    expect(output.join("\n")).toContain("curl -s -X POST");
  });

  test("REFUSES heartbeat/cron/hooks without a cap unless capless is explicit", async () => {
    const { io, output } = createScriptedActIO([
      "none", // no cap...
      "", // ...confirm capless? default N → back to the top
      "3", // ok, set a cap after all
      "", // heartbeat? default N
      "", // cron? default N
      "", // hooks? default N
    ]);
    const code = await runAutonomyAct({ agencHome: home, io, env: ENV() });
    expect(code).toBe(0);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
      "daily_usd = 3",
    );
    expect(output.join("\n")).toContain("without limit");
  });

  test("appendTomlSectionIfAbsent never rewrites an existing section", () => {
    writeFileSync(join(home, "config.toml"), "[budget]\ndaily_usd = 99\n");
    const wrote = appendTomlSectionIfAbsent(home, "budget", ["daily_usd = 1"]);
    expect(wrote).toBe(false);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("99");
  });

  test("enableHooksInGatewayConfig preserves unrelated keys", () => {
    mkdirSync(join(home, "gateway"), { recursive: true });
    writeFileSync(
      join(home, "gateway", "config.json"),
      JSON.stringify({ channels: { telegram: { dmPolicy: "pairing", allowlist: [] } } }),
    );
    enableHooksInGatewayConfig(home);
    const config = JSON.parse(
      readFileSync(join(home, "gateway", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config.channels).toBeDefined();
    expect((config.hooks as { enabled: boolean }).enabled).toBe(true);
  });
});

describe("recap (O-6) + status funnel", () => {
  test("summarizes surfaces and renders the posture card", async () => {
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "SOUL.md"), "s");
    writeFileSync(join(ws, "IDENTITY.md"), "i");
    markOnboardingActComplete(home, "identity", { workspace: ws });
    writeGatewayEnvEntries(home, { AGENC_TELEGRAM_BOT_TOKEN: "t" });
    enableHooksInGatewayConfig(home);

    const summary = await buildOnboardingSurfaceSummary(home, ENV());
    expect(summary.personaFiles).toEqual(["SOUL.md", "IDENTITY.md"]);
    expect(summary.channels).toEqual(["telegram"]);
    expect(summary.hooksEnabled).toBe(true);

    const { io, output } = createScriptedActIO([]);
    const code = await runRecap({
      agencHome: home,
      io,
      env: ENV(),
      buildAuditReport: async () =>
        ({ findings: [], criticalCount: 0, warnCount: 0 }) as never,
    });
    expect(code).toBe(0);
    const text = output.join("\n");
    expect(text).toContain("telegram (pairing-gated)");
    expect(text).toContain("Things to try:");
  });

  test("onboard CLI parses acts and --status reports the funnel", async () => {
    expect(parseAgenCOnboardCliArgs(["onboard", "identity"])).toEqual({
      kind: "act",
      act: "identity",
    });
    expect(parseAgenCOnboardCliArgs(["onboard", "channel"])).toEqual({
      kind: "act",
      act: "channel",
    });
    expect(parseAgenCOnboardCliArgs(["onboard", "autonomy", "extra"])).toMatchObject(
      { kind: "error" },
    );

    markOnboardingActComplete(home, "identity", { workspace: ws });
    const report = await buildOnboardStatusReport({ env: ENV() });
    expect(report.acts.identity?.detail?.workspace).toBe(ws);
    const text = formatOnboardStatusText(report);
    expect(text).toContain("Identity:  done");
    expect(text).toContain("Channel:   not yet");
  });
});

describe("gateway install-service (O-4)", () => {
  test("linux: writes the systemd user unit with EnvironmentFile and enables it", async () => {
    const { installGatewayService } = await import("../../src/bin/gateway-cli.js");
    const out: string[] = [];
    const commands: string[][] = [];
    const code = await installGatewayService({
      agencHome: home,
      stdout: (l) => out.push(l),
      stderr: (l) => out.push(l),
      platform: "linux",
      home,
      execPath: "/usr/bin/node",
      entryPath: "/opt/agenc/bin/agenc.js",
      runCommand: (cmd, args) => {
        commands.push([cmd, ...args]);
        return true;
      },
    });
    expect(code).toBe(0);
    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "agenc-gateway.service"),
      "utf8",
    );
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/agenc/bin/agenc.js gateway run");
    expect(unit).toContain(`EnvironmentFile=-${join(home, "gateway", "env")}`);
    expect(commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "agenc-gateway"],
    ]);
  });

  test("darwin writes a launchd plist; other platforms explain themselves", async () => {
    const { installGatewayService } = await import("../../src/bin/gateway-cli.js");
    const out: string[] = [];
    const code = await installGatewayService({
      agencHome: home,
      stdout: (l) => out.push(l),
      stderr: (l) => out.push(l),
      platform: "darwin",
      home,
      execPath: "/usr/bin/node",
      entryPath: "/opt/agenc/bin/agenc.js",
      runCommand: () => true,
    });
    expect(code).toBe(0);
    const plist = readFileSync(
      join(home, "Library", "LaunchAgents", "dev.agenc.gateway.plist"),
      "utf8",
    );
    expect(plist).toContain("<string>gateway</string>");

    const other = await installGatewayService({
      agencHome: home,
      stdout: (l) => out.push(l),
      stderr: (l) => out.push(l),
      platform: "win32",
      home,
      runCommand: () => true,
    });
    expect(other).toBe(1);
    expect(out.join("\n")).toContain("agenc gateway run");
  });
});

describe("terminal ActIO", () => {
  test("piped stdin answers survive across MULTIPLE questions (single readline)", async () => {
    const { PassThrough } = await import("node:stream");
    const { createTerminalActIO } = await import(
      "../../src/onboarding/acts/io.js"
    );
    const input = new PassThrough();
    const output = new PassThrough();
    const io = createTerminalActIO(input, output);
    // All answers arrive in ONE buffered write — the per-question-interface
    // bug swallowed everything after the first line.
    input.write("first\nsecond\n2\n");
    input.end();
    expect(await io.ask("q1")).toBe("first");
    expect(await io.ask("q2")).toBe("second");
    expect(
      await io.select("pick", [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ]),
    ).toBe("b");
    io.close();
  });
});
