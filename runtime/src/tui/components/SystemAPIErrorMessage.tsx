import * as React from "react";
import { useState } from "react";
import { Box, Text, useInterval } from "../ink.js";
import { formatAPIError } from "../../errors/api.js";
import type { AgenCSystemAPIErrorMessage } from "../../errors/api.js";

const MAX_API_ERROR_CHARS = 1000;

type Props = {
  readonly message: AgenCSystemAPIErrorMessage;
  readonly verbose: boolean;
};

function MessageResponse({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Text dimColor={true}>{"  "}⎿  </Text>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

function CtrlOToExpand(): React.ReactNode {
  return <Text dimColor={true}>(ctrl+o to expand)</Text>;
}

export function SystemAPIErrorMessage({
  message,
  verbose,
}: Props): React.ReactNode {
  const { retryAttempt, error, retryInMs, maxRetries } = message;
  const hidden = retryAttempt < 4;
  const [countdownMs, setCountdownMs] = useState(0);
  const done = countdownMs >= retryInMs;

  useInterval(
    () => setCountdownMs((ms) => ms + 1000),
    hidden || done ? null : 1000,
  );

  if (hidden) return null;

  const retryInSeconds = Math.max(
    0,
    Math.round((retryInMs - countdownMs) / 1000),
  );
  const formatted = formatAPIError(error);
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS;
  const displayed = truncated
    ? `${formatted.slice(0, MAX_API_ERROR_CHARS)}...`
    : formatted;
  const secondsLabel = retryInSeconds === 1 ? "second" : "seconds";

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{displayed}</Text>
        {truncated && <CtrlOToExpand />}
        <Text dimColor={true}>
          Retrying in {retryInSeconds} {secondsLabel}... (attempt{" "}
          {retryAttempt}/{maxRetries})
          {process.env.API_TIMEOUT_MS
            ? ` - API_TIMEOUT_MS=${process.env.API_TIMEOUT_MS}ms, try increasing it`
            : ""}
        </Text>
      </Box>
    </MessageResponse>
  );
}
