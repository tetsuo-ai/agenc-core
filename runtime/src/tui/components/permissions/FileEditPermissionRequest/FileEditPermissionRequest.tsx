// @ts-nocheck
import { basename, relative } from 'path';
import React from 'react';
import { z } from 'zod/v4';
import { FileEditToolDiff } from '../../diff/FileEditToolDiff.js';
import { getCwd } from '../../../../utils/cwd.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { Text } from '../../../ink.js';
import { FileEditTool } from '../../../../tools/FileEditTool/FileEditTool';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog';
import { type FileEdit, type IDEDiffSupport } from '../FilePermissionDialog/ideDiffConfig';
import type { PermissionRequestProps } from '../PermissionRequest.js';
type SingleEditInput = z.infer<typeof FileEditTool.inputSchema>;
type MultiEditInput = {
  file_path: string;
  edits: FileEdit[];
};
type FileEditInput = SingleEditInput | MultiEditInput;

const multiEditInputSchema = z.strictObject({
  file_path: z.string(),
  edits: z.array(z.strictObject({
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional()
  })).min(1)
});

const ideDiffSupport: IDEDiffSupport<FileEditInput> = {
  getConfig: input => {
    const edits = editsForInput(input);
    return {
      filePath: input.file_path,
      edits,
      editMode: edits.length > 1 ? 'multiple' : 'single'
    };
  },
  applyChanges: (input: FileEditInput, modifiedEdits: FileEdit[]) => {
    if (Array.isArray(input.edits)) {
      return {
        ...input,
        edits: modifiedEdits
      };
    }
    const firstEdit = modifiedEdits[0];
    if (firstEdit) {
      return {
        ...input,
        old_string: firstEdit.old_string,
        new_string: firstEdit.new_string,
        replace_all: firstEdit.replace_all
      };
    }
    return input;
  }
};
export function FileEditPermissionRequest(props) {
  const parsed = parseInput(props.toolUseConfirm.input);
  const file_path = parsed.file_path;
  const edits = editsForInput(parsed);
  const editLabel = edits.length === 1 ? 'this edit' : `${edits.length} edits`;
  const question = <Text>Do you want to make {editLabel} to <Text bold>{basename(file_path)}</Text>?</Text>;
  const content = <FileEditToolDiff file_path={file_path} edits={edits} />;
  return <FilePermissionDialog toolUseConfirm={props.toolUseConfirm} toolUseContext={props.toolUseContext} onDone={props.onDone} onReject={props.onReject} workerBadge={props.workerBadge} title="Edit file" subtitle={relative(getCwd(), file_path)} question={question} content={content} path={file_path} completionType={edits.length > 1 ? "str_replace_multi" : "str_replace_single"} parseInput={parseInput} ideDiffSupport={ideDiffSupport} />;
}
function parseInput(input) {
  if (hasMultiEditShape(input)) {
    const parsed = multiEditInputSchema.parse(input);
    return {
      file_path: parsed.file_path,
      edits: parsed.edits.map(normalizeEdit)
    };
  }
  return FileEditTool.inputSchema.parse(input);
}
function hasMultiEditShape(input): input is {
  edits: unknown;
} {
  return input != null && typeof input === 'object' && Array.isArray(input.edits);
}
function editsForInput(input) {
  if (Array.isArray(input.edits)) return input.edits.map(normalizeEdit);
  return [{
    old_string: input.old_string,
    new_string: input.new_string,
    replace_all: input.replace_all || false
  }];
}
function normalizeEdit(edit) {
  return {
    old_string: typeof edit?.old_string === 'string' ? edit.old_string : '',
    new_string: typeof edit?.new_string === 'string' ? edit.new_string : '',
    replace_all: edit?.replace_all === true
  };
}
