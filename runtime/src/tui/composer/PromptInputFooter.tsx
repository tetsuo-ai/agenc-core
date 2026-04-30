import * as React from "react";
import { memo, type ReactNode } from "react";

import { Box } from "../ink-public.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { Notifications, type ApiKeyStatus } from "./Notifications.js";
import {
  PromptInputFooterLeftSide,
  type VimMode,
} from "./PromptInputFooterLeftSide.js";
import {
  PromptInputFooterSuggestions,
  type SuggestionItem,
} from "./PromptInputFooterSuggestions.js";
import { PromptInputHelpMenu } from "./PromptInputHelpMenu.js";
import type { PromptInputMode } from "./inputModes.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { Color } from "../ink/styles.js";

type Props = {
  readonly debug?: boolean;
  readonly apiKeyStatus?: ApiKeyStatus;
  readonly exitMessage: { readonly show: boolean; readonly key?: string };
  readonly vimMode?: VimMode;
  readonly mode: PromptInputMode;
  readonly permissionMode: PermissionMode;
  readonly verbose?: boolean;
  readonly suggestions: readonly SuggestionItem[];
  readonly selectedSuggestion: number;
  readonly maxColumnWidth?: number;
  readonly helpOpen: boolean;
  readonly suppressHint: boolean;
  readonly isLoading: boolean;
  readonly isPasting?: boolean;
  readonly isInputWrapped?: boolean;
  readonly isSearching: boolean;
  readonly status?: { readonly color: Color; readonly text: string } | null;
  readonly pendingRequestCount?: number;
};

function PromptInputFooter({
  apiKeyStatus,
  debug,
  exitMessage,
  vimMode,
  mode,
  permissionMode,
  verbose,
  suggestions,
  selectedSuggestion,
  maxColumnWidth,
  helpOpen,
  suppressHint,
  isLoading,
  isPasting,
  isSearching,
  status,
  pendingRequestCount = 0,
}: Props): ReactNode {
  const { columns } = useTerminalSize();
  const isNarrow = columns < 80;

  // Forward suggestion data to the floating overlay so a fullscreen
  // shell can render it above the composer instead of inline. AgenC's
  // OverlayProvider rewires the slot when it owns the screen; in the
  // common embedded case the hook is a no-op and we render inline.
  if (suggestions.length > 0) {
    return (
      <Box paddingX={2} paddingY={0}>
        <PromptInputFooterSuggestions
          suggestions={suggestions}
          selectedSuggestion={selectedSuggestion}
          maxColumnWidth={maxColumnWidth}
        />
      </Box>
    );
  }

  if (helpOpen) {
    return <PromptInputHelpMenu dimColor fixedWidth paddingX={2} />;
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width="100%"
    >
      <Box
      flexDirection={isNarrow ? "column" : "row"}
      justifyContent={isNarrow ? "flex-start" : "space-between"}
      paddingX={2}
      gap={isNarrow ? 0 : 1}
      >
        <Box flexDirection="column" flexShrink={isNarrow ? 0 : 1}>
          <PromptInputFooterLeftSide
            exitMessage={exitMessage}
            vimMode={vimMode}
            mode={mode}
            permissionMode={permissionMode}
            suppressHint={suppressHint || isSearching}
            isLoading={isLoading}
            isPasting={isPasting}
            isSearching={isSearching}
            status={status}
            pendingRequestCount={pendingRequestCount}
          />
        </Box>
        <Box flexShrink={1} gap={1}>
          <Notifications
            apiKeyStatus={apiKeyStatus}
            debug={debug}
            verbose={verbose}
            isNarrow={isNarrow}
          />
        </Box>
      </Box>
    </Box>
  );
}

export default memo(PromptInputFooter);
