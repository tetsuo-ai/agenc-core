import React from "react";
import { useInput } from "../ink.js";
import { isAutoUpdaterDisabled } from "../../utils/config.js";
import type { ConfigStore } from "../../config/store.js";
import type { ToolJSXArgs } from "../tool-jsx-state.js";

// A process can remount its TUI (for example /resume). Check once per launch.
let launchCheck: Promise<import("../../commands/update-menu.js").UpdateCheck | null> | undefined;
export function useStartupUpdate({ safe, setToolJSX, configStore, inPlace }: {
  safe: boolean;
  configStore: ConfigStore;
  setToolJSX: (value: ToolJSXArgs | null) => void;
  /** Lets "Update now" come back on the new version in this conversation. */
  inPlace?: import("../../commands/update-menu.js").UpdateMenuRelaunch;
}) {
  const inPlaceRef = React.useRef(inPlace);
  inPlaceRef.current = inPlace;
  const safeRef = React.useRef(safe);
  safeRef.current = safe;
  // Track typing through Ink's own input dispatch. A second raw
  // process.stdin "data" listener next to Ink's "readable" reader could leave
  // stdin flowing after the TUI paused and resumed it (for example around
  // /resume), so every later key went only to that listener and the composer
  // stopped receiving input.
  const lastKeyRef = React.useRef(Date.now());
  useInput(() => {
    lastKeyRef.current = Date.now();
  });
  React.useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI || isAutoUpdaterDisabled(configStore.current())) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Start after the first committed screen; never await this in boot.
    timer = setTimeout(() => {
      launchCheck ??= import("../../bin/update-cli.js")
        .then(({ checkAgenCUpdate }) => checkAgenCUpdate(undefined, { manifestTimeoutMs: 3000 }))
        .catch(() => null);
      void launchCheck.then(async checked => {
        if (!active || !checked?.updateAvailable) return;
        const { UpdateMenu, hasSkippedUpdate, resumableConversationId } = await import("../../commands/update-menu.js");
        if (!active || hasSkippedUpdate(checked.latestVersion, configStore.stateRepository)) return;
        const showWhenIdle = () => {
          if (!active || isAutoUpdaterDisabled(configStore.current())) return;
          if (!safeRef.current || Date.now() - lastKeyRef.current < 1200) {
            timer = setTimeout(showWhenIdle, 250); return;
          }
          // Consume the launch result before the popup can remount this hook.
          launchCheck = Promise.resolve(null);
          const current = inPlaceRef.current;
          // Read the conversation when the popup opens, not at mount.
          const inPlaceNow = current === undefined ? undefined : {
            ...current,
            conversationId: resumableConversationId(current.conversationId),
          };
          setToolJSX({ isLocalJSXCommand: true, shouldHidePromptInput: true,
            jsx: <UpdateMenu checked={checked} startup stateRepository={configStore.stateRepository} {...(inPlaceNow === undefined ? {} : { inPlace: inPlaceNow })} close={() => setToolJSX({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true })} /> });
        };
        showWhenIdle();
      }).catch(() => {});
    }, 0);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [setToolJSX, configStore]);
}
