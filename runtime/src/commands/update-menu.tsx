import React from "react";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";
import { checkAgenCUpdate, runAgenCUpdateCli, sanitizeTerminalText } from "../bin/update-cli.js";
import { findActiveGeneratedWrapper } from "../utils/doctorDiagnostic.js";
import { detectHomebrew, HOMEBREW_UPDATE_COMMAND } from "../utils/nativeInstaller/homebrew.js";
import { getRuntimeState, updateRuntimeState } from "../utils/config.js";
import type { RuntimeStateRepository } from "../config/runtime-state-repository.js";
import { requireCommandConfigStore } from "./config-context.js";
import { VERSION } from "../version.js";
import {
  homebrewExecTarget,
  NPM_UPDATE_COMMAND,
  npmExecTarget,
  packageManagerCommand,
  readInstalledAgenCVersion,
  runPackageManagerUpdate,
  startedByNpmLauncher,
  type PackageManagerKind,
  type PackageManagerRun,
} from "./update-package-manager.js";
import { setPendingUpdateFollow, type UpdateInstallType, type UpdateRelaunchRequest } from "../tui/update-relaunch-state.js";

export type UpdateCheck = Awaited<ReturnType<typeof checkAgenCUpdate>>;
export { NPM_UPDATE_COMMAND };

/** What the menu needs to update this TUI in place. */
export interface UpdateMenuRelaunch {
  /** Exit and come back on the new version (App.requestUpdateRelaunch). */
  readonly relaunch: (request: UpdateRelaunchRequest) => void;
  /** Whether a turn, tool or local agent is running right now. */
  readonly isBusy?: () => boolean;
  readonly conversationId?: string;
  readonly cwd: string;
  readonly platform?: NodeJS.Platform;
}

/** Seams for tests; production uses the real package managers. */
export interface UpdateMenuDeps {
  readonly startedByNpm?: () => Promise<boolean>;
  readonly runPackageManager?: (kind: PackageManagerKind, onLine: (line: string) => void) => Promise<PackageManagerRun>;
  readonly execTarget?: (kind: PackageManagerKind) => Promise<string | null>;
  readonly installedVersion?: (command: string) => Promise<string | null>;
}

/** Before the first prompt the TUI has a placeholder, not a conversation. */
export function resumableConversationId(id: string | undefined): string | undefined {
  return id !== undefined && id.length > 0 && !id.startsWith("agenc-tui-idle-") ? id : undefined;
}

export function UpdateMenu({ checked: initial, startup = false, close, stateRepository, inPlace, deps = {} }: {
  checked?: UpdateCheck; startup?: boolean; close: () => void; stateRepository?: RuntimeStateRepository;
  inPlace?: UpdateMenuRelaunch; deps?: UpdateMenuDeps;
}) {
  const [checked, setChecked] = React.useState(initial);
  const [installType, setInstallType] = React.useState("checking");
  const wrapper = React.useRef<string | undefined>(undefined);
  const [message, setMessage] = React.useState(initial ? "" : "Checking for updates.");
  const [output, setOutput] = React.useState<readonly string[]>([]);
  const [index, setIndex] = React.useState(0);
  const selected = React.useRef(0);
  const busyRef = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [finished, setFinished] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const platform = inPlace?.platform ?? process.platform;
  // Windows replaces a process differently; it keeps the restart message.
  const canRelaunch = inPlace !== undefined && platform !== "win32";
  React.useEffect(() => {
    let active = true;
    if (detectHomebrew()) {
      wrapper.current = undefined;
      setInstallType("Homebrew");
    } else void findActiveGeneratedWrapper().then(async found => {
      if (!active) return;
      wrapper.current = found?.path;
      if (found) { setInstallType(found.kind === "cmd" ? "install.ps1" : "install.sh"); return; }
      // npm launchers also use private runtimes, but have no generated wrapper.
      if (!canRelaunch) { setInstallType("npm or unmanaged runtime"); return; }
      const npm = await (deps.startedByNpm ?? (() => startedByNpmLauncher()))().catch(() => false);
      if (active) setInstallType(npm ? "npm" : "unmanaged runtime");
    }, () => { if (active) setInstallType("unmanaged runtime"); });
    if (!initial) {
      void checkAgenCUpdate(undefined, { manifestTimeoutMs: 3000 }).then(result => {
        if (!active) return;
        setChecked(result); setMessage("");
      }, error => {
        if (!active) return;
        setFailed(true); setFinished(true);
        setMessage(`Could not check for updates: ${sanitizeTerminalText(error instanceof Error ? error.message : error)}. Try /update again.`);
      });
    }
    return () => { active = false; };
  }, [initial, canRelaunch]);
  /** Finish with `text`, or keep the message already shown when it is undefined. */
  const done = (text: string | undefined, isError = false) => {
    busyRef.current = false; setBusy(false); setFinished(true); setFailed(isError);
    setMessage(current => text ?? (current || "The update did not finish."));
  };
  /** The new version is installed: come back on it now, or once idle. */
  const handOff = (targetVersion: string, command: string, type: UpdateInstallType) => {
    if (!inPlace) return;
    const conversationId = resumableConversationId(inPlace.conversationId);
    const request: UpdateRelaunchRequest = {
      fromVersion: VERSION, targetVersion, command, installType: type, cwd: inPlace.cwd,
      ...(conversationId === undefined ? {} : { conversationId }),
    };
    if (inPlace.isBusy?.() === true) {
      setPendingUpdateFollow({ request, when: "idle" });
      done(`Installed AgenC ${targetVersion}. AgenC restarts on it in this conversation once the current work is done.`);
      return;
    }
    done(`Installed AgenC ${targetVersion}. Restarting AgenC on ${targetVersion}.`);
    inPlace.relaunch(request);
  };
  const updateWithPackageManager = (kind: PackageManagerKind) => {
    const { display } = packageManagerCommand(kind);
    busyRef.current = true; setBusy(true); setOutput([]); setMessage(`Running ${display}`);
    const run = deps.runPackageManager ?? ((k: PackageManagerKind, onLine: (line: string) => void) => runPackageManagerUpdate(k, { onLine }));
    void run(kind, line => setOutput(lines => [...lines.slice(-7), sanitizeTerminalText(line)])).then(async result => {
      if (!result.ok) {
        setOutput(result.tail.map(line => sanitizeTerminalText(line)));
        done(`${display} did not finish${result.code === null ? "" : ` (exit ${result.code})`}. AgenC keeps running ${VERSION}.`, true);
        return;
      }
      setMessage("Checking the new version.");
      const target = await (deps.execTarget ?? (async (k: PackageManagerKind) =>
        k === "Homebrew" ? homebrewExecTarget(process.argv[1] ?? "") : npmExecTarget()))(kind);
      const version = target === null ? null : await (deps.installedVersion ?? readInstalledAgenCVersion)(target);
      if (target === null || version === null) {
        done(`${display} finished, but the new AgenC could not be found. AgenC keeps running ${VERSION}. Quit AgenC and start it again.`, true);
        return;
      }
      if (version === VERSION) {
        done(`${display} finished. AgenC ${VERSION} is still the installed version.`);
        return;
      }
      setOutput([]);
      handOff(version, target, kind);
    }, error => done(`${display} failed: ${sanitizeTerminalText(error)}. AgenC keeps running ${VERSION}.`, true));
  };
  const choose = (choice: number) => {
    if (busyRef.current) return;
    if (choice === 2) { close(); return; }
    if (choice === 1) {
      if (!checked) return;
      try {
        updateRuntimeState(state => ({ ...state, skippedUpdateVersion: checked.latestVersion }), stateRepository);
        close();
      } catch (error) {
        setFailed(true); setMessage(`Could not remember this choice: ${sanitizeTerminalText(error)}.`);
      }
      return;
    }
    if (!checked?.updateAvailable || installType === "checking") return;
    if (installType === "Homebrew") {
      if (canRelaunch) { updateWithPackageManager("Homebrew"); return; }
      setFinished(true);
      setMessage(`Run in your terminal: ${HOMEBREW_UPDATE_COMMAND}\nThen launch AgenC again. Its daemon will restart on the new version and restore saved sessions.`);
      return;
    }
    if (installType === "npm" && canRelaunch) { updateWithPackageManager("npm"); return; }
    if (!wrapper.current) {
      setFinished(true);
      setMessage(`Run in your terminal: ${NPM_UPDATE_COMMAND}\nFor an unmanaged runtime, rerun the AgenC installer. Then launch AgenC again. Its daemon will restart on the new version and restore saved sessions.`);
      return;
    }
    const wrapperPath = wrapper.current;
    busyRef.current = true; setBusy(true); setMessage("Checking the release before installing.");
    let result: { activated?: boolean; latestVersion: string; retainedVersion?: string } | undefined;
    // In place, this TUI moves the daemon itself once it has exited.
    void runAgenCUpdateCli({ kind: "update", check: false, json: true, wrapper: wrapperPath, ...(canRelaunch ? { noRestart: true } : {}) }, {
      expectedVersion: checked.latestVersion,
      manifestTimeoutMs: 3000,
      onProgress: setMessage,
      stderr: line => { setFailed(true); setMessage(line); },
      stdout: line => { result = JSON.parse(line) as typeof result; },
    }).then(code => {
      if (code !== 0 || result === undefined) { done(undefined, true); return; }
      const active = result.activated ? result.latestVersion : result.retainedVersion;
      if (canRelaunch && installType === "install.sh" && active !== undefined && active !== VERSION) {
        handOff(active, wrapperPath, "install.sh");
        return;
      }
      done(result.activated
        ? `Installed AgenC ${result.latestVersion}. This session keeps running on ${VERSION}.\nExit AgenC and launch it again to use ${result.latestVersion}. Its daemon will restart on the new version and restore saved sessions.`
        : `The active runtime is ${result.retainedVersion ?? "already current"}. Exit AgenC and launch it again to use it.`);
    }, error => done(sanitizeTerminalText(error), true));
  };
  const inPlaceKind = canRelaunch && (installType === "install.sh" || installType === "Homebrew" || installType === "npm");
  const firstChoice = inPlaceKind
    ? (inPlace?.isBusy?.() === true ? "1 Update after this turn" : "1 Update now")
    : installType === "Homebrew" ? "1 Show brew command" : "1 Update now";
  const choices = finished || !checked?.updateAvailable ? ["Close"] : [firstChoice, "2 Skip this version", "3 Not now"];
  useInput((input, key) => {
    if (busyRef.current) return;
    if (key.escape || input === "q") { close(); return; }
    if (choices.length === 1) { if (key.return) close(); return; }
    if (key.upArrow || key.downArrow) {
      selected.current = (selected.current + (key.upArrow ? 2 : 1)) % 3; setIndex(selected.current);
    }
    if (/^[123]$/.test(input)) choose(Number(input) - 1);
    else if (key.return) choose(selected.current);
  });
  const releaseMessage = checked?.updateAvailable
    ? `AgenC ${checked.latestVersion} is available. You have ${checked.currentVersion}.`
    : checked ? `AgenC ${checked.currentVersion} is up to date.` : `You have AgenC ${VERSION}.`;
  return <MenuModal title="update" summary="AgenC runtime"
    columns={[30]} headers={["choice"]} items={choices} activeIndex={Math.min(index, choices.length - 1)}
    renderRow={choice => [<ThemedText key="choice" color="text">{choice}</ThemedText>]}
    detail={<Box flexDirection="column" gap={1}>
      <ThemedText color="text" wrap="wrap">{releaseMessage}</ThemedText>
      <ThemedText color="text2">Installed: {checked?.currentVersion ?? VERSION} | Latest: {checked?.latestVersion ?? "checking"} | Install type: {installType}</ThemedText>
      {!finished && installType === "Homebrew" && !canRelaunch && <ThemedText color="text2" wrap="wrap">{`Homebrew manages this installation. Run in your terminal: ${HOMEBREW_UPDATE_COMMAND}`}</ThemedText>}
      {!finished && !busy && checked?.updateAvailable && inPlaceKind && <ThemedText color="text2" wrap="wrap">{inPlace?.isBusy?.() === true
        ? "Installs now, then restarts AgenC on the new version in this conversation when the current work is done."
        : "Installs, then restarts AgenC on the new version in this conversation."}</ThemedText>}
      {!finished && checked?.updateAvailable && <ThemedText color="text2">{startup ? "Not now asks again on your next launch." : "Skip remembers this version. /update always checks again."}</ThemedText>}
      {output.length > 0 && <Box flexDirection="column">{output.map((line, i) => <ThemedText key={i} color="text2" wrap="truncate-end">{line}</ThemedText>)}</Box>}
      {message && <ThemedText color={failed ? "error" : "text2"} wrap="wrap">{message}</ThemedText>}
    </Box>}
    footer={busy ? [] : choices.length === 1 ? [{ keyName: "enter", label: "close" }, { keyName: "esc", label: "close" }] : [{ keyName: "1/2/3", label: "choose" }, { keyName: "enter", label: "select" }, { keyName: "esc", label: "not now" }]} />;
}

/** The in-place handoff for a TUI command context, when the TUI offers one. */
export function inPlaceFromContext(ctx: SlashCommandContext): UpdateMenuRelaunch | undefined {
  const relaunch = ctx.appState?.requestUpdateRelaunch;
  if (relaunch === undefined) return undefined;
  const conversationId = resumableConversationId(ctx.session?.conversationId);
  return {
    relaunch,
    cwd: ctx.cwd,
    ...(ctx.appState?.isSessionBusy === undefined ? {} : { isBusy: ctx.appState.isSessionBusy }),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

export function openUpdateMenu(ctx: SlashCommandContext): boolean {
  const inPlace = inPlaceFromContext(ctx);
  return openLocalJsxCommand(ctx, close => <UpdateMenu close={close} stateRepository={requireCommandConfigStore(ctx).stateRepository} {...(inPlace === undefined ? {} : { inPlace })} />);
}

export function hasSkippedUpdate(version: string, repository?: RuntimeStateRepository): boolean {
  return getRuntimeState(repository).skippedUpdateVersion === version;
}
