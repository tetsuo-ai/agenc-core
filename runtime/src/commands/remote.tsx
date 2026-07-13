import React, { useEffect, useState } from "react";

import { Box, Text, useInput } from "../tui/ink.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type {
  SlashCommand,
  SlashCommandContext,
  SlashCommandResult,
} from "./types.js";
import { runRemoteSlash, startRemoteOn } from "../bin/remote-cli.js";

/** Persistent pairing surface: shows the code + QR and stays until the phone pairs (then auto-
 *  closes with a confirmation), or until the user presses q/Esc. */
function RemotePairModal(props: {
  box: string;
  waitForConnect: () => Promise<string>;
  onDone: () => void;
}): React.ReactElement {
  const { box, waitForConnect, onDone } = props;
  const [linked, setLinked] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || input === "q") onDone();
  });

  useEffect(() => {
    let cancelled = false;
    void waitForConnect()
      .then((who) => {
        if (cancelled) return;
        if (who) {
          setLinked(who);
          setTimeout(() => onDone(), 1800);
        } else {
          onDone();
        }
      })
      .catch(() => {
        if (!cancelled) onDone(); // never leave the QR surface hanging
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (linked !== null) {
    return (
      <Box paddingX={1} borderStyle="round">
        <Text>✓ Linked with {linked} — drive this Mac from your phone.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round">
      <Text>{box}</Text>
      <Text dimColor>q / Esc to hide · stays until your phone pairs</Text>
    </Box>
  );
}

/**
 * `/remote [on|off|status]` — link this Mac to the AgenC phone app from inside an agent session.
 * `on` shows a code + QR as a PERSISTENT surface (it does not vanish after a few seconds) and
 * auto-closes the moment the phone pairs. `status`/`off` inspect or forget the pairing.
 */
export const remoteCommand: SlashCommand = {
  name: "remote",
  description: "Link this Mac to the AgenC phone app",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx: SlashCommandContext): Promise<SlashCommandResult> => {
    const sub = (ctx.argsRaw || "").trim() || "on";
    if (sub !== "on") {
      return { kind: "text", text: await runRemoteSlash(ctx.argsRaw) };
    }

    const started = await startRemoteOn();
    if ("message" in started) {
      return { kind: "text", text: started.message };
    }

    const shown = openLocalJsxCommand(
      ctx,
      (close) => (
        <RemotePairModal
          box={started.box}
          waitForConnect={started.waitForConnect}
          onDone={close}
        />
      ),
      { shouldHidePromptInput: false },
    );
    if (!shown) {
      // Headless / no TUI surface — fall back to plain text.
      return { kind: "text", text: started.box };
    }
    return { kind: "skip" };
  },
};

