// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDebounceCallback } from 'usehooks-ts';
import { addDirHelpMessage, validateDirectoryForWorkspace } from '../../../../commands/add-dir/validation';
import TextInput from '../../TextInput';
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js';
import { Box, Text } from '../../../ink.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import type { ToolPermissionContext } from '../../../../tools/Tool';
import { getDirectoryCompletions } from '../../../../utils/suggestions/directoryCompletion'; // upstream-import: keep target is owned by another Z-PURGE item
import { ConfigurableShortcutHint } from '../../ConfigurableShortcutHint';
import { Select } from '../../CustomSelect/select';
import { Byline } from '../../design-system/Byline';
import { Dialog } from '../../design-system/Dialog';
import { KeyboardShortcutHint } from '../../design-system/KeyboardShortcutHint';
import { PromptInputFooterSuggestions, type SuggestionItem } from '../../PromptInput/PromptInputFooterSuggestions.js';
type Props = {
  onAddDirectory: (path: string, remember?: boolean) => void;
  onCancel: () => void;
  permissionContext: ToolPermissionContext;
  directoryPath?: string; // When directoryPath is provided, show selection options instead of input
};
type RememberDirectoryOption = 'yes-session' | 'yes-remember' | 'no';
const REMEMBER_DIRECTORY_OPTIONS: Array<{
  value: RememberDirectoryOption;
  label: string;
}> = [{
  value: 'yes-session',
  label: 'Yes, for this session'
}, {
  value: 'yes-remember',
  label: 'Yes, and remember this directory'
}, {
  value: 'no',
  label: 'No'
}];
export function getAddWorkspaceDirectoryInputColumns(columns: number): number {
  const safeColumns = Number.isFinite(columns)
    ? Math.max(0, Math.trunc(columns))
    : 0;
  return Math.max(1, safeColumns - 10);
}
function PermissionDescription() {
  const $ = _c(1);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <Text dimColor={true}>AgenC will be able to read files in this directory and make edits when auto-accept edits is on.</Text>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
function DirectoryDisplay(t0) {
  const $ = _c(5);
  const {
    path
  } = t0;
  let t1;
  if ($[0] !== path) {
    t1 = <Text color="permission">{path}</Text>;
    $[0] = path;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <PermissionDescription />;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== t1) {
    t3 = <Box flexDirection="column" paddingX={2} gap={1}>{t1}{t2}</Box>;
    $[3] = t1;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  return t3;
}
function DirectoryInput({
  value,
  onChange,
  onSubmit,
  error,
  suggestions,
  selectedSuggestion,
  columns,
}) {
  return (
    <Box flexDirection="column">
      <Text>Enter the path to the directory:</Text>
      <Box borderDimColor={true} borderStyle="round" marginY={1} paddingLeft={1}>
        <TextInput
          showCursor={true}
          placeholder={`Directory path${figures.ellipsis}`}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          columns={columns}
          cursorOffset={value.length}
          onChangeCursorOffset={_temp}
        />
      </Box>
      {suggestions.length > 0 && (
        <Box marginBottom={1}>
          <PromptInputFooterSuggestions
            suggestions={suggestions}
            selectedSuggestion={selectedSuggestion}
          />
        </Box>
      )}
      {error && <Text color="error">{error}</Text>}
    </Box>
  );
}
function _temp() {}
export function AddWorkspaceDirectory(t0) {
  const $ = _c(34);
  const {
    onAddDirectory,
    onCancel,
    permissionContext,
    directoryPath
  } = t0;
  const [directoryInput, setDirectoryInput] = useState("");
  const [error, setError] = useState(null);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [suggestions, setSuggestions] = useState(t1);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  let t2;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = async path => {
      if (!path) {
        setSuggestions([]);
        setSelectedSuggestion(0);
        return;
      }
      const completions = await getDirectoryCompletions(path);
      setSuggestions(completions);
      setSelectedSuggestion(0);
    };
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const fetchSuggestions = t2;
  const debouncedFetchSuggestions = useDebounceCallback(fetchSuggestions, 100);
  let t3;
  let t4;
  if ($[2] !== debouncedFetchSuggestions || $[3] !== directoryInput) {
    t3 = () => {
      debouncedFetchSuggestions(directoryInput);
    };
    t4 = [directoryInput, debouncedFetchSuggestions];
    $[2] = debouncedFetchSuggestions;
    $[3] = directoryInput;
    $[4] = t3;
    $[5] = t4;
  } else {
    t3 = $[4];
    t4 = $[5];
  }
  useEffect(t3, t4);
  let t5;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = suggestion => {
      const newPath = suggestion.id + "/";
      setDirectoryInput(newPath);
      setError(null);
    };
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  const applySuggestion = t5;
  let t6;
  if ($[7] !== onAddDirectory || $[8] !== permissionContext) {
    t6 = async newPath_0 => {
      const result = await validateDirectoryForWorkspace(newPath_0, permissionContext);
      if (result.resultType === "success") {
        onAddDirectory(result.absolutePath, false);
      } else {
        setError(addDirHelpMessage(result));
      }
    };
    $[7] = onAddDirectory;
    $[8] = permissionContext;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  const handleSubmit = t6;
  let t7;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = {
      context: "Settings"
    };
    $[10] = t7;
  } else {
    t7 = $[10];
  }
  useKeybinding("confirm:no", onCancel, t7);
  const {
    columns
  } = useTerminalSize();
  const directoryInputColumns = getAddWorkspaceDirectoryInputColumns(columns);
  let t8;
  if ($[11] !== handleSubmit || $[12] !== selectedSuggestion || $[13] !== suggestions) {
    t8 = e => {
      if (suggestions.length > 0) {
        if (e.key === "tab") {
          e.preventDefault();
          const suggestion_0 = suggestions[selectedSuggestion];
          if (suggestion_0) {
            applySuggestion(suggestion_0);
          }
          return;
        }
        if (e.key === "return") {
          e.preventDefault();
          const suggestion_1 = suggestions[selectedSuggestion];
          if (suggestion_1) {
            handleSubmit(suggestion_1.id + "/");
          }
          return;
        }
        if (e.key === "up" || e.ctrl && e.key === "p") {
          e.preventDefault();
          setSelectedSuggestion(prev => prev <= 0 ? suggestions.length - 1 : prev - 1);
          return;
        }
        if (e.key === "down" || e.ctrl && e.key === "n") {
          e.preventDefault();
          setSelectedSuggestion(prev_0 => prev_0 >= suggestions.length - 1 ? 0 : prev_0 + 1);
          return;
        }
      }
    };
    $[11] = handleSubmit;
    $[12] = selectedSuggestion;
    $[13] = suggestions;
    $[14] = t8;
  } else {
    t8 = $[14];
  }
  const handleKeyDown = t8;
  let t9;
  if ($[15] !== directoryPath || $[16] !== onAddDirectory || $[17] !== onCancel) {
    t9 = value => {
      if (!directoryPath) {
        return;
      }
      const selectionValue = value as RememberDirectoryOption;
      bb64: switch (selectionValue) {
        case "yes-session":
          {
            onAddDirectory(directoryPath, false);
            break bb64;
          }
        case "yes-remember":
          {
            onAddDirectory(directoryPath, true);
            break bb64;
          }
        case "no":
          {
            onCancel();
          }
      }
    };
    $[15] = directoryPath;
    $[16] = onAddDirectory;
    $[17] = onCancel;
    $[18] = t9;
  } else {
    t9 = $[18];
  }
  const handleSelect = t9;
  const t10 = directoryPath ? undefined : _temp2;
  const t11 = directoryPath ? <Box flexDirection="column" gap={1}><DirectoryDisplay path={directoryPath} /><Select options={REMEMBER_DIRECTORY_OPTIONS} onChange={handleSelect} onCancel={() => handleSelect("no")} /></Box> : <Box flexDirection="column" gap={1} marginX={2}><PermissionDescription /><DirectoryInput value={directoryInput} onChange={setDirectoryInput} onSubmit={handleSubmit} error={error} suggestions={suggestions} selectedSuggestion={selectedSuggestion} columns={directoryInputColumns} /></Box>;
  let t12;
  if ($[27] !== onCancel || $[28] !== t10 || $[29] !== t11) {
    t12 = <Dialog title="Add directory to workspace" onCancel={onCancel} color="permission" isCancelActive={false} inputGuide={t10}>{t11}</Dialog>;
    $[27] = onCancel;
    $[28] = t10;
    $[29] = t11;
    $[30] = t12;
  } else {
    t12 = $[30];
  }
  let t13;
  if ($[31] !== handleKeyDown || $[32] !== t12) {
    t13 = <Box flexDirection="column" tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{t12}</Box>;
    $[31] = handleKeyDown;
    $[32] = t12;
    $[33] = t13;
  } else {
    t13 = $[33];
  }
  return t13;
}
function _temp2(exitState) {
  return exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline><KeyboardShortcutHint shortcut="Tab" action="complete" /><KeyboardShortcutHint shortcut="Enter" action="add" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" /></Byline>;
}
