import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  parseAgenCDaemonCliArgs,
  runAgenCDaemonCli,
} from "../../src/app-server/daemon-cli.js";
import {
  AGENC_DAEMON_WINSW_VERSION,
  installAgencDaemonWinSWService,
  parseAgencDaemonWinSWServiceXml,
  renderAgencDaemonWinSWService,
  resolveWindowsCmdExe,
  resolveWindowsServiceAccount,
  writeAgencDaemonWinSWServiceXml,
} from "../../src/packaging/windows-winsw-service.js";
import { renderGeneratedWrapperContent } from "../../src/utils/generated-wrapper.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INSTALL_PS1 = join(REPO_ROOT, "scripts", "install", "install.ps1");

const CMD_EXE = "C:\\Windows\\System32\\cmd.exe";
const LAUNCHER = "C:\\Users\\Ada\\AppData\\Local\\agenc\\bin\\agenc.cmd";
const HOME = "C:\\Users\\Ada\\.agenc";
const ACCOUNT = "ADA-PC\\Ada";

function renderDefault(
  overrides: Partial<Parameters<typeof renderAgencDaemonWinSWService>[0]> = {},
) {
  return renderAgencDaemonWinSWService({
    commandPrompt: CMD_EXE,
    launcher: LAUNCHER,
    agencHome: HOME,
    accountUsername: ACCOUNT,
    ...overrides,
  });
}

describe("WinSW daemon service definition", () => {
  test("uses absolute cmd.exe and the installed agenc.cmd, not a bare agenc", () => {
    const definition = renderDefault();
    const parsed = parseAgencDaemonWinSWServiceXml(definition.xml);

    expect(parsed.executable).toBe(CMD_EXE);
    expect(win32.isAbsolute(parsed.executable)).toBe(true);
    expect(parsed.executable.toLowerCase()).toMatch(/cmd\.exe$/u);
    expect(parsed.arguments).toContain(LAUNCHER);
    expect(parsed.arguments).toContain("daemon start --foreground");
    expect(parsed.xml).not.toContain("<executable>agenc</executable>");
    expect(parsed.xml).not.toMatch(/<executable>\s*agenc\s*<\/executable>/u);
  });

  test("emits the exact WinSW 2.12.0 service definition", () => {
    const definition = renderDefault();
    expect(AGENC_DAEMON_WINSW_VERSION).toBe("2.12.0");
    expect(definition.xml).toBe([
      "<service>",
      "  <id>agenc-daemon</id>",
      "  <name>AgenC Daemon</name>",
      "  <description>Runs the local AgenC daemon control plane for the installing user's AGENC_HOME.</description>",
      "  <executable>C:\\Windows\\System32\\cmd.exe</executable>",
      "  <arguments>/d /v:off /s /c &quot;&quot;C:\\Users\\Ada\\AppData\\Local\\agenc\\bin\\agenc.cmd&quot; daemon start --foreground&quot;</arguments>",
      "  <workingdirectory>C:\\Users\\Ada\\.agenc</workingdirectory>",
      "  <env name=\"AGENC_HOME\" value=\"C:\\Users\\Ada\\.agenc\"/>",
      "  <env name=\"NODE_ENV\" value=\"production\"/>",
      "  <serviceaccount>",
      "    <domain>ADA-PC</domain>",
      "    <user>Ada</user>",
      "    <allowservicelogon>true</allowservicelogon>",
      "  </serviceaccount>",
      "  <startmode>Automatic</startmode>",
      "  <onfailure action=\"restart\" delay=\"5 sec\"/>",
      "  <log mode=\"roll-by-size\">",
      "    <sizeThreshold>10485760</sizeThreshold>",
      "    <keepFiles>5</keepFiles>",
      "  </log>",
      "</service>",
      "",
    ].join("\n"));
    expect(definition.xml).not.toContain("<username>");
    expect(definition.xml).not.toContain("<password>");
    const parsed = parseAgencDaemonWinSWServiceXml(definition.xml);
    expect(parsed.accountUsername).toBe(ACCOUNT);
    expect(parsed.agencHome).toBe(HOME);
    expect(parsed.workingDirectory).toBe(HOME);
    expect(parsed.allowServiceLogon).toBe(true);
  });

  test("escapes spaces and XML-sensitive characters in paths and account", () => {
    const launcher =
      "C:\\Users\\Ada O'Neil\\AppData\\Local\\agenc & tools\\bin\\agenc.cmd";
    const agencHome = "C:\\Users\\Ada O'Neil\\.agenc & home";
    const account = "ADA-PC\\Ada O'Neil";
    const parsed = parseAgencDaemonWinSWServiceXml(
      renderDefault({ launcher, agencHome, accountUsername: account }).xml,
    );

    expect(parsed.launcher).toBe(launcher);
    expect(parsed.agencHome).toBe(agencHome);
    expect(parsed.accountUsername).toBe(account);
    expect(parsed.workingDirectory).toBe(agencHome);
    expect(parsed.xml).toContain("agenc &amp; tools");
    expect(parsed.xml).toContain(".agenc &amp; home");
    expect(parsed.xml).toContain("Ada O&apos;Neil");
    expect(parsed.xml).not.toContain("agenc & tools");
    expect(parsed.xml).not.toContain(".agenc & home");
  });

  test("does not depend on PATH or PATHEXT and disables cmd AutoRun", () => {
    const parsed = parseAgencDaemonWinSWServiceXml(renderDefault().xml);
    expect(parsed.arguments).toMatch(/^\/d \/v:off \/s \/c /u);
    expect(parsed.executable).toBe(CMD_EXE);
  });

  test("rejects a bare executable, relative paths, and LocalSystem", () => {
    expect(() =>
      renderDefault({ commandPrompt: "agenc" }),
    ).toThrow(/absolute/i);
    expect(() =>
      renderDefault({ launcher: "agenc.cmd" }),
    ).toThrow(/absolute/i);
    expect(() =>
      renderDefault({ agencHome: ".agenc" }),
    ).toThrow(/absolute/i);
    expect(() =>
      renderDefault({ accountUsername: "LocalSystem" }),
    ).toThrow(/LocalSystem|installing user/i);
    expect(() =>
      renderDefault({ accountUsername: "NT AUTHORITY\\SYSTEM" }),
    ).toThrow(/LocalSystem|installing user/i);
    expect(() => renderDefault({ accountUsername: "" })).toThrow(/LocalSystem/i);
    expect(() => renderDefault({ accountUsername: "Ada" })).toThrow(/DOMAIN\\user/i);
  });

  test("resolves cmd.exe from SystemRoot and the installing-user account", () => {
    expect(
      resolveWindowsCmdExe({ SystemRoot: "D:\\Windows" }),
    ).toBe("D:\\Windows\\System32\\cmd.exe");
    expect(resolveWindowsCmdExe({})).toBe(CMD_EXE);
    expect(
      resolveWindowsServiceAccount({
        USERDOMAIN: "ADA-PC",
        USERNAME: "Ada",
      }),
    ).toBe("ADA-PC\\Ada");
    expect(resolveWindowsServiceAccount({ USERNAME: "Ada" })).toBe(".\\Ada");
    expect(() =>
      resolveWindowsServiceAccount({
        USERDOMAIN: "NT AUTHORITY",
        USERNAME: "SYSTEM",
      }),
    ).toThrow(/LocalSystem|installing user/i);
  });
});

describe("writeAgencDaemonWinSWServiceXml", () => {
  let work: string | undefined;
  afterEach(() => {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  });

  test("writes a machine-checkable service definition to disk", () => {
    work = mkdtempSync(join(tmpdir(), "agenc-winsw-"));
    const outputPath = join(work, "agenc-daemon.xml");
    const definition = writeAgencDaemonWinSWServiceXml({
      commandPrompt: CMD_EXE,
      launcher: LAUNCHER,
      agencHome: HOME,
      accountUsername: ACCOUNT,
      outputPath,
    });
    const onDisk = readFileSync(outputPath, "utf8");
    expect(onDisk).toBe(definition.xml);
    const parsed = parseAgencDaemonWinSWServiceXml(onDisk);
    expect(parsed.executable).toBe(CMD_EXE);
    expect(parsed.launcher).toBe(LAUNCHER);
    expect(parsed.agencHome).toBe(HOME);
    expect(parsed.accountUsername).toBe(ACCOUNT);
    writeFileSync(join(work, "empty"), "");
    expect(readFileSync(outputPath, "utf8")).toContain("<env");
  });
});

describe("installer and CLI WinSW generation", () => {
  let work: string | undefined;
  afterEach(() => {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  });

  test("install.ps1 embedded renderer matches the TypeScript generator", () => {
    const ps1 = readFileSync(INSTALL_PS1, "utf8");
    const begin = ps1.indexOf("$RenderWinSW = @'\n");
    const end = ps1.indexOf("\n'@\n", begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const script = ps1.slice(begin + "$RenderWinSW = @'\n".length, end);
    work = mkdtempSync(join(tmpdir(), "agenc-winsw-ps1-"));
    const outputPath = join(work, "agenc-daemon.xml");
    const launcher =
      "C:\\Users\\Ada O'Neil\\AppData\\Local\\agenc & tools\\bin\\agenc.cmd";
    const agencHome = "C:\\Users\\Ada O'Neil\\.agenc & home";
    const account = "ADA-PC\\Ada O'Neil";
    const result = spawnSync(
      process.execPath,
      ["-e", script, CMD_EXE, launcher, agencHome, account, outputPath],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(
      renderDefault({
        launcher,
        agencHome,
        accountUsername: account,
      }).xml,
    );
  });

  test("agenc daemon install-service writes XML and documents the separate WinSW step", async () => {
    work = mkdtempSync(join(tmpdir(), "agenc-winsw-cli-"));
    const outputPath = join(work, "agenc-daemon.xml");
    const lines: string[] = [];
    expect(parseAgenCDaemonCliArgs(["daemon", "install-service"])).toEqual({
      kind: "install-service",
    });
    const code = installAgencDaemonWinSWService({
      env: {
        SystemRoot: "C:\\Windows",
        AGENC_INSTALL_PREFIX: "C:\\Users\\Ada\\AppData\\Local\\agenc",
        USERDOMAIN: "ADA-PC",
        USERNAME: "Ada",
        AGENC_WINSW_XML: outputPath,
      },
      agencHome: HOME,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const parsed = parseAgencDaemonWinSWServiceXml(readFileSync(outputPath, "utf8"));
    expect(parsed.executable).toBe(CMD_EXE);
    expect(parsed.launcher).toBe(LAUNCHER);
    expect(parsed.agencHome).toBe(HOME);
    expect(parsed.accountUsername).toBe(ACCOUNT);
    expect(lines.join("\n")).toContain("does not install or start a Windows service");
    expect(lines.join("\n")).toContain("Pinned WinSW version: 2.12.0");
    expect(lines.join("\n")).toContain('agenc-daemon.exe" install /p');
    expect(lines.join("\n")).toContain('agenc-daemon.exe" start');
    expect(lines.join("\n")).toContain('agenc-daemon.exe" stop');
    expect(lines.join("\n")).toContain('agenc-daemon.exe" restart');
    expect(readFileSync(outputPath, "utf8")).not.toContain("<password>");
    expect(readFileSync(outputPath, "utf8")).not.toContain("<username>");

    const stdout: string[] = [];
    const exit = await runAgenCDaemonCli(
      { kind: "install-service" },
      {
        io: {
          stdout: { write: (chunk: string) => stdout.push(chunk) && true },
          stderr: { write: () => true },
        },
        host: {
          env: {
            AGENC_HOME: work,
            SystemRoot: "C:\\Windows",
            AGENC_INSTALL_PREFIX: "C:\\Users\\Ada\\AppData\\Local\\agenc",
            USERDOMAIN: "ADA-PC",
            USERNAME: "Ada",
            AGENC_WINSW_XML: join(work, "from-cli.xml"),
          },
          userHome: work,
          entrypointPath: LAUNCHER,
          execPath: "C:\\Users\\Ada\\.agenc\\runtime\\node.exe",
          pid: 4100,
          spawnDetachedDaemon: () => 4200,
          isPidRunning: () => false,
          terminatePid: () => {},
          sleep: async () => {},
        },
      },
    );
    expect(exit).toBe(0);
    expect(readFileSync(join(work, "from-cli.xml"), "utf8")).toContain(
      "<id>agenc-daemon</id>",
    );
  });

  test("install-service uses the shim prefix and refuses a LOCALAPPDATA guess", () => {
    work = mkdtempSync(join(tmpdir(), "agenc-winsw-prefix-"));
    const shim = renderGeneratedWrapperContent({
      kind: "cmd",
      nodeBin: join(work, "node.exe"),
      runtimeBin: join(work, "agenc.js"),
      agencHome: join(work, "home"),
    });
    expect(shim).toContain(
      'if not defined AGENC_INSTALL_PREFIX for %%I in ("%~dp0..") do set "AGENC_INSTALL_PREFIX=%%~fI"',
    );
    const prefix = "D:\\Tools\\agenc";
    const outputPath = join(work, "agenc-daemon.xml");
    const refused: string[] = [];
    expect(installAgencDaemonWinSWService({
      env: {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        USERDOMAIN: "ADA-PC",
        USERNAME: "Ada",
        AGENC_WINSW_XML: outputPath,
      },
      agencHome: HOME,
      stdout: () => {},
      stderr: (line) => refused.push(line),
    })).toBe(1);
    expect(refused.join("\n")).toContain("AGENC_INSTALL_PREFIX");
    const lines: string[] = [];
    expect(installAgencDaemonWinSWService({
      env: {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        AGENC_INSTALL_PREFIX: prefix,
        USERDOMAIN: "ADA-PC",
        USERNAME: "Ada",
        AGENC_WINSW_XML: outputPath,
      },
      agencHome: HOME,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    })).toBe(0);
    expect(parseAgencDaemonWinSWServiceXml(readFileSync(outputPath, "utf8")).launcher).toBe(
      "D:\\Tools\\agenc\\bin\\agenc.cmd",
    );
  });

  test("docs distinguish the one-line installer from the WinSW service step", () => {
    const install = readFileSync(join(REPO_ROOT, "docs/install.md"), "utf8");
    const daemon = readFileSync(join(REPO_ROOT, "docs/reference/daemon.md"), "utf8");
    const cli = readFileSync(join(REPO_ROOT, "docs/reference/cli.md"), "utf8");
    expect(install).toContain("That is not a service install");
    expect(install).toContain("agenc daemon install-service");
    expect(install).not.toContain(
      "Running the\ndaemon as a Windows service uses WinSW with `packaging/windows/agenc-daemon.xml`",
    );
    expect(daemon).toContain("separate elevated step");
    expect(cli).toContain("Does not install or start the Windows service");
  });
});
