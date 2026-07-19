import { c as _c } from "react-compiler-runtime";
import * as path from 'path';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRegisterOverlay } from '../context/overlayContext';
import { generateFileSuggestions } from '../hooks/fileSuggestions';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { useOptionalSetAppState } from '../state/AppState.js';
import { openPreviewCommand } from '../workbench/commands.js';
import { applyWorkbenchCommand, isWorkbenchEnabled } from '../workbench/state.js';
import { Text } from '../ink.js';
import { getCwd } from '../../utils/cwd';
import { openFileInExternalEditor } from '../../utils/editor';
import { truncatePathMiddle, truncateToWidth } from '../../utils/format';
import { highlightMatch } from '../../utils/highlightMatch';
import { logError } from '../../utils/log';
import { readFileInRange } from '../../utils/readFileInRange';
import { FuzzyPicker, computeFuzzyPickerPreviewBudget, computeFuzzyPickerVisibleCount } from './design-system/FuzzyPicker';
import { LoadingState } from './design-system/LoadingState';
type Props = {
  onDone: () => void;
  onInsert: (text: string) => void;
};
const VISIBLE_RESULTS = 8;
const PREVIEW_LINES = 20;

export function computeQuickOpenLayout(columns: number, rows: number) {
  const safeColumns = Math.max(1, Math.floor(columns || 0));
  const safeRows = Math.max(1, Math.floor(rows || 0));
  const previewOnRight = safeColumns >= 120;
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(1, safeRows - 14));
  // Bottom preview: never read more lines than the picker's preview budget —
  // 0 means the picker hides the preview, so skip the file read entirely.
  const effectivePreviewLines = previewOnRight ? Math.max(1, visibleResults - 1) : Math.min(PREVIEW_LINES, computeFuzzyPickerPreviewBudget(safeRows, computeFuzzyPickerVisibleCount(visibleResults, safeRows)));
  const maxPathWidth = previewOnRight ? Math.max(1, Math.floor(Math.max(1, safeColumns - 10) * 0.4)) : Math.max(1, safeColumns - 8);
  const previewWidth = previewOnRight ? Math.max(1, safeColumns - maxPathWidth - 14) : Math.max(1, safeColumns - 6);
  return {
    previewOnRight,
    visibleResults,
    effectivePreviewLines,
    maxPathWidth,
    previewWidth
  };
}

/**
 * Quick Open dialog (ctrl+shift+p / cmd+shift+p).
 * Fuzzy file finder with a syntax-highlighted preview of the focused file.
 */
export function QuickOpenDialog(t0) {
  const $ = _c(35);
  const {
    onDone,
    onInsert
  } = t0;
  const setAppState = useOptionalSetAppState();
  useRegisterOverlay("quick-open");
  const {
    columns,
    rows
  } = useTerminalSize();
  const {
    previewOnRight,
    visibleResults,
    effectivePreviewLines,
    maxPathWidth,
    previewWidth
  } = computeQuickOpenLayout(columns, rows);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [results, setResults] = useState(t1);
  const [query, setQuery] = useState("");
  const [focusedPath, setFocusedPath] = useState(undefined);
  const [preview, setPreview] = useState(null);
  const queryGenRef = useRef(0);
  let t2;
  let t3;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => () => {
      queryGenRef.current = queryGenRef.current + 1;
      return void queryGenRef.current;
    };
    t3 = [];
    $[1] = t2;
    $[2] = t3;
  } else {
    t2 = $[1];
    t3 = $[2];
  }
  useEffect(t2, t3);
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = q => {
      setQuery(q);
      const gen = queryGenRef.current = queryGenRef.current + 1;
      if (!q.trim()) {
        setResults([]);
        return;
      }
      generateFileSuggestions(q, true).then(items => {
        if (gen !== queryGenRef.current) {
          return;
        }
        const paths = items.filter(_temp).map(_temp2).filter(_temp3).map(_temp4);
        setResults(paths);
      }).catch(error => {
        if (gen !== queryGenRef.current) {
          return;
        }
        logError(error);
        setResults([]);
      });
    };
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  const handleQueryChange = t4;
  let t5;
  let t6;
  if ($[4] !== effectivePreviewLines || $[5] !== focusedPath) {
    t5 = () => {
      if (!focusedPath || effectivePreviewLines <= 0) {
        setPreview(null);
        return;
      }
      const controller = new AbortController();
      const absolute = path.resolve(getCwd(), focusedPath);
      readFileInRange(absolute, 0, effectivePreviewLines, undefined, controller.signal).then(r => {
        if (controller.signal.aborted) {
          return;
        }
        setPreview({
          path: focusedPath,
          content: r.content
        });
      }).catch(error => {
        if (controller.signal.aborted) {
          return;
        }
        logError(error);
        setPreview({
          path: focusedPath,
          content: "(preview unavailable)"
        });
      });
      return () => controller.abort();
    };
    t6 = [focusedPath, effectivePreviewLines];
    $[4] = effectivePreviewLines;
    $[5] = focusedPath;
    $[6] = t5;
    $[7] = t6;
  } else {
    t5 = $[6];
    t6 = $[7];
  }
  useEffect(t5, t6);
  let t7;
  if ($[8] !== onDone || $[9] !== results.length) {
    t7 = p_1 => {
      if (isWorkbenchEnabled() && setAppState) {
        setAppState(prev => applyWorkbenchCommand(prev, openPreviewCommand(p_1, undefined, true)));
        onDone();
        return;
      }
      openFileInExternalEditor(path.resolve(getCwd(), p_1));
      onDone();
    };
    $[8] = onDone;
    $[9] = results.length;
    $[10] = t7;
  } else {
    t7 = $[10];
  }
  const handleOpen = t7;
  let t8;
  if ($[11] !== onDone || $[12] !== onInsert || $[13] !== results.length) {
    t8 = (p_2, mention) => {
      onInsert(mention ? `@${p_2} ` : `${p_2} `);
      onDone();
    };
    $[11] = onDone;
    $[12] = onInsert;
    $[13] = results.length;
    $[14] = t8;
  } else {
    t8 = $[14];
  }
  const handleInsert = t8;
  const t9 = previewOnRight ? "right" : "bottom";
  let t10;
  if ($[15] !== handleInsert) {
    t10 = {
      action: "mention",
      handler: p_4 => handleInsert(p_4, true)
    };
    $[15] = handleInsert;
    $[16] = t10;
  } else {
    t10 = $[16];
  }
  let t11;
  if ($[17] !== handleInsert) {
    t11 = {
      action: "insert path",
      handler: p_5 => handleInsert(p_5, false)
    };
    $[17] = handleInsert;
    $[18] = t11;
  } else {
    t11 = $[18];
  }
  let t12;
  if ($[19] !== maxPathWidth) {
    t12 = (p_6, isFocused) => <Text color={isFocused ? "suggestion" : undefined}>{truncatePathMiddle(p_6, maxPathWidth)}</Text>;
    $[19] = maxPathWidth;
    $[20] = t12;
  } else {
    t12 = $[20];
  }
  let t13;
  if ($[21] !== preview || $[22] !== previewWidth || $[23] !== query) {
    t13 = p_7 => preview?.path === p_7 ? <><Text dimColor={true}>{truncatePathMiddle(p_7, previewWidth)}</Text>{preview.content.split("\n").map((line, i_1) => <Text key={i_1}>{highlightMatch(truncateToWidth(line, previewWidth), query)}</Text>)}</> : <><Text dimColor={true}>{truncatePathMiddle(p_7, previewWidth)}{preview ? " - loading..." : ""}</Text><LoadingState message={"Loading preview..."} dimColor={true} /></>;
    $[21] = preview;
    $[22] = previewWidth;
    $[23] = query;
    $[24] = t13;
  } else {
    t13 = $[24];
  }
  let t14;
  if ($[25] !== handleOpen || $[26] !== onDone || $[27] !== results || $[28] !== t10 || $[29] !== t11 || $[30] !== t12 || $[31] !== t13 || $[32] !== t9 || $[33] !== visibleResults) {
    t14 = <FuzzyPicker title="Quick Open" placeholder={"Type to search files..."} items={results} getKey={_temp5} visibleCount={visibleResults} direction="up" previewPosition={t9} onQueryChange={handleQueryChange} onFocus={setFocusedPath} onSelect={handleOpen} onTab={t10} onShiftTab={t11} onCancel={onDone} emptyMessage={_temp6} selectAction="open in editor" renderItem={t12} renderPreview={t13} />;
    $[25] = handleOpen;
    $[26] = onDone;
    $[27] = results;
    $[28] = t10;
    $[29] = t11;
    $[30] = t12;
    $[31] = t13;
    $[32] = t9;
    $[33] = visibleResults;
    $[34] = t14;
  } else {
    t14 = $[34];
  }
  return t14;
}
function _temp6(q_0) {
  return q_0 ? "No matching files" : "Start typing to search...";
}
function _temp5(p_3) {
  return p_3;
}
function _temp4(p_0) {
  return p_0.split(path.sep).join("/");
}
function _temp3(p) {
  return !p.endsWith(path.sep);
}
function _temp2(i_0) {
  return i_0.displayText;
}
function _temp(i) {
  return i.id.startsWith("file-");
}
