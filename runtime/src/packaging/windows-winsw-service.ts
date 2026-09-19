import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { escapeXmlAttr, unescapeXml } from "../utils/xml.js";

const AGENC_DAEMON_WINSW_SERVICE_ID = "agenc-daemon";
const AGENC_DAEMON_WINSW_SERVICE_NAME = "AgenC Daemon";
const WINDOWS_SYSTEM32_CMD_EXE = "C:\\Windows\\System32\\cmd.exe";

const LOCAL_SYSTEM_ACCOUNTS = new Set([
  "localsystem",
  "system",
  ".\\system",
  "nt authority\\system",
]);

type AgencDaemonWinSWServiceInput = {
  readonly commandPrompt: string;
  readonly launcher: string;
  readonly agencHome: string;
  readonly accountUsername: string;
  readonly workingDirectory?: string;
};

type AgencDaemonWinSWServiceDefinition = {
  readonly id: string;
  readonly name: string;
  readonly executable: string;
  readonly arguments: string;
  readonly workingDirectory: string;
  readonly agencHome: string;
  readonly accountUsername: string;
  readonly xml: string;
};

type ParsedAgencDaemonWinSWServiceXml = {
  readonly xml: string;
  readonly id: string;
  readonly executable: string;
  readonly arguments: string;
  readonly launcher: string;
  readonly workingDirectory: string;
  readonly agencHome: string;
  readonly accountUsername: string;
  readonly allowServiceLogon: boolean;
};

function hasDisallowedControlCharacters(value: string): boolean {
  return /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function assertAbsoluteServicePath(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be an absolute path`);
  }
  if (hasDisallowedControlCharacters(value) || value.includes('"')) {
    throw new Error(`${label} must not contain control characters or double quotes`);
  }
  if (!win32.isAbsolute(value) || value === "agenc") {
    throw new Error(`${label} must be an absolute path`);
  }
}

function assertCommandPrompt(value: string): void {
  assertAbsoluteServicePath(value, "commandPrompt");
  if (!/(?:^|[\\/])cmd\.exe$/iu.test(value)) {
    throw new Error("commandPrompt must be an absolute cmd.exe path");
  }
}

function assertLauncher(value: string): void {
  assertAbsoluteServicePath(value, "launcher");
  if (!/(?:^|[\\/])agenc\.cmd$/iu.test(value)) {
    throw new Error("launcher must be an absolute agenc.cmd path");
  }
}

function normalizeAccountUsername(value: string): string {
  return value.trim().replaceAll("/", "\\");
}

function assertWindowsServiceAccount(username: string): void {
  const normalized = normalizeAccountUsername(username);
  if (normalized === "") {
    throw new Error("service account must be the installing user, not LocalSystem");
  }
  if (
    LOCAL_SYSTEM_ACCOUNTS.has(normalized.toLowerCase()) ||
    normalized.toLowerCase() === "nt authority\\system"
  ) {
    throw new Error("service account must be the installing user, not LocalSystem");
  }
}

function escapeCmdPercent(value: string): string {
  return value.replaceAll("%", "%%");
}

function unescapeCmdPercent(value: string): string {
  return value.replaceAll("%%", "%");
}

function buildWinSWCmdArguments(launcher: string): string {
  assertLauncher(launcher);
  return `/d /v:off /s /c ""${escapeCmdPercent(launcher)}" daemon start --foreground"`;
}

export function resolveWindowsCmdExe(
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (root === undefined || root === "") {
    return WINDOWS_SYSTEM32_CMD_EXE;
  }
  assertAbsoluteServicePath(root, "SystemRoot");
  return win32.join(root, "System32", "cmd.exe");
}

export function resolveWindowsServiceAccount(
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const user = env.USERNAME ?? env.USER;
  if (user === undefined || user.trim() === "") {
    throw new Error("service account must be the installing user, not LocalSystem");
  }
  const domain = env.USERDOMAIN?.trim();
  const username = domain ? `${domain}\\${user.trim()}` : `.\\${user.trim()}`;
  assertWindowsServiceAccount(username);
  return username;
}

function joinServicePath(...parts: string[]): string {
  const first = parts[0] ?? "";
  if (/^[A-Za-z]:[\\/]/u.test(first) || first.startsWith("\\\\")) {
    return win32.join(...parts);
  }
  return join(...parts);
}

function resolveWindowsAgencLauncher(
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const prefix = env.AGENC_INSTALL_PREFIX;
  if (prefix !== undefined && prefix !== "") {
    const launcher = joinServicePath(prefix, "bin", "agenc.cmd");
    assertLauncher(launcher);
    return launcher;
  }
  const localAppData = env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData !== "") {
    const launcher = joinServicePath(localAppData, "agenc", "bin", "agenc.cmd");
    assertLauncher(launcher);
    return launcher;
  }
  throw new Error(
    "Cannot resolve agenc.cmd; set AGENC_INSTALL_PREFIX or LOCALAPPDATA",
  );
}

function resolveAgencDaemonWinSWOutputPath(
  env: Readonly<Record<string, string | undefined>>,
  agencHome: string,
): string {
  if (env.AGENC_WINSW_XML !== undefined && env.AGENC_WINSW_XML !== "") {
    if (!win32.isAbsolute(env.AGENC_WINSW_XML)) {
      throw new Error("AGENC_WINSW_XML must be an absolute path");
    }
    return env.AGENC_WINSW_XML;
  }
  const prefix =
    env.AGENC_INSTALL_PREFIX ??
    (env.LOCALAPPDATA === undefined || env.LOCALAPPDATA === ""
      ? undefined
      : joinServicePath(env.LOCALAPPDATA, "agenc"));
  if (prefix !== undefined && prefix !== "") {
    assertAbsoluteServicePath(prefix, "install prefix");
    return joinServicePath(prefix, "agenc-daemon.xml");
  }
  assertAbsoluteServicePath(agencHome, "AGENC_HOME");
  return joinServicePath(agencHome, "agenc-daemon.xml");
}

export function installAgencDaemonWinSWService(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly agencHome: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}): number {
  try {
    const launcher = resolveWindowsAgencLauncher(options.env);
    const accountUsername = resolveWindowsServiceAccount(options.env);
    const outputPath = resolveAgencDaemonWinSWOutputPath(
      options.env,
      options.agencHome,
    );
    writeAgencDaemonWinSWServiceXml({
      commandPrompt: resolveWindowsCmdExe(options.env),
      launcher,
      agencHome: options.agencHome,
      accountUsername,
      outputPath,
    });
    options.stdout(
      formatWinSWServiceInstallInstructions({
        outputPath,
        accountUsername,
        agencHome: options.agencHome,
        launcher,
      }),
    );
    return 0;
  } catch (error) {
    options.stderr(
      `agenc: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

export function renderAgencDaemonWinSWService(
  input: AgencDaemonWinSWServiceInput,
): AgencDaemonWinSWServiceDefinition {
  assertCommandPrompt(input.commandPrompt);
  assertLauncher(input.launcher);
  assertAbsoluteServicePath(input.agencHome, "AGENC_HOME");
  assertWindowsServiceAccount(input.accountUsername);
  const workingDirectory = input.workingDirectory ?? input.agencHome;
  assertAbsoluteServicePath(workingDirectory, "workingDirectory");
  const accountUsername = normalizeAccountUsername(input.accountUsername);
  const args = buildWinSWCmdArguments(input.launcher);
  const xml = [
    "<service>",
    `  <id>${AGENC_DAEMON_WINSW_SERVICE_ID}</id>`,
    `  <name>${AGENC_DAEMON_WINSW_SERVICE_NAME}</name>`,
    "  <description>Runs the local AgenC daemon control plane for the installing user's AGENC_HOME.</description>",
    `  <executable>${escapeXmlAttr(input.commandPrompt)}</executable>`,
    `  <arguments>${escapeXmlAttr(args)}</arguments>`,
    `  <workingdirectory>${escapeXmlAttr(workingDirectory)}</workingdirectory>`,
    `  <env name="AGENC_HOME" value="${escapeXmlAttr(input.agencHome)}"/>`,
    '  <env name="NODE_ENV" value="production"/>',
    "  <serviceaccount>",
    `    <username>${escapeXmlAttr(accountUsername)}</username>`,
    "    <allowservicelogon>true</allowservicelogon>",
    "  </serviceaccount>",
    "  <startmode>Automatic</startmode>",
    '  <onfailure action="restart" delay="5 sec"/>',
    '  <log mode="roll-by-size">',
    "    <sizeThreshold>10485760</sizeThreshold>",
    "    <keepFiles>5</keepFiles>",
    "  </log>",
    "</service>",
    "",
  ].join("\n");
  return {
    id: AGENC_DAEMON_WINSW_SERVICE_ID,
    name: AGENC_DAEMON_WINSW_SERVICE_NAME,
    executable: input.commandPrompt,
    arguments: args,
    workingDirectory,
    agencHome: input.agencHome,
    accountUsername,
    xml,
  };
}

function xmlText(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u"));
  if (match?.[1] === undefined) {
    throw new Error(`WinSW XML is missing <${tag}>`);
  }
  return unescapeXml(match[1]);
}

function xmlEnvValue(xml: string, name: string): string {
  const match = xml.match(
    new RegExp(`<env name="${name}" value="([^"]*)"/>`, "u"),
  );
  if (match?.[1] === undefined) {
    throw new Error(`WinSW XML is missing env ${name}`);
  }
  return unescapeXml(match[1]);
}

export function parseAgencDaemonWinSWServiceXml(
  xml: string,
): ParsedAgencDaemonWinSWServiceXml {
  const argumentsText = xmlText(xml, "arguments");
  const launcherMatch = argumentsText.match(
    /^\/d \/v:off \/s \/c ""([\s\S]+)" daemon start --foreground"$/u,
  );
  if (launcherMatch?.[1] === undefined) {
    throw new Error("WinSW arguments are not a PATH-independent cmd invocation");
  }
  return {
    xml,
    id: xmlText(xml, "id"),
    executable: xmlText(xml, "executable"),
    arguments: argumentsText,
    launcher: unescapeCmdPercent(launcherMatch[1]),
    workingDirectory: xmlText(xml, "workingdirectory"),
    agencHome: xmlEnvValue(xml, "AGENC_HOME"),
    accountUsername: xmlText(xml, "username"),
    allowServiceLogon: xml.includes("<allowservicelogon>true</allowservicelogon>"),
  };
}

export function writeAgencDaemonWinSWServiceXml(
  input: AgencDaemonWinSWServiceInput & { readonly outputPath: string },
): AgencDaemonWinSWServiceDefinition & { readonly outputPath: string } {
  const definition = renderAgencDaemonWinSWService(input);
  mkdirSync(dirname(input.outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(input.outputPath, definition.xml, { encoding: "utf8" });
  return { ...definition, outputPath: input.outputPath };
}

function formatWinSWServiceInstallInstructions(input: {
  readonly outputPath: string;
  readonly accountUsername: string;
  readonly agencHome: string;
  readonly launcher: string;
}): string {
  return [
    `Wrote ${input.outputPath}`,
    "This file is the service definition only. The one-line Windows installer",
    "does not install or start a Windows service.",
    "",
    "Service identity: the installing user (not LocalSystem)",
    `  account:    ${input.accountUsername}`,
    `  AGENC_HOME: ${input.agencHome}`,
    `  launcher:   ${input.launcher}`,
    "",
    "To install, start, stop, and restart with WinSW (typically elevated):",
    `  winsw install "${input.outputPath}"`,
    "  winsw start agenc-daemon",
    "  winsw stop agenc-daemon",
    "  winsw restart agenc-daemon",
    "",
    "agenc daemon start still works without a Windows service.",
  ].join("\n");
}
