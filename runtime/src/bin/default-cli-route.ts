/** Canonical trust/autostart preprocessing, with client implementations supplied by callers. */
import { setCoreOnlyEnvironmentVariable } from "../utils/runtimeEnvironment.js";
import {
  classifyCLI,
  routeCLI,
  type BootTUIArgs,
  type ContinueTUIArgs,
  type OneShotContinueSession,
  type ResumeTUIArgs,
} from "./route.js";
import { readStartupCliFlags, type StartupCliFlags } from "./startup-selection.js";
import { ensureAgenCDaemonAutostart, resolveAgenCDaemonAutostartEnabled } from "../app-server/daemon-autostart.js";
import { requireProjectTrustForTui } from "./project-trust-preflight.js";
import { resolveCliCwdForStartup, writeUnavailableCliCwd } from "./cli-cwd.js";

export interface DefaultCliRouteAdapters {
  readonly bootTUIEntry: (args: BootTUIArgs, flags: StartupCliFlags) => Promise<number>;
  readonly resumeTUIEntry: (args: ResumeTUIArgs, flags: StartupCliFlags) => Promise<number>;
  readonly continueTUIEntry: (args: ContinueTUIArgs, flags: StartupCliFlags) => Promise<number>;
  readonly oneShotCLI: typeof import("./agenc-main.js").oneShotCLI;
}

function isInteractiveTuiRoutePlan(
  plan: ReturnType<typeof classifyCLI>,
): boolean {
  return (
    plan.kind === "bootTUI" ||
    plan.kind === "resumeTUI" ||
    plan.kind === "continueTUI"
  );
}

export async function runDefaultCliRoute(
  argv: readonly string[],
  { bootTUIEntry, resumeTUIEntry, continueTUIEntry, oneShotCLI }: DefaultCliRouteAdapters,
): Promise<number> {
  const routePlan = classifyCLI({
    argv,
    isTTY: Boolean(process.stdin.isTTY),
    isStdoutTTY: Boolean(process.stdout.isTTY),
  });
  const startupCliFlags: StartupCliFlags =
    routePlan.kind === "errorAndExit"
      ? Object.freeze({})
      : readStartupCliFlags(argv);
  const targetResumeRoute =
    routePlan.kind === "resumeTUI" || routePlan.kind === "continueTUI";
  const routeNeedsToolTrust =
    routePlan.kind === "oneShotCLI" ||
    (isInteractiveTuiRoutePlan(routePlan) && !targetResumeRoute);
  const routeCwd = routeNeedsToolTrust
    ? resolveCliCwdForStartup(process.env)
    : null;
  if (routeCwd !== null && !routeCwd.ok) {
    return writeUnavailableCliCwd();
  }
  if (routeNeedsToolTrust) {
    if (routeCwd === null) {
      return writeUnavailableCliCwd();
    }
    if (
      !(await requireProjectTrustForTui({
        env: process.env,
        argv,
        startupCliFlags,
        cwd: routeCwd.cwd,
      }))
    ) {
      return 1;
    }
  }
  if (
    routePlan.kind !== "errorAndExit" &&
    !targetResumeRoute &&
    (await resolveAgenCDaemonAutostartEnabled(process.env))
  ) {
    try {
      // Surface respawn reasons on stderr instead of the historical
      // silentIo(): a failing autostart used to look like a frozen blank
      // terminal. Keep stdout quiet so the daemon CLI banner stays out of
      // interactive TUI rendering (mirrors defaultEnsureDaemonReady).
      const silentStdout = { write: () => true } as Pick<
        NodeJS.WriteStream,
        "write"
      >;
      await ensureAgenCDaemonAutostart({
        io: { stdout: silentStdout, stderr: process.stderr },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`agenc: daemon autostart failed: ${message}\n`);
      if (!process.stdout.isTTY) {
        return 1;
      }
      // Interactive sessions still get a working (daemon-less) TUI with a
      // visible error notice rather than an exit back to the shell. The
      // notice reads this env var at render time (StatusNotices).
      setCoreOnlyEnvironmentVariable("AGENC_DAEMON_AUTOSTART_FAILURE", message);
    }
  }
  return routeCLI({
    argv,
    isTTY: Boolean(process.stdin.isTTY),
    isStdoutTTY: Boolean(process.stdout.isTTY),
    bootTUI: (args: BootTUIArgs) => bootTUIEntry(args, startupCliFlags),
    oneShotCLI: (
      userMessage: string,
      startupImages?: readonly string[],
      continueSession?: OneShotContinueSession,
    ) =>
      oneShotCLI(
        userMessage.length > 0 ? userMessage : null,
        startupImages ?? [],
        startupCliFlags,
        continueSession,
      ),
    resumeTUI: (args: ResumeTUIArgs) => resumeTUIEntry(args, startupCliFlags),
    continueTUI: (args: ContinueTUIArgs) =>
      continueTUIEntry(args, startupCliFlags),
  });
}

