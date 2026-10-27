import { Box } from "../ink.js";
import { usePromptOverlay, usePromptOverlayDialog } from "../context/promptOverlayContext.js";
import PromptInputFooterSuggestions from "./PromptInput/PromptInputFooterSuggestions.js";

/**
 * Fullscreen suggestion list, laid out in the normal flow directly under the
 * bottom slot (so under the prompt) and above the status line. It sits
 * outside the slot's clip; the transcript gives up the rows it takes.
 */
export function PromptSuggestionsList({
  availableColumns,
  availableRows,
}: {
  readonly availableColumns?: number;
  readonly availableRows?: number;
}): React.ReactElement | null {
  const data = usePromptOverlay();
  if (!data || data.suggestions.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <PromptInputFooterSuggestions
        suggestions={data.suggestions}
        selectedSuggestion={data.selectedSuggestion}
        maxColumnWidth={data.maxColumnWidth}
        availableColumns={availableColumns}
        availableRows={availableRows}
      />
    </Box>
  );
}

export function PromptDialogOverlay(): React.ReactElement | null {
  const node = usePromptOverlayDialog();
  if (!node) {
    return null;
  }

  return (
    <Box
      position="absolute"
      top={2}
      bottom={1}
      left={4}
      right={4}
      flexDirection="column"
      justifyContent="center"
      opaque={true}
    >
      {node}
    </Box>
  );
}
