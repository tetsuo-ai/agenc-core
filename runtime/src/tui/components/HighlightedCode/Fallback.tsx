import React, { useMemo } from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { renderPlainCodeLines } from "../../render/code-highlight.js";

export interface HighlightedCodeFallbackProps {
  readonly code: string;
  readonly width?: number;
  readonly dim?: boolean;
}

export const HighlightedCodeFallback: React.FC<HighlightedCodeFallbackProps> = ({
  code,
  width,
  dim = false,
}) => {
  const lines = useMemo(() => renderPlainCodeLines(code, width), [code, width]);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`fallback-${index}`} dimColor={dim}>
          {line.plainText}
        </Text>
      ))}
    </Box>
  );
};

export default HighlightedCodeFallback;
