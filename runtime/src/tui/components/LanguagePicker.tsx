import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React, { useState } from 'react';
import { Box, Text } from '../ink.js';
import { useModalOrTerminalSize } from '../context/modalContext';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import TextInput from './TextInput';
type Props = {
  initialLanguage: string | undefined;
  onComplete: (language: string | undefined) => void;
  onCancel: () => void;
};

export const LANGUAGE_PICKER_PLACEHOLDER = "e.g., Japanese, Spanish, French...";

export function getLanguagePickerInputColumns(columns: number): number {
  return Math.max(1, Math.min(60, columns - 4));
}

export function LanguagePicker(t0) {
  const $ = _c(14);
  const {
    initialLanguage,
    onComplete,
    onCancel
  } = t0;
  const {
    columns
  } = useModalOrTerminalSize(useTerminalSize());
  const inputColumns = getLanguagePickerInputColumns(columns);
  const [language, setLanguage] = useState(initialLanguage);
  const [cursorOffset, setCursorOffset] = useState((initialLanguage ?? "").length);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      context: "Settings"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  useKeybinding("confirm:no", onCancel, t1);
  let t2;
  if ($[1] !== language || $[2] !== onComplete) {
    t2 = function handleSubmit() {
      const trimmed = language?.trim();
      onComplete(trimmed || undefined);
    };
    $[1] = language;
    $[2] = onComplete;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const handleSubmit = t2;
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text>Enter your preferred response and voice language:</Text>;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text>{figures.pointer}</Text>;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  const t5 = language ?? "";
  let t6;
  if ($[6] !== cursorOffset || $[7] !== handleSubmit || $[8] !== inputColumns || $[9] !== t5) {
    t6 = <Box flexDirection="row" gap={1}>{t4}<TextInput value={t5} onChange={setLanguage} onSubmit={handleSubmit} focus={true} showCursor={true} placeholder={LANGUAGE_PICKER_PLACEHOLDER} columns={inputColumns} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} /></Box>;
    $[6] = cursorOffset;
    $[7] = handleSubmit;
    $[8] = inputColumns;
    $[9] = t5;
    $[10] = t6;
  } else {
    t6 = $[10];
  }
  let t7;
  if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = <Text dimColor={true}>Leave empty for default (English)</Text>;
    $[11] = t7;
  } else {
    t7 = $[11];
  }
  let t8;
  if ($[12] !== t6) {
    t8 = <Box flexDirection="column" gap={1}>{t3}{t6}{t7}</Box>;
    $[12] = t6;
    $[13] = t8;
  } else {
    t8 = $[13];
  }
  return t8;
}
