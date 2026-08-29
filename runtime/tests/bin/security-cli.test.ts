// `agenc security audit` (TODO task 3): parse matrix, seeded
// misconfigurations, --fix remediation, exit codes.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  buildSecurityAuditReport,
  formatAgenCSecurityCliHelpText,
  formatSecurityAuditSummaryLine,
  formatSecurityAuditText,
  parseAgenCSecurityCliArgs,
  runAgenCSecurityCli,
  securityAuditExitCode,
} from "../../src/bin/security-cli.js";
import { resolveHomeContext } from "../../src/config/home.js";
import { serializeConfigToml } from "../../src/config/serialize.js";
import { resolveGatewayGeneratedToken } from "../../src/gateway/credentials.js";

describe("parseAgenCSecurityCliArgs", () => {
  test("returns null for non-security argv", () => {
    expect(parseAgenCSecurityCliArgs([])).toBeNull();
    expect(parseAgenCSecurityCliArgs(["doctor"])).toBeNull();
  });

  test("bare security shows help; audit parses with flags", () => {
    expect(parseAgenCSecurityCliArgs(["security"])).toEqual({
      kind: "help",
      text: formatAgenCSecurityCliHelpText(),
    });
    expect(parseAgenCSecurityCliArgs(["security", "audit"])).toEqual({
      kind: "audit",
      json: false,
      fix: false,
    });
    expect(
      parseAgenCSecurityCliArgs(["security", "audit", "--json", "--fix"]),
    ).toEqual({ kind: "audit", json: true, fix: true });
  });

  test("unknown subcommand/flag is an error", () => {
    expect(parseAgenCSecurityCliArgs(["security", "harden"])).toMatchObject({
      kind: "error",
    });
    expect(
      parseAgenCSecurityCliArgs(["security", "audit", "--force"]),
    ).toMatchObject({ kind: "error" });
  });
});

describe("security audit against a temp home", () => {
  let home: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-security-audit-"));
    chmodSync(home, 0o700);
    env = { AGENC_HOME: home, HOME: home };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeGatewayConfig(gateway: Readonly<Record<string, unknown>>): void {
    writeFileSync(join(home, "config.toml"), serializeConfigToml({
      config_version: 2,
      gateway,
    }), { mode: 0o600 });
  }

  test("clean home: all ok, exit 0", async () => {
    const report = await buildSecurityAuditReport({ env });
    expect(report.criticalCount).toBe(0);
    expect(report.warnCount).toBe(0);
    expect(securityAuditExitCode(report)).toBe(0);
    expect(formatSecurityAuditText(report)).toContain("All checks passed.");
    expect(formatSecurityAuditSummaryLine(report)).toBe(
      "security audit: all checks passed",
    );
  });

  test("world-accessible home is critical; --fix chmods to 700", async () => {
    chmodSync(home, 0o755);
    const before = await buildSecurityAuditReport({ env });
    expect(
      before.findings.find((f) => f.id === "home-dir-perms")?.severity,
    ).toBe("critical");
    expect(securityAuditExitCode(before)).toBe(1);
    expect(formatSecurityAuditSummaryLine(before)).toContain("CRITICAL");

    const fixed = await buildSecurityAuditReport({ env, applyFixes: true });
    const finding = fixed.findings.find((f) => f.id === "home-dir-perms");
    expect(finding?.fixed).toBe(true);
    expect(securityAuditExitCode(fixed)).toBe(0);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test("group/world-readable auth.json is critical; --fix chmods to 600", async () => {
    writeFileSync(join(home, "auth.json"), "{}");
    chmodSync(join(home, "auth.json"), 0o644);
    const before = await buildSecurityAuditReport({ env });
    expect(
      before.findings.find((f) => f.id === "sensitive-file-perms:auth.json")
        ?.severity,
    ).toBe("critical");
    expect(securityAuditExitCode(before)).toBe(1);

    const fixed = await buildSecurityAuditReport({ env, applyFixes: true });
    expect(
      fixed.findings.find((f) => f.id === "sensitive-file-perms:auth.json")
        ?.fixed,
    ).toBe(true);
    expect(securityAuditExitCode(fixed)).toBe(0);
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  });

  test("exposed credentials dir and vault files are caught", async () => {
    mkdirSync(join(home, "credentials"));
    chmodSync(join(home, "credentials"), 0o755);
    writeFileSync(join(home, "wallet.vault.json"), "{}");
    chmodSync(join(home, "wallet.vault.json"), 0o604);
    const report = await buildSecurityAuditReport({ env });
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain("sensitive-file-perms:credentials");
    expect(ids).toContain("sensitive-file-perms:wallet.vault.json");
    expect(report.criticalCount).toBe(2);

    const fixed = await buildSecurityAuditReport({ env, applyFixes: true });
    expect(fixed.criticalCount).toBe(0);
    expect(statSync(join(home, "credentials")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "wallet.vault.json")).mode & 0o777).toBe(0o600);
  });

  test("non-loopback daemon override is critical and NOT fixable by --fix", async () => {
    const report = await buildSecurityAuditReport({
      env: { ...env, AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK: "1" },
      applyFixes: true,
    });
    const finding = report.findings.find((f) => f.id === "daemon-ws-exposure");
    expect(finding?.severity).toBe("critical");
    expect(finding?.fixable).toBe(false);
    expect(finding?.fixed).toBeUndefined();
    expect(securityAuditExitCode(report)).toBe(1);
  });

  test("non-loopback host env without the override is still flagged", async () => {
    const report = await buildSecurityAuditReport({
      env: { ...env, AGENC_DAEMON_WEBSOCKET_HOST: "0.0.0.0" },
    });
    expect(
      report.findings.find((f) => f.id === "daemon-ws-exposure")?.severity,
    ).toBe("critical");
  });

  test("never-ask default approval policy is a warning, not critical", async () => {
    writeFileSync(
      join(home, "config.toml"),
      'config_version = 2\napproval_policy = "never"\n',
      { mode: 0o600 },
    );
    const report = await buildSecurityAuditReport({ env });
    const finding = report.findings.find(
      (f) => f.id === "default-permission-mode",
    );
    expect(finding?.severity).toBe("warn");
    expect(securityAuditExitCode(report)).toBe(0);
    expect(formatSecurityAuditSummaryLine(report)).toContain("warning");
  });

  test("unparseable config.toml surfaces as a warning", async () => {
    writeFileSync(join(home, "config.toml"), "not [ valid toml ===", {
      mode: 0o600,
    });
    const report = await buildSecurityAuditReport({ env });
    expect(
      report.findings.find((f) => f.id === "config-integrity")?.severity,
    ).toBe("warn");
  });

  test("security audit reports the retired hooks-token alias rejection", async () => {
    const report = await buildSecurityAuditReport({
      env: { ...env, AGENC_GATEWAY_HOOKS_TOKEN: "retired-hooks-secret" },
    });
    const finding = report.findings.find((f) => f.id === "config-integrity");
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toMatch(
      /obsolete configuration environment variable.*AGENC_GATEWAY_HOOKS_TOKEN.*AGENC_HOOKS_TOKEN/u,
    );
  });

  test("group-readable retired gateway secret inputs are critical; --fix chmods", async () => {
    mkdirSync(join(home, "gateway"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "gateway", "env"), "AGENC_TELEGRAM_BOT_TOKEN=x");
    chmodSync(join(home, "gateway", "env"), 0o644);
    const before = await buildSecurityAuditReport({ env });
    expect(
      before.findings.find((f) => f.id === "sensitive-file-perms:gateway/env")
        ?.severity,
    ).toBe("critical");
    const fixed = await buildSecurityAuditReport({ env, applyFixes: true });
    expect(
      fixed.findings.find((f) => f.id === "sensitive-file-perms:gateway/env")
        ?.fixed,
    ).toBe(true);
    expect(statSync(join(home, "gateway", "env")).mode & 0o777).toBe(0o600);
  });

  test("hooks enabled WITHOUT a token is critical (task 17 acceptance)", async () => {
    writeGatewayConfig({ hooks: { enabled: true } });
    const report = await buildSecurityAuditReport({ env });
    const finding = report.findings.find((f) => f.id === "hooks-exposure");
    expect(finding?.severity).toBe("critical");
    expect(finding?.title).toContain("without a bearer token");
    expect(securityAuditExitCode(report)).toBe(1);
  });

  test("hooks enabled WITH a native secure storage token is ok", async () => {
    writeGatewayConfig({ hooks: { enabled: true } });
    resolveGatewayGeneratedToken(
      resolveHomeContext({ AGENC_HOME: home }),
      "hooks",
      undefined,
    );
    const report = await buildSecurityAuditReport({ env });
    expect(
      report.findings.find((f) => f.id === "hooks-exposure")?.severity,
    ).toBe("ok");
  });

  test.each([
    ["local", { USER_TYPE: "ant", USE_LOCAL_OAUTH: "1" }],
    ["custom", { AGENC_CUSTOM_OAUTH_URL: "https://agenc.tech" }],
  ] as const)(
    "audits the %s OAuth native secure storage namespace from the captured environment",
    async (_label, oauthEnvironment) => {
      writeGatewayConfig({ hooks: { enabled: true } });
      const capturedEnvironment = Object.freeze({
        ...env,
        HOME: tmpdir(),
        ...oauthEnvironment,
      });
      resolveGatewayGeneratedToken(
        resolveHomeContext(capturedEnvironment, {
          platformHome: capturedEnvironment.HOME,
        }),
        "hooks",
        undefined,
      );

      const report = await buildSecurityAuditReport({
        env: capturedEnvironment,
      });
      expect(
        report.findings.find((finding) => finding.id === "hooks-exposure")
          ?.severity,
      ).toBe("ok");
    },
  );

  test("hooks bound non-loopback is critical even with a token", async () => {
    writeGatewayConfig({ hooks: { enabled: true, host: "0.0.0.0" } });
    resolveGatewayGeneratedToken(
      resolveHomeContext({ AGENC_HOME: home }),
      "hooks",
      undefined,
    );
    const report = await buildSecurityAuditReport({ env });
    expect(
      report.findings.find((f) => f.id === "hooks-exposure:bind")?.severity,
    ).toBe("critical");
  });

  test("hooks disabled (or absent) is ok", async () => {
    const report = await buildSecurityAuditReport({ env });
    expect(
      report.findings.find((f) => f.id === "hooks-exposure")?.severity,
    ).toBe("ok");
  });

  test("runner: audit prints text and returns the exit code", async () => {
    chmodSync(home, 0o755);
    const out: string[] = [];
    const code = await runAgenCSecurityCli(
      { kind: "audit", json: false, fix: false },
      { env, stdout: (line) => out.push(line) },
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("group/world accessible");

    const fixedCode = await runAgenCSecurityCli(
      { kind: "audit", json: true, fix: true },
      { env, stdout: (line) => out.push(line) },
    );
    expect(fixedCode).toBe(0);
  });
});
