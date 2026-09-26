import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { escapeXmlAttr, unescapeXml } from "../utils/xml.js";

const AGENC_DAEMON_WINSW_SERVICE_ID = "agenc-daemon";
const AGENC_DAEMON_WINSW_SERVICE_NAME = "AgenC Daemon";
const WINDOWS_SYSTEM32_CMD_EXE = "C:\\Windows\\System32\\cmd.exe";

/** Packaging does not download WinSW. Service XML is pinned to this release. */
export const AGENC_DAEMON_WINSW_VERSION = "2.12.0";

const BUILTIN_SERVICE_USERS = new Set([
  "localsystem",
  "system",
  "localservice",
  "networkservice",
]);

const WINSW_LOG_SIZE_THRESHOLD_KB = "10240";

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

function serviceAccountUser(account: string): string {
  const separator = account.lastIndexOf("\\");
  return separator === -1 ? account : account.slice(separator + 1);
}

function assertWindowsServiceAccount(username: string): void {
  const normalized = normalizeAccountUsername(username);
  const user = serviceAccountUser(normalized).toLowerCase();
  if (
    normalized === "" ||
    user === "" ||
    user.endsWith("$") ||
    BUILTIN_SERVICE_USERS.has(user)
  ) {
    throw new Error(
      "service account must be the installing user, not LocalSystem, LocalService, NetworkService, or a machine account",
    );
  }
}

function splitWinSW212ServiceAccount(username: string): {
  readonly domain: string;
  readonly user: string;
} {
  const account = normalizeAccountUsername(username);
  assertWindowsServiceAccount(account);
  const separator = account.lastIndexOf("\\");
  const domain = separator === -1 ? "" : account.slice(0, separator);
  const user = separator === -1 ? account : account.slice(separator + 1);
  if (domain === "" || user === "") {
    throw new Error(
      "WinSW 2.12 service account must be DOMAIN\\user so the service is not LocalSystem",
    );
  }
  return { domain, user };
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
    throw new Error(
      "USERNAME is not set; refusing to generate a WinSW service without an installing user",
    );
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
  if (prefix === undefined || prefix === "") {
    throw new Error(
      "Cannot resolve agenc.cmd; the agenc.cmd shim must set AGENC_INSTALL_PREFIX",
    );
  }
  const launcher = joinServicePath(prefix, "bin", "agenc.cmd");
  assertLauncher(launcher);
  if (!existsSync(launcher)) {
    throw new Error(
      `agenc.cmd was not found at ${launcher}; AGENC_INSTALL_PREFIX must be the directory that contains bin\\agenc.cmd`,
    );
  }
  return launcher;
}

function resolveAgencDaemonWinSWOutputPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (env.AGENC_WINSW_XML !== undefined && env.AGENC_WINSW_XML !== "") {
    if (!win32.isAbsolute(env.AGENC_WINSW_XML)) {
      throw new Error("AGENC_WINSW_XML must be an absolute path");
    }
    return env.AGENC_WINSW_XML;
  }
  const prefix = env.AGENC_INSTALL_PREFIX;
  if (prefix === undefined || prefix === "") {
    throw new Error(
      "Cannot resolve the WinSW XML path; the agenc.cmd shim must set AGENC_INSTALL_PREFIX",
    );
  }
  assertAbsoluteServicePath(prefix, "install prefix");
  return joinServicePath(prefix, "agenc-daemon.xml");
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
    const outputPath = resolveAgencDaemonWinSWOutputPath(options.env);
    winsw212ExecutableForXml(outputPath);
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
  const account = splitWinSW212ServiceAccount(accountUsername);
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
    `    <domain>${escapeXmlAttr(account.domain)}</domain>`,
    `    <user>${escapeXmlAttr(account.user)}</user>`,
    "    <allowservicelogon>true</allowservicelogon>",
    "  </serviceaccount>",
    "  <startmode>Automatic</startmode>",
    '  <onfailure action="restart" delay="5 sec"/>',
    '  <log mode="roll-by-size">',
    `    <sizeThreshold>${WINSW_LOG_SIZE_THRESHOLD_KB}</sizeThreshold>`,
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
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u");
  const match = pattern.exec(xml);
  if (match?.[1] === undefined) {
    throw new Error(`WinSW XML is missing <${tag}>`);
  }
  return unescapeXml(match[1]);
}

function xmlEnvValue(xml: string, name: string): string {
  const pattern = new RegExp(`<env name="${name}" value="([^"]*)"/>`, "u");
  const match = pattern.exec(xml);
  if (match?.[1] === undefined) {
    throw new Error(`WinSW XML is missing env ${name}`);
  }
  return unescapeXml(match[1]);
}

export function parseAgencDaemonWinSWServiceXml(
  xml: string,
): ParsedAgencDaemonWinSWServiceXml {
  const argumentsText = xmlText(xml, "arguments");
  const launcherPattern =
    /^\/d \/v:off \/s \/c ""([\s\S]+)" daemon start --foreground"$/u;
  const launcherMatch = launcherPattern.exec(argumentsText);
  if (launcherMatch?.[1] === undefined) {
    throw new Error("WinSW arguments are not a PATH-independent cmd invocation");
  }
  if (/<password[\s>]/iu.test(xml) || /<username[\s>]/iu.test(xml)) {
    throw new Error(
      "WinSW 2.12 XML must use <domain> and <user> and must not store a password or <username>",
    );
  }
  const domain = xmlText(xml, "domain");
  const user = xmlText(xml, "user");
  return {
    xml,
    id: xmlText(xml, "id"),
    executable: xmlText(xml, "executable"),
    arguments: argumentsText,
    launcher: unescapeCmdPercent(launcherMatch[1]),
    workingDirectory: xmlText(xml, "workingdirectory"),
    agencHome: xmlEnvValue(xml, "AGENC_HOME"),
    accountUsername: `${domain}\\${user}`,
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

function winsw212ExecutableForXml(outputPath: string): string {
  const base = win32.basename(outputPath);
  const stem = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.xml$/u.exec(base)?.[1];
  if (stem === undefined) {
    throw new Error(
      "WinSW 2.12.0 loads <exe-basename>.xml beside the executable; AGENC_WINSW_XML must be named like agenc-daemon.xml",
    );
  }
  return win32.join(win32.dirname(outputPath), `${stem}.exe`);
}

function formatWinSWServiceInstallInstructions(input: {
  readonly outputPath: string;
  readonly accountUsername: string;
  readonly agencHome: string;
  readonly launcher: string;
}): string {
  const executable = winsw212ExecutableForXml(input.outputPath);
  return [
    `Wrote ${input.outputPath}`,
    "This file is the service definition only. The one-line Windows installer",
    "does not install or start a Windows service.",
    "",
    `Pinned WinSW version: ${AGENC_DAEMON_WINSW_VERSION}`,
    "WinSW 2.12.0 loads <exe directory>\\<exe basename>.xml (Program.cs).",
    "Place the v2.12.0 binary beside this file and name it:",
    `  "${executable}"`,
    "",
    "Service identity recorded in <domain> and <user>:",
    `  account:    ${input.accountUsername}`,
    `  AGENC_HOME: ${input.agencHome}`,
    `  launcher:   ${input.launcher}`,
    "",
    "The XML omits <password>. Do not run install /p.",
    "install /p prompts Username: and Password: and passes the typed name to",
    "CreateService. The XML account is not that name. Typing LocalSystem",
    "installs as LocalSystem. Password: is skipped for LocalSystem,",
    "LocalService, and NetworkService.",
    "",
    "install with no /p passes DOMAIN\\user and a null password to CreateServiceW.",
    "CreateServiceW checks that the account exists, not the password.",
    "install records the XML account with no password. start fails with error 1069",
    "until the password is set.",
    "Set that password in services.msc: AgenC Daemon, Log On, This account.",
    `sc.exe config ${AGENC_DAEMON_WINSW_SERVICE_ID} obj= "${input.accountUsername}" password= ...`,
    "puts the password on the command line, where shell history and process",
    "listings can capture it.",
    "Before start, confirm the account:",
    `  sc.exe qc ${AGENC_DAEMON_WINSW_SERVICE_ID}`,
    `SERVICE_START_NAME must be ${input.accountUsername}.`,
    "Do not start the service when it is LocalSystem.",
    "",
    `  "${executable}" install`,
    `  services.msc → AgenC Daemon → Log On → This account: ${input.accountUsername}`,
    `  sc.exe qc ${AGENC_DAEMON_WINSW_SERVICE_ID}`,
    `  "${executable}" start`,
    `  "${executable}" stop`,
    `  "${executable}" restart`,
    "",
    "agenc daemon start still works without a Windows service.",
  ].join("\n");
}
