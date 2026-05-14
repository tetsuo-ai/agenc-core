import type { AgenCThinkingBlockParam } from '../../../types/message.js';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { Box, Text } from '../../ink.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { Markdown } from '../markdown/Markdown.js';
type Props = {
  param: AgenCThinkingBlockParam;
  addMargin: boolean;
  isTranscriptMode: boolean;
  verbose: boolean;
  /** When true, hide this thinking block entirely (used for past thinking in transcript mode) */
  hideInTranscript?: boolean;
};
function thinkingLabel(prefix: string): string {
  return prefix.length > 0 ? `${prefix} Thinking` : 'Thinking';
}

export function AssistantThinkingMessage({
  param,
  addMargin = false,
  isTranscriptMode,
  verbose,
  hideInTranscript = false,
}: Props) {
  const { thinking } = param;
  if (!thinking) {
    return null;
  }
  if (hideInTranscript) {
    return null;
  }
  const glyphs = selectAgenCTuiGlyphs();
  const label = thinkingLabel(glyphs.thinkingPrefix);
  const shouldShowFullThinking = isTranscriptMode || verbose;
  if (!shouldShowFullThinking) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <Text dimColor={true} italic={true}>{label} <CtrlOToExpand /></Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      <Text dimColor={true} italic={true}>{label}{glyphs.thinkingEllipsis}</Text>
      <Box paddingLeft={2}>
        <Markdown dimColor={true}>{thinking}</Markdown>
      </Box>
    </Box>
  );
}
