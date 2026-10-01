import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "../tui/ink.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";

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
        <Text>✓ Linked with {linked} — drive this computer from your phone.</Text>
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

export function openRemotePairMenu(
  ctx: SlashCommandContext,
  started: { box: string; waitForConnect: () => Promise<string> },
): boolean {
  return openLocalJsxCommand(
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
}
