import React from "react";

import { OnboardingBox as Box, OnboardingText as Text } from "./elements.js";
import type { VerificationStatus } from "./useApiKeyVerification.js";

export interface ApproveApiKeyProps {
  readonly provider: string;
  readonly maskedTail: string;
  readonly status: VerificationStatus;
  readonly error?: string;
  readonly pasteHash?: string;
}

export function maskedApiKeyTail(apiKey: string): string {
  const trimmed = apiKey.trim();
  const tail = trimmed.slice(-4);
  return tail.length > 0 ? `...${tail}` : "...";
}

export function ApproveApiKey({
  provider,
  maskedTail,
  status,
  error,
  pasteHash,
}: ApproveApiKeyProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Approve BYOK API key</Text>
      <Text dimColor>Provider: {provider}</Text>
      <Text dimColor>Key tail: {maskedTail}</Text>
      <Text dimColor>Verification: {status}</Text>
      {pasteHash !== undefined ? (
        <Text dimColor>Private paste cache: {pasteHash}</Text>
      ) : null}
      {error !== undefined ? <Text>{error}</Text> : null}
      <Text>Type yes to save this key, or no to continue without saving.</Text>
    </Box>
  );
}

export default ApproveApiKey;
