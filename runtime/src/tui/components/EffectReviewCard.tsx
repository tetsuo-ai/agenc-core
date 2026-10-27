import React, { useRef, useState } from "react";
import { summarizeToolError } from "../tool-error-text.js";
import { Box, Text } from "../ink.js";
import { useInputCapture } from "../keybindings/useKeybinding.js";
import type { PendingEffectReview } from "../../app-server/protocol/index.js";
import type { ResolveDaemonToolCallParams } from "../../commands/resolve.js";

export function EffectReviewCard({ review, resolve, active = true }: {
  readonly review: PendingEffectReview;
  readonly resolve: (params: ResolveDaemonToolCallParams) => Promise<unknown>;
  readonly active?: boolean;
}) {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useInputCapture((input, key) => {
    if (!active || key.ctrl || key.meta || !["1", "2", "3"].includes(input)) return false;
    if (!submitting.current) {
      submitting.current = true;
      setBusy(true);
      setError(null);
      const disposition = input === "1" ? "confirmed_no_effect" :
        input === "2" ? "confirmed_committed" : "remains_unknown";
      void resolve({ toolCallId: review.callId, disposition, attestation: "operator",
        ...(review.sessionId !== undefined ? { effectSessionId: review.sessionId } : {}),
      })
        .then(() => { if (disposition === "remains_unknown") submitting.current = false; })
        .catch((err: unknown) => {
          submitting.current = false;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(false));
    }
    return true;
  }, { context: "Modal" });
  return <Box flexDirection="column" borderStyle="single" borderColor="warning" paddingX={1}>
    <Text color="warning" bold wrap="truncate">Review needed: {review.toolName} {review.description.replace(/\s+/gu, " ")}</Text>
    <Text wrap="truncate">{summarizeToolError(review.error)}</Text>
    {review.sessionId !== undefined ? <Text wrap="truncate">Owning session: {review.sessionId}</Text> : null}
    <Text>1 It had no effect · 2 It took effect · 3 Keep blocked</Text>
    <Text dimColor>{busy ? "Recording review..." : review.blocksSession === false
      ? "Child mutations stay blocked. Press 1, 2, or 3 with an empty prompt."
      : "Prompts stay queued. Press 1, 2, or 3 with an empty prompt."}</Text>
    {error !== null ? <Text color="error">{error}</Text> : null}
  </Box>;
}
