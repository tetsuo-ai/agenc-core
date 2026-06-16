import { c as _c } from "react-compiler-runtime";
import { type Command, formatDescriptionWithSource } from '../../../commands.js';
import { compareHelpWorkflowCommands, helpWorkflowTitleForCommand } from '../../../commands/help-groups.js';
import { Box, Text } from '../../ink.js';
import { truncate } from '../../../utils/format.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { sanitizeSuggestionMetadataText } from '../../../utils/suggestions/sanitizeSuggestionMetadataText.js';
import { Select } from '../CustomSelect/select.js';
import { useTabHeaderFocus } from '../design-system/Tabs.js';
import { calculateCommandVisibleOptionCount } from './layout.js';
type Props = {
  commands: Command[];
  maxHeight: number;
  columns: number;
  title: string;
  onCancel: () => void;
  emptyMessage?: string;
};
export function Commands(t0: Props) {
  const $ = _c(14);
  const {
    commands,
    maxHeight,
    columns,
    title,
    onCancel,
    emptyMessage
  } = t0;
  const {
    headerFocused,
    focusHeader
  } = useTabHeaderFocus();
  const maxWidth = Math.max(1, columns - 10);
  const visibleCount = calculateCommandVisibleOptionCount(maxHeight);
  let t1;
  if ($[0] !== commands || $[1] !== maxWidth) {
    const seen = new Set<string>();
    let t2;
    if ($[3] !== maxWidth) {
      t2 = (cmd_0: Command) => ({
        label: `/${cmd_0.name}`,
        value: cmd_0.name,
        description: truncate(
          sanitizeSuggestionMetadataText(`${helpWorkflowTitleForCommand(cmd_0)} - ${formatDescriptionWithSource(cmd_0)}`),
          maxWidth,
          true
        )
      });
      $[3] = maxWidth;
      $[4] = t2;
    } else {
      t2 = $[4];
    }
    t1 = commands.filter((cmd: Command) => {
      if (seen.has(cmd.name)) {
        return false;
      }
      seen.add(cmd.name);
      return true;
    }).sort(compareHelpWorkflowCommands).map(t2);
    $[0] = commands;
    $[1] = maxWidth;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const options = t1;
  let t2;
  if ($[5] !== commands.length || $[6] !== emptyMessage || $[7] !== focusHeader || $[8] !== headerFocused || $[9] !== onCancel || $[10] !== options || $[11] !== title || $[12] !== visibleCount) {
    t2 = <Box flexDirection="column" paddingY={1}>{commands.length === 0 && emptyMessage ? <Text dimColor={true}>{emptyMessage}</Text> : <><Text>{title}</Text>{visibleCount > 0 ? <Box marginTop={1}><Select options={options} visibleOptionCount={visibleCount} onCancel={onCancel} disableSelection={true} hideIndexes={true} layout="compact-vertical" onUpFromFirstItem={focusHeader} isDisabled={headerFocused} /></Box> : <Box marginTop={1}><Text dimColor={true} wrap="truncate">Terminal too small to browse commands</Text></Box>}</>}</Box>;
    $[5] = commands.length;
    $[6] = emptyMessage;
    $[7] = focusHeader;
    $[8] = headerFocused;
    $[9] = onCancel;
    $[10] = options;
    $[11] = title;
    $[12] = visibleCount;
    $[13] = t2;
  } else {
    t2 = $[13];
  }
  return t2;
}
