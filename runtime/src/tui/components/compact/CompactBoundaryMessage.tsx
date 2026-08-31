import { c as _c } from "react-compiler-runtime";
import { Box, Text } from '../../ink.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
export function CompactBoundaryMessage(props: {
  readonly attemptId?: string;
} = {}) {
  const $ = _c(3);
  const historyShortcut = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  const attemptId = props.attemptId;
  let t0;
  if ($[0] !== attemptId || $[1] !== historyShortcut) {
    t0 = <Box flexDirection="column" marginY={1}><Text dimColor={true}>✻ Conversation compacted ({historyShortcut} for history)</Text>{attemptId === undefined ? null : <Text dimColor={true}>  Rollback attempt ID: {attemptId}</Text>}</Box>;
    $[0] = attemptId;
    $[1] = historyShortcut;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  return t0;
}
