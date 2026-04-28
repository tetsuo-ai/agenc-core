/**
 * Composer footer notifications.
 *
 * Reads the active inline-toast queue (`useNotificationsState`) and
 * renders the current entry, plus a small set of static informational
 * notices (debug-mode flag, missing-credentials, verbose token count).
 *
 * Ported from upstream. Upstream's `Notifications` widget pulls in a
 * large surface of product features (voice indicator, IDE bridge
 * status, auto-updater, sandbox hint, vendor usage limits) that
 * AgenC does not ship today. Those branches are dropped from the
 * port; the seam is the `notifications.current` render plus the
 * informational rows. When AgenC adds those features, they should
 * surface through the notifications context (so this component does
 * not need to re-grow into a feature dispatcher) or by adding new
 * sibling rows here.
 *
 * The shown footer is always wrapped in `<Box flexDirection="column"
 * alignItems="flex-end" overflowX="hidden">` to match the upstream
 * footer layout — the parent `<PromptInputFooter>` aligns this
 * column-end against the model/mode indicator on the left.
 */
import * as React from "react";

import { Box, Text } from "../ink-public.js";
import { useNotificationsState } from "../state/NotificationsContext.js";

export const FOOTER_TEMPORARY_STATUS_TIMEOUT = 5000;

export type ApiKeyStatus = "valid" | "invalid" | "missing" | "unknown";

interface Props {
  readonly apiKeyStatus?: ApiKeyStatus;
  readonly debug?: boolean;
  readonly verbose?: boolean;
  readonly tokenUsage?: number;
  readonly isNarrow?: boolean;
}

export function Notifications({
  apiKeyStatus = "unknown",
  debug = false,
  verbose = false,
  tokenUsage,
  isNarrow = false,
}: Props): React.ReactElement {
  const notifications = useNotificationsState();
  const alignment = isNarrow ? "flex-start" : "flex-end";
  const hasInvalidKey =
    apiKeyStatus === "invalid" || apiKeyStatus === "missing";

  return (
    <Box
      flexDirection="column"
      alignItems={alignment}
      flexShrink={0}
      overflowX="hidden"
    >
      {notifications.current &&
        ("jsx" in notifications.current ? (
          <Text wrap="truncate" key={notifications.current.key}>
            {notifications.current.jsx}
          </Text>
        ) : (
          <Text
            color={notifications.current.color}
            dimColor={!notifications.current.color}
            wrap="truncate"
            key={notifications.current.key}
          >
            {notifications.current.text}
          </Text>
        ))}

      {hasInvalidKey && (
        <Box>
          <Text color="error" wrap="truncate">
            Not logged in · Run /login
          </Text>
        </Box>
      )}

      {debug && (
        <Box>
          <Text color="warning" wrap="truncate">
            Debug mode
          </Text>
        </Box>
      )}

      {!hasInvalidKey && verbose && typeof tokenUsage === "number" && (
        <Box>
          <Text dimColor wrap="truncate">
            {tokenUsage} tokens
          </Text>
        </Box>
      )}
    </Box>
  );
}

export default Notifications;
