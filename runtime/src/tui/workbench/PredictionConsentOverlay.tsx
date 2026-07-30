import React from "react";

import { Box, Text } from "../ink.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import { useRegisterKeybindingContext } from "../keybindings/KeybindingContext.js";
import { useInputCapture } from "../keybindings/useKeybinding.js";

export function PredictionConsentOverlay({
  onAllow,
  onDecline,
  onDismiss,
}: {
  readonly onAllow: () => Promise<void>;
  readonly onDecline: () => Promise<void>;
  readonly onDismiss: () => void;
}): React.ReactElement {
  const [pending, setPending] = React.useState<"allow" | "decline" | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  useRegisterOverlay("editor-code-prediction-consent", true);
  useRegisterKeybindingContext("Modal", true);

  const decide = React.useCallback(
    (decision: "allow" | "decline"): void => {
      if (pending !== null) return;
      setPending(decision);
      setError(null);
      const action = decision === "allow" ? onAllow : onDecline;
      void action()
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          setPending(null);
        });
    },
    [onAllow, onDecline, pending],
  );

  useInputCapture(
    React.useCallback(
      (input, key) => {
        const normalized = input.toLowerCase();
        const isConsentChoice =
          key.meta && !key.escape && (normalized === "y" || normalized === "n");
        if (pending !== null) {
          // Persistence cannot be cancelled once it is in flight. Consume
          // repeated consent choices without changing the pending decision,
          // but never drop ordinary Neovim input—including Escape—while the
          // durable config/reload work finishes.
          return isConsentChoice;
        }
        // This prompt can appear while the user is already typing in Neovim.
        // Only deliberate Alt-modified choices may persist consent; ordinary
        // text and Enter must continue through to the editor unchanged.
        if (isConsentChoice && normalized === "y") {
          decide("allow");
          return true;
        }
        if (isConsentChoice && normalized === "n") {
          decide("decline");
          return true;
        }
        if (key.escape) {
          onDismiss();
        }
        return false;
      },
      [decide, onDismiss, pending],
    ),
    { context: "Modal", isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Text bold>Enable editor code predictions?</Text>
      <Text wrap="wrap">
        AgenC will send the current source prefix and suffix to your configured
        model as you type. Predictions stay out of the conversation transcript.
      </Text>
      <Text color="warning">
        {pending === "allow"
          ? "Enabling…"
          : pending === "decline"
            ? "Disabling…"
            : "Alt+Y enable  Alt+N keep off  Esc ask later"}
      </Text>
      {error !== null ? <Text color="error">{error}</Text> : null}
    </Box>
  );
}
