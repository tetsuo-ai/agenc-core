// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { Suspense, use, useState } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize';
import { Box, Text } from '../../ink.js';
import type { FileEdit } from '../../../tools/FileEditTool/types';
import { getPatchForEdits } from '../../../tools/FileEditTool/utils';
import { adjustHunkLineNumbers, CONTEXT_LINES } from '../../../utils/diff'; // upstream-import: keep target is owned by another Z-PURGE item
import { logError } from '../../../utils/log'; // upstream-import: keep target is owned by another Z-PURGE item
import { CHUNK_SIZE, openForScan, readCapped, scanForContext } from '../../../utils/readEditContext'; // upstream-import: keep target is owned by another Z-PURGE item
import { firstLineOf } from '../../../utils/stringUtils'; // upstream-import: keep target is owned by another Z-PURGE item
import { StructuredDiffList } from './StructuredDiffList';
type Props = {
  file_path: string;
  edits: FileEdit[];
};
type DiffData = {
  patch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent: string | undefined;
};
export function FileEditToolDiff(props) {
  const $ = _c(7);
  let t0;
  if ($[0] !== props.edits || $[1] !== props.file_path) {
    t0 = () => loadDiffData(props.file_path, props.edits);
    $[0] = props.edits;
    $[1] = props.file_path;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  const [dataPromise] = useState(t0);
  let t1;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <DiffFrame placeholder={true} />;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  let t2;
  if ($[4] !== dataPromise || $[5] !== props.file_path) {
    t2 = <Suspense fallback={t1}><DiffBody promise={dataPromise} file_path={props.file_path} /></Suspense>;
    $[4] = dataPromise;
    $[5] = props.file_path;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  return t2;
}
function DiffBody(t0) {
  const $ = _c(6);
  const {
    promise,
    file_path
  } = t0;
  const {
    patch,
    firstLine,
    fileContent
  } = use(promise);
  const {
    columns
  } = useTerminalSize();
  let t1;
  if ($[0] !== columns || $[1] !== fileContent || $[2] !== file_path || $[3] !== firstLine || $[4] !== patch) {
    t1 = <DiffFrame><StructuredDiffList hunks={patch} dim={false} width={columns} filePath={file_path} firstLine={firstLine} fileContent={fileContent} /></DiffFrame>;
    $[0] = columns;
    $[1] = fileContent;
    $[2] = file_path;
    $[3] = firstLine;
    $[4] = patch;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  return t1;
}
function DiffFrame(t0) {
  const $ = _c(5);
  const {
    children,
    placeholder
  } = t0;
  let t1;
  if ($[0] !== children || $[1] !== placeholder) {
    t1 = placeholder ? <Text dimColor={true}>…</Text> : children;
    $[0] = children;
    $[1] = placeholder;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  let t2;
  if ($[3] !== t1) {
    t2 = <Box flexDirection="column" marginY={1}><Box borderColor="promptBorder" borderStyle="round" flexDirection="column" paddingX={1} backgroundColor="clawd_background">{t1}</Box></Box>;
    $[3] = t1;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  return t2;
}
async function loadDiffData(file_path: string, edits: FileEdit[]): Promise<DiffData> {
  const valid = edits.filter(e => e.old_string != null && e.new_string != null);
  const single = valid.length === 1 ? valid[0]! : undefined;

  // SedEditPermissionRequest passes the entire file as old_string. Scanning for
  // a needle ≥ CHUNK_SIZE allocates O(needle) for the overlap buffer — skip the
  // file read entirely and diff the inputs we already have.
  if (single && single.old_string.length >= CHUNK_SIZE && !single.replace_all) {
    return diffToolInputsOnly(file_path, [single]);
  }
  try {
    const handle = await openForScan(file_path);
    if (handle === null) return diffToolInputsOnly(file_path, valid);
    try {
      // Multi-edit, empty old_string, and replace_all need the capped full file
      // so the permission preview cannot hide later replacements.
      if (!single || single.old_string === '' || single.replace_all) {
        const file = await readCapped(handle);
        if (file === null) return diffToolInputsOnly(file_path, valid);
        const { patch } = getPatchForEdits({
          filePath: file_path,
          fileContents: file,
          edits: valid
        });
        return {
          patch,
          firstLine: firstLineOf(file),
          fileContent: file
        };
      }
      const ctx = await scanForContext(handle, single.old_string, CONTEXT_LINES);
      if (ctx.truncated || ctx.content === '') {
        const file = await readCapped(handle);
        if (file !== null) {
          try {
            const { patch } = getPatchForEdits({
              filePath: file_path,
              fileContents: file,
              edits: [single]
            });
            return {
              patch,
              firstLine: firstLineOf(file),
              fileContent: file
            };
          } catch {
            // Expected when neither exact nor normalized matching succeeds.
          }
        }
        return diffToolInputsOnly(file_path, [single]);
      }
      const { patch } = getPatchForEdits({
        filePath: file_path,
        fileContents: ctx.content,
        edits: [single]
      });
      return {
        patch: adjustHunkLineNumbers(patch, ctx.lineOffset - 1),
        firstLine: ctx.lineOffset === 1 ? firstLineOf(ctx.content) : null,
        fileContent: ctx.content
      };
    } finally {
      await handle.close();
    }
  } catch (e) {
    logError(e as Error);
    return diffToolInputsOnly(file_path, valid);
  }
}
function diffToolInputsOnly(filePath: string, edits: FileEdit[]): DiffData {
  return {
    patch: edits.flatMap(e => {
      try {
        return getPatchForEdits({
          filePath,
          fileContents: e.old_string,
          edits: [e]
        }).patch;
      } catch {
        return [];
      }
    }),
    firstLine: null,
    fileContent: undefined
  };
}
