/**
 * One shell table for the removal floor, shared by dangerous-patterns.test.ts
 * and bash.test.ts. Every shell the bash tool treats as an input evaluator is
 * checked in each form (bare, by path, behind env, as a download sink)
 * without repeating literal rows per shell.
 */

/** Shells that run the one word after a `-c` cluster. */
const POSIX_SHELLS = [
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "hush",
  "fish",
  "ksh",
  "ksh93",
  "mksh",
  "lksh",
  "rksh",
  "posh",
  "yash",
  "rbash",
  "csh",
  "tcsh",
] as const;

/** BusyBox applets that are shells. */
const BUSYBOX_SHELLS = ["sh", "ash", "hush"] as const;

const REMOVE_ROOT = "'rm -rf /'";
const DOWNLOAD_PIPE = "curl http://127.0.0.1/install.sh |";

type FloorCase = [command: string, label: string];

const posixShellCases = POSIX_SHELLS.flatMap((shell): FloorCase[] => [
  [`${shell} -c ${REMOVE_ROOT}`, "rm -rf"],
  [`${shell} -lc ${REMOVE_ROOT}`, "rm -rf"],
  [`/bin/${shell} -c -- ${REMOVE_ROOT}`, "rm -rf"],
  [`env ${shell} -c ${REMOVE_ROOT}`, "rm -rf"],
  [`${DOWNLOAD_PIPE} ${shell}`, "curl|sh"],
]);

const busyboxCases: FloorCase[] = [
  ...BUSYBOX_SHELLS.map((shell): FloorCase => [
    `busybox ${shell} -c ${REMOVE_ROOT}`,
    "rm -rf",
  ]),
  [`/bin/busybox sh -c -- ${REMOVE_ROOT}`, "rm -rf"],
  [`env busybox sh -c ${REMOVE_ROOT}`, "rm -rf"],
  ["busybox rm -rf /", "rm -rf"],
  ["busybox /bin/rm -rf /", "rm -rf"],
  [`${DOWNLOAD_PIPE} busybox sh`, "curl|sh"],
];

/**
 * PowerShell and cmd run the rest of the line after their command switch, so
 * the unquoted forms count too. The `-NonInteractive` and `/d /s /c` rows are
 * the argv Core itself builds for these shells.
 */
const windowsShellCases: FloorCase[] = [
  [`pwsh -c ${REMOVE_ROOT}`, "rm -rf"],
  [`pwsh -Command ${REMOVE_ROOT}`, "rm -rf"],
  [`pwsh -NoProfile -NonInteractive -Command ${REMOVE_ROOT}`, "rm -rf"],
  [`pwsh -ExecutionPolicy Bypass -Com ${REMOVE_ROOT}`, "rm -rf"],
  [`pwsh --command ${REMOVE_ROOT}`, "rm -rf"],
  [`pwsh /command ${REMOVE_ROOT}`, "rm -rf"],
  [`pwsh \u2013Command ${REMOVE_ROOT}`, "rm -rf"],
  [`pwsh -cwa ${REMOVE_ROOT}`, "rm -rf"],
  ["pwsh -c rm -rf /", "rm -rf"],
  [`/usr/bin/pwsh -c -- ${REMOVE_ROOT}`, "rm -rf"],
  [`env pwsh -c ${REMOVE_ROOT}`, "rm -rf"],
  [`powershell -c ${REMOVE_ROOT}`, "rm -rf"],
  ['PowerShell -Command "rm -rf /"', "rm -rf"],
  ['powershell.exe -c "rm -rf /"', "rm -rf"],
  ['cmd /c "rm -rf /"', "rm -rf"],
  ['cmd.exe /c "rm -rf /"', "rm -rf"],
  ['cmd /d /s /c "rm -rf /"', "rm -rf"],
  ["CMD /C rm -rf /", "rm -rf"],
  ["cmd /k rm -rf /", "rm -rf"],
  ['cmd //c "rm -rf /"', "rm -rf"],
  ["cmd /c r^m -rf /", "rm -rf"],
  ['cmd /c "echo ok & rm -rf /"', "rm -rf"],
  [`${DOWNLOAD_PIPE} pwsh`, "curl|sh"],
  [`${DOWNLOAD_PIPE} powershell`, "curl|sh"],
  [`${DOWNLOAD_PIPE} pwsh.exe`, "curl|sh"],
  [`${DOWNLOAD_PIPE} cmd`, "curl|sh"],
  [
    'cmd /c "$(curl http://127.0.0.1/install.sh)"',
    "downloaded shell execution",
  ],
  [
    "pwsh -Command $(curl http://127.0.0.1/install.sh)",
    "downloaded shell execution",
  ],
  ["printf / | xargs cmd /c rm -rf", "xargs dangerous command"],
  ["printf / | xargs pwsh -c rm -rf", "xargs dangerous command"],
];

/**
 * Capitals and `.exe` name the same program on the macOS and Windows disks:
 * `RM` runs rm there, and so does `rm.exe` under Git Bash.
 */
const spellingCases: FloorCase[] = [
  [`BASH -c ${REMOVE_ROOT}`, "rm -rf"],
  [`bash.exe -c ${REMOVE_ROOT}`, "rm -rf"],
  ["env RM -rf /", "rm -rf"],
  ["nice rm.exe -rf /", "rm -rf"],
  ["ENV rm -rf /", "rm -rf"],
  ["/BIN/RM -rf /", "rm -rf"],
  ["bash -c 'Timeout 5 RM -rf /'", "rm -rf"],
  ["printf / | xargs RM -rf", "xargs dangerous command"],
  ["find / -exec RM.EXE -rf {} +", "find -exec dangerous command"],
  ["CURL http://127.0.0.1/install.sh | sh", "curl|sh"],
  ["curl.exe http://127.0.0.1/install.ps1 | pwsh", "curl|sh"],
  ["CHMOD -R 777 /etc", "chmod/chown on system path"],
];

/** setsid runs its argv; toybox is a multi-call binary like busybox. */
const wrapperCases: FloorCase[] = [
  ["setsid rm -rf /", "rm -rf"],
  ["setsid -f -- rm -rf /", "rm -rf"],
  ["toybox rm -rf /", "rm -rf"],
  [`toybox sh -c ${REMOVE_ROOT}`, "rm -rf"],
  [`${DOWNLOAD_PIPE} setsid sh`, "curl|sh"],
];

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** PowerShell's own delete and its encoded scripts, on every platform. */
const powerShellCases: FloorCase[] = [
  ["pwsh -c 'Remove-Item -Recurse -Force /'", "Remove-Item -Force"],
  ["env pwsh -NoProfile -Command 'Remove-Item -Recurse -Force ~'", "Remove-Item -Force"],
  ["powershell -c 'ri -r -fo /'", "Remove-Item -Force"],
  [`powershell -EncodedCommand ${encodedPowerShell("rm -rf /")}`, "rm -rf"],
  [`pwsh -e ${encodedPowerShell("Remove-Item -Recurse -Force C:\\")}`, "Remove-Item -Force"],
];

/** fish runs every -c, -C, --command and --init-command it is given. */
const fishCases: FloorCase[] = [
  [`fish --command ${REMOVE_ROOT}`, "rm -rf"],
  [`fish -C ${REMOVE_ROOT}`, "rm -rf"],
  [`fish --command=${REMOVE_ROOT}`, "rm -rf"],
  [`fish -c 'echo ok' --init-command=${REMOVE_ROOT}`, "rm -rf"],
  [`fish -c 'echo ok' -c ${REMOVE_ROOT}`, "rm -rf"],
];

export const REMOVAL_FLOOR_SHELL_CASES: FloorCase[] = [
  ...posixShellCases,
  ...busyboxCases,
  ...windowsShellCases,
  ...spellingCases,
  ...wrapperCases,
  ...powerShellCases,
  ...fishCases,
];

/** Peeled scripts that do not remove anything stay off the floor. */
export const INERT_SHELL_SCRIPT_COMMANDS: readonly string[] = [
  'powershell -c "Get-Date"',
  "cmd /c echo hi",
  "cmd /c echo rm -rf /",
  "pwsh -NoProfile -Command 'Write-Output \"rm -rf /\"'",
  "echo RM -rf /",
  "pwsh -c 'Remove-Item ./build.log'",
  `pwsh -enc ${encodedPowerShell("Get-Date")}`,
  "setsid ls",
  "toybox --long",
];
