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

export type UpdateCheck = Awaited<ReturnType<typeof checkAgenCUpdate>>;
export const NPM_UPDATE_COMMAND = "npm install -g @tetsuo-ai/agenc@latest";

export function UpdateMenu({ checked: initial, startup = false, close, stateRepository }: {
  checked?: UpdateCheck; startup?: boolean; close: () => void; stateRepository?: RuntimeStateRepository;
}) {
  const [checked, setChecked] = React.useState(initial);
  const [installType, setInstallType] = React.useState("checking");
  const wrapper = React.useRef<string | undefined>(undefined);
  const [message, setMessage] = React.useState(initial ? "" : "Checking for updates.");
  const [index, setIndex] = React.useState(0);
  const selected = React.useRef(0);
  const busyRef = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [finished, setFinished] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    if (detectHomebrew()) {
      wrapper.current = undefined;
      setInstallType("Homebrew");
    } else void findActiveGeneratedWrapper().then(found => {
      if (!active) return;
      wrapper.current = found?.path;
      // npm launchers also use private runtimes, but have no generated wrapper.
      setInstallType(found ? (found.kind === "cmd" ? "install.ps1" : "install.sh") : "npm or unmanaged runtime");
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
  }, [initial]);
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
      setFinished(true);
      setMessage(`Run in your terminal: ${HOMEBREW_UPDATE_COMMAND}\nThen launch AgenC again. Its daemon will restart on the new version and restore saved sessions.`);
      return;
    }
    if (!wrapper.current) {
      setFinished(true);
      setMessage(`Run in your terminal: ${NPM_UPDATE_COMMAND}\nFor an unmanaged runtime, rerun the AgenC installer. Then launch AgenC again. Its daemon will restart on the new version and restore saved sessions.`);
      return;
    }
    busyRef.current = true; setBusy(true); setMessage("Checking the release before installing.");
    void runAgenCUpdateCli({ kind: "update", check: false, json: true, wrapper: wrapper.current }, {
      expectedVersion: checked.latestVersion,
      manifestTimeoutMs: 3000,
      onProgress: setMessage,
      stderr: line => { setFailed(true); setMessage(line); },
      stdout: line => {
        const result = JSON.parse(line) as { activated?: boolean; latestVersion: string; retainedVersion?: string };
        setMessage(result.activated
          ? `Installed AgenC ${result.latestVersion}. This session keeps running on ${VERSION}.\nExit AgenC and launch it again to use ${result.latestVersion}. Its daemon will restart on the new version and restore saved sessions.`
          : `The active runtime is ${result.retainedVersion ?? "already current"}. Exit AgenC and launch it again to use it.`);
      },
    }).then(code => {
      busyRef.current = false; setBusy(false); setFinished(true); setFailed(code !== 0);
    }, error => {
      busyRef.current = false; setBusy(false); setFinished(true); setFailed(true); setMessage(sanitizeTerminalText(error));
    });
  };
  const choices = finished || !checked?.updateAvailable ? ["Close"] : [installType === "Homebrew" ? "1 Show brew command" : "1 Update now", "2 Skip this version", "3 Not now"];
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
      {!finished && installType === "Homebrew" && <ThemedText color="text2" wrap="wrap">{`Homebrew manages this installation. Run in your terminal: ${HOMEBREW_UPDATE_COMMAND}`}</ThemedText>}
      {!finished && checked?.updateAvailable && <ThemedText color="text2">{startup ? "Not now asks again on your next launch." : "Skip remembers this version. /update always checks again."}</ThemedText>}
      {message && <ThemedText color={failed ? "error" : "text2"} wrap="wrap">{message}</ThemedText>}
    </Box>}
    footer={busy ? [] : choices.length === 1 ? [{ keyName: "enter", label: "close" }, { keyName: "esc", label: "close" }] : [{ keyName: "1/2/3", label: "choose" }, { keyName: "enter", label: "select" }, { keyName: "esc", label: "not now" }]} />;
}

export function openUpdateMenu(ctx: SlashCommandContext): boolean {
  return openLocalJsxCommand(ctx, close => <UpdateMenu close={close} stateRepository={requireCommandConfigStore(ctx).stateRepository} />);
}

export function hasSkippedUpdate(version: string, repository?: RuntimeStateRepository): boolean {
  return getRuntimeState(repository).skippedUpdateVersion === version;
}
