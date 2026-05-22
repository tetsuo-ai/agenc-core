import { Box } from "../ink.js";
import { usePromptOverlay, usePromptOverlayDialog } from "../context/promptOverlayContext.js";
import PromptInputFooterSuggestions from "./PromptInput/PromptInputFooterSuggestions.js";

export function PromptSuggestionsOverlay(): React.ReactElement | null {
  const data = usePromptOverlay();
  if (!data || data.suggestions.length === 0) {
    return null;
  }

  return (
    <Box
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      paddingX={0}
      paddingTop={1}
      flexDirection="column"
      opaque={true}
      backgroundColor="surfaceBackground"
    >
      <PromptInputFooterSuggestions
        suggestions={data.suggestions}
        selectedSuggestion={data.selectedSuggestion}
        maxColumnWidth={data.maxColumnWidth}
        suggestionType={data.suggestionType}
        overlay={true}
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
