import { mkdir as mkdirAsync, writeFile as writeFileAsync } from 'fs/promises';
import { isAbsolute, relative } from 'path';
import * as React from 'react';
import type { LocalJSXCommandOnDone } from '../../commands.js';
import { Dialog } from '../../tui/components/design-system/Dialog.js';
import {
  clearMemoryFileSelectorCache,
  MemoryFileSelector,
  primeMemoryFileSelectorCache,
} from '../../tui/components/memory/MemoryFileSelector.js';
import { getRelativeMemoryPath } from '../../tui/components/memory/MemoryUpdateNotification.js';
import { Box, Link, Text } from '../../tui/ink.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { clearMemoryFileCaches, getMemoryFiles } from '../../memory/index.js';
import { getAgenCConfigHomeDir } from '../../utils/envUtils.js';
import { openFileInExternalEditor } from '../../utils/editor.js';
import { getErrnoCode } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';

/**
 * Ports the TUI source reference `src/commands/memory/memory.tsx` command body
 * onto AgenC memory paths and TUI components.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC keeps project-memory routing in `runtime/src/memory/project-memory.ts`
 *     and renders the selector from `runtime/src/tui/components/memory/`.
 *
 * Cross-cuts deliberately NOT carried:
 *   - None; the selector owns its feature-gated folder shortcuts.
 */
type OpenMemoryFileDeps = {
  mkdir: typeof mkdirAsync;
  writeFile: typeof writeFileAsync;
  openFileInExternalEditor: typeof openFileInExternalEditor;
  getAgenCConfigHomeDir: typeof getAgenCConfigHomeDir;
  getRelativeMemoryPath: typeof getRelativeMemoryPath;
  logError: typeof logError;
  env: NodeJS.ProcessEnv;
};

const defaultOpenMemoryFileDeps: OpenMemoryFileDeps = {
  mkdir: mkdirAsync,
  writeFile: writeFileAsync,
  openFileInExternalEditor,
  getAgenCConfigHomeDir,
  getRelativeMemoryPath,
  logError,
  env: process.env,
};

function isPathAtOrInside(basePath: string, targetPath: string): boolean {
  const relativePath = relative(basePath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function getEditorHint(env: NodeJS.ProcessEnv): string {
  if (env.VISUAL) {
    return `> Using $VISUAL="${env.VISUAL}". To change editor, set $EDITOR or $VISUAL environment variable.`;
  }
  if (env.EDITOR) {
    return `> Using $EDITOR="${env.EDITOR}". To change editor, set $EDITOR or $VISUAL environment variable.`;
  }
  return '> To use a different editor, set the $EDITOR or $VISUAL environment variable.';
}

export async function openMemoryFile(
  memoryPath: string,
  onDone: LocalJSXCommandOnDone,
  deps: Partial<OpenMemoryFileDeps> = {},
): Promise<void> {
  const resolvedDeps = { ...defaultOpenMemoryFileDeps, ...deps };
  try {
    const configHomeDir = resolvedDeps.getAgenCConfigHomeDir();
    if (isPathAtOrInside(configHomeDir, memoryPath)) {
      await resolvedDeps.mkdir(configHomeDir, { recursive: true });
    }

    try {
      await resolvedDeps.writeFile(memoryPath, '', {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error: unknown) {
      if (getErrnoCode(error) !== 'EEXIST') {
        throw error;
      }
    }

    const opened = resolvedDeps.openFileInExternalEditor(memoryPath);
    if (!opened) {
      onDone(`Error opening memory file: no external editor is available`);
      return;
    }
    onDone(
      `Opened memory file at ${resolvedDeps.getRelativeMemoryPath(memoryPath)}\n\n${getEditorHint(resolvedDeps.env)}`,
      { display: 'system' },
    );
  } catch (error) {
    resolvedDeps.logError(error);
    onDone(`Error opening memory file: ${error}`);
  }
}

function MemoryCommand({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone;
}): React.ReactNode {
  const handleSelectMemoryFile = (memoryPath: string): void => {
    void openMemoryFile(memoryPath, onDone);
  };
  const handleCancel = () => {
    onDone('Cancelled memory editing', {
      display: 'system'
    });
  };
  return <Dialog title="Memory" onCancel={handleCancel} color="remember">
      <Box flexDirection="column">
        <React.Suspense fallback={null}>
          <MemoryFileSelector onSelect={handleSelectMemoryFile} onCancel={handleCancel} />
        </React.Suspense>

        <Box marginTop={1}>
          <Text dimColor>
            Learn more: <Link url="https://agenc.tech/docs/en/memory" />
          </Text>
        </Box>
      </Box>
    </Dialog>;
}
export const call: LocalJSXCommandCall = async onDone => {
  // Clear + prime before rendering — Suspense handles the unprimed case,
  // but awaiting here avoids a fallback flash on initial open.
  clearMemoryFileCaches();
  clearMemoryFileSelectorCache();
  const memoryFilesPromise = getMemoryFiles();
  primeMemoryFileSelectorCache(memoryFilesPromise);
  await memoryFilesPromise;
  return <MemoryCommand onDone={onDone} />;
};
