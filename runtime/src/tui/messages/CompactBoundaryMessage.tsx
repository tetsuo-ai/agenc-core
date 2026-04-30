import { c as _c } from "react-compiler-runtime";
import { Box, Text } from "../ink-public.js";
import { getShortcutDisplay } from "../keybindings/shortcutFormat.js";
export function CompactBoundaryMessage() {
  const $ = _c(2);
  const historyShortcut = getShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  let t0;
  if ($[0] !== historyShortcut) {
    t0 = <Box marginY={1}><Text dimColor={true}>✻ Conversation compacted ({historyShortcut} for history)</Text></Box>;
    $[0] = historyShortcut;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  return t0;
}
