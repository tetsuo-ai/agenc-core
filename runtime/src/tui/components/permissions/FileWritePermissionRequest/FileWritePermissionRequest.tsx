// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { basename, relative } from 'path';
import React, { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod/v4';
import { Text } from '../../../ink.js';
import { FileWriteTool } from '../../../../tools/FileWriteTool/FileWriteTool';
import { getCwd } from '../../../../utils/cwd'; // upstream-import: keep target is owned by another Z-PURGE item
import { isENOENT } from '../../../../utils/errors'; // upstream-import: keep target is owned by another Z-PURGE item
import { getFsImplementation } from '../../../../utils/fsOperations'; // upstream-import: keep target is owned by another Z-PURGE item
import { LoadingState } from '../../design-system/LoadingState';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog';
import { createSingleEditDiffConfig, type FileEdit, type IDEDiffSupport } from '../FilePermissionDialog/ideDiffConfig';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { FileWriteToolDiff } from './FileWriteToolDiff';

type FileWriteToolInput = z.infer<typeof FileWriteTool.inputSchema>;
type FileReadState = {
  filePath: string;
  status: 'loading';
} | {
  filePath: string;
  status: 'ready';
  fileExists: boolean;
  oldContent: string;
} | {
  filePath: string;
  status: 'error';
  error: unknown;
};

async function readExistingFileContent(filePath: string): Promise<Extract<FileReadState, { status: 'ready' }>> {
  try {
    const oldContent = await getFsImplementation().readFile(filePath, {
      encoding: 'utf8'
    });
    return {
      filePath,
      fileExists: true,
      oldContent: oldContent.replaceAll('\r\n', '\n'),
      status: 'ready'
    };
  } catch (e) {
    if (!isENOENT(e)) throw e;
    return {
      filePath,
      fileExists: false,
      oldContent: '',
      status: 'ready'
    };
  }
}

function createFileWriteIdeDiffSupport(oldContent: string): IDEDiffSupport<FileWriteToolInput> {
  return {
    getConfig: (input: FileWriteToolInput) => {
      return createSingleEditDiffConfig(input.file_path, oldContent, input.content, false // For file writes, we replace the entire content
      );
    },
    applyChanges: (input: FileWriteToolInput, modifiedEdits: FileEdit[]) => {
      const firstEdit = modifiedEdits[0];
      if (firstEdit) {
        return {
          ...input,
          content: firstEdit.new_string
        };
      }
      return input;
    }
  };
}

export function FileWritePermissionRequest(props: PermissionRequestProps<FileWriteToolInput>) {
  const parsed = parseInput(props.toolUseConfirm.input);
  const {
    file_path,
    content
  } = parsed;
  const [fileReadState, setFileReadState] = useState<FileReadState>(() => ({
    filePath: file_path,
    status: 'loading'
  }));

  useEffect(() => {
    let cancelled = false;
    setFileReadState({
      filePath: file_path,
      status: 'loading'
    });
    readExistingFileContent(file_path).then(result => {
      if (!cancelled) {
        setFileReadState(result);
      }
    }, error => {
      if (!cancelled) {
        setFileReadState({
          filePath: file_path,
          status: 'error',
          error
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [file_path]);

  const currentFileReadState = fileReadState.filePath === file_path ? fileReadState : {
    filePath: file_path,
    status: 'loading'
  };
  if (currentFileReadState.status === 'error') {
    throw currentFileReadState.error;
  }

  const readyState = currentFileReadState.status === 'ready' ? currentFileReadState : null;
  const fileExists = readyState?.fileExists ?? false;
  const oldContent = readyState?.oldContent ?? '';
  const actionText = readyState ? fileExists ? "overwrite" : "create" : "write";
  const title = readyState ? fileExists ? "Overwrite file" : "Create file" : "Write file";
  const question = <Text>Do you want to {actionText} <Text bold={true}>{basename(file_path)}</Text>?</Text>;
  const dialogContent = readyState ? <FileWriteToolDiff file_path={file_path} content={content} fileExists={fileExists} oldContent={oldContent} /> : <LoadingState message="Loading file preview…" dimColor={true} />;
  const ideDiffSupport = useMemo(() => readyState ? createFileWriteIdeDiffSupport(readyState.oldContent) : undefined, [readyState?.oldContent]);

  return <FilePermissionDialog toolUseConfirm={props.toolUseConfirm} toolUseContext={props.toolUseContext} onDone={props.onDone} onReject={props.onReject} workerBadge={props.workerBadge} title={title} subtitle={relative(getCwd(), file_path)} question={question} content={dialogContent} path={file_path} completionType="write_file_single" parseInput={parseInput} ideDiffSupport={ideDiffSupport} />;
}

function parseInput(input: unknown): FileWriteToolInput {
  return FileWriteTool.inputSchema.parse(input);
}

export const __fileWritePermissionRequestTest = {
  createFileWriteIdeDiffSupport,
  readExistingFileContent
};
