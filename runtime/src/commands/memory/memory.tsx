import { mkdir as mkdirAsync, writeFile as writeFileAsync } from 'fs/promises';
import { isAbsolute, relative } from 'path';
import * as React from 'react';
import type { LocalJSXCommandOnDone } from '../../commands.js';
import { getOriginalCwd } from '../../bootstrap/state.js';
import {
  getAutoMemPath,
  getProjectMemoryPathForSelector,
  isAutoMemoryEnabled,
} from '../../memory/index.js';
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js';
import {
  buildMemoryFileSelectorOptions,
  getInitialMemoryPath,
  OPEN_FOLDER_PREFIX,
  type MemorySelectorFileInfo,
  type MemorySelectorOption,
} from '../../tui/components/memory/selector-options.js';
import { getRelativeMemoryPath } from '../../tui/components/memory/MemoryUpdateNotification.js';
import { MenuModal } from '../../tui/components/v2/primitives.js';
import ThemedText from '../../tui/components/design-system/ThemedText.js';
import { Box, useInput } from '../../tui/ink.js';
import { useAppState } from '../../tui/state/AppState.js';
import type { AppState } from '../../tui/state/AppStateStore.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { clearMemoryFileCaches, getMemoryFiles } from '../../memory/index.js';
import { getAgenCConfigHomeDir } from '../../utils/envUtils.js';
import { openFileInExternalEditor } from '../../utils/editor.js';
import { openPath } from '../../utils/browser.js';
import { getErrnoCode } from '../../utils/errors.js';
import { getDisplayPath } from '../../utils/file.js';
import { logError } from '../../utils/log.js';
import { projectIsInGitRepo } from '../../utils/memory/versions.js';

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
  openPath: typeof openPath;
  getAgenCConfigHomeDir: typeof getAgenCConfigHomeDir;
  getRelativeMemoryPath: typeof getRelativeMemoryPath;
  logError: typeof logError;
  env: NodeJS.ProcessEnv;
};

const defaultOpenMemoryFileDeps: OpenMemoryFileDeps = {
  mkdir: mkdirAsync,
  writeFile: writeFileAsync,
  openFileInExternalEditor,
  openPath,
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

async function openMemoryFolder(
  folderPath: string,
  onDone: LocalJSXCommandOnDone,
  deps: Partial<OpenMemoryFileDeps> = {},
): Promise<void> {
  const resolvedDeps = { ...defaultOpenMemoryFileDeps, ...deps };
  try {
    await resolvedDeps.mkdir(folderPath, { recursive: true });
    const opened = await resolvedDeps.openPath(folderPath);
    if (!opened) {
      onDone(`Error opening memory folder: no external file browser is available`);
      return;
    }
    onDone(`Opened memory folder at ${resolvedDeps.getRelativeMemoryPath(folderPath)}`, {
      display: 'system',
    });
  } catch (error) {
    resolvedDeps.logError(error);
    onDone(`Error opening memory folder: ${error}`);
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0]?.trim() ?? '';
}

function compactText(value: string, limit = 96): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

function optionKind(option: MemorySelectorOption): string {
  if (option.value.startsWith(OPEN_FOLDER_PREFIX)) return 'folder';
  if (option.label.toLowerCase().includes('user')) return 'user';
  if (option.label.toLowerCase().includes('project')) return 'project';
  if (option.description.includes('@-imported')) return 'import';
  return 'memory';
}

function previewText(
  option: MemorySelectorOption | undefined,
  files: readonly MemorySelectorFileInfo[],
): string {
  if (!option) return 'No memory file selected.';
  if (option.value.startsWith(OPEN_FOLDER_PREFIX)) {
    return option.value.slice(OPEN_FOLDER_PREFIX.length);
  }
  const file = files.find(entry => entry.path === option.value);
  if (!file || file.content.trim().length === 0) {
    return 'New or empty memory file.';
  }
  return file.content
    .split(/\r?\n/u)
    .slice(0, 12)
    .map(line => line.trimEnd())
    .join('\n');
}

function MemoryCommand({
  onDone,
  existingMemoryFiles,
}: {
  onDone: LocalJSXCommandOnDone;
  existingMemoryFiles: readonly MemorySelectorFileInfo[];
}): React.ReactNode {
  const activeAgents = useAppState(
    (state: AppState) => state.agentDefinitions.activeAgents,
  );
  const originalCwd = getOriginalCwd();
  const userMemoryPath = `${getAgenCConfigHomeDir()}/AGENC.md`;
  const projectMemoryPath = getProjectMemoryPathForSelector(
    [...existingMemoryFiles] as Parameters<typeof getProjectMemoryPathForSelector>[0],
    originalCwd,
  );
  const memoryOptions = React.useMemo(
    () => buildMemoryFileSelectorOptions({
      existingMemoryFiles,
      userMemoryPath,
      projectMemoryPath,
      autoMemoryEnabled: isAutoMemoryEnabled(),
      autoMemoryPath: getAutoMemPath(),
      teamMemoryEnabled: false,
      activeAgents,
      projectInGitRepo: projectIsInGitRepo(originalCwd),
      displayPathFor: getDisplayPath,
      agentMemoryDirFor: getAgentMemoryDir,
    }),
    [activeAgents, existingMemoryFiles, originalCwd, projectMemoryPath, userMemoryPath],
  );
  const [activeIndex, setActiveIndex] = React.useState(() => {
    const initial = getInitialMemoryPath(memoryOptions, undefined);
    return Math.max(0, memoryOptions.findIndex(option => option.value === initial));
  });
  const rows =
    memoryOptions.length > 0
      ? memoryOptions
      : [{ label: 'No memory files', value: '', description: 'none available' }];

  const selected = rows[activeIndex] ?? rows[0];
  const closeWithCancel = React.useCallback(() => {
    onDone('Cancelled memory editing', {
      display: 'system',
    });
  }, [onDone]);
  const submitSelected = React.useCallback(() => {
    if (!selected || selected.value.length === 0) return;
    if (selected.value.startsWith(OPEN_FOLDER_PREFIX)) {
      void openMemoryFolder(selected.value.slice(OPEN_FOLDER_PREFIX.length), onDone);
      return;
    }
    void openMemoryFile(selected.value, onDone);
  }, [onDone, selected]);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      closeWithCancel();
      return;
    }
    if (key.upArrow || input === 'k') {
      setActiveIndex(index => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setActiveIndex(index => Math.min(rows.length - 1, index + 1));
      return;
    }
    if (key.return) {
      submitSelected();
    }
  });

  return <MenuModal
      title="memory"
      count={`${memoryOptions.length} entries`}
      summary="AGENC.md, imports, and agent memory"
      headerRight="↑↓ select · ⏎ open · q close"
      columns={[3, 20, 18, 54]}
      headers={['', 'kind', 'path', 'description']}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(option, _index, active) => [
        <ThemedText key="mark" color={active ? 'agenc' : 'inactive'}>{active ? '◆' : '·'}</ThemedText>,
        <ThemedText key="kind" color={option.value.startsWith(OPEN_FOLDER_PREFIX) ? 'worker' : 'agenc'} wrap="truncate-end">
          {optionKind(option)}
        </ThemedText>,
        <ThemedText key="path" color={active ? 'agenc' : 'text2'} wrap="truncate-middle">
          {option.label}
        </ThemedText>,
        <ThemedText key="desc" color="subtle" wrap="truncate-end">
          {option.description || 'open'}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">{selected?.label ?? 'Memory'}</ThemedText>
          <ThemedText color="inactive" wrap="truncate-middle">
            {selected?.value.startsWith(OPEN_FOLDER_PREFIX)
              ? selected.value.slice(OPEN_FOLDER_PREFIX.length)
              : selected?.value ?? ''}
          </ThemedText>
          {previewText(selected, existingMemoryFiles).split(/\r?\n/u).map((line, index) => (
            <ThemedText key={index} color={index === 0 ? 'text2' : 'subtle'} wrap="truncate-end">
              {index === 0 ? compactText(firstLine(line), 80) : compactText(line, 80)}
            </ThemedText>
          ))}
        </Box>
      }
      footer={[
        { keyName: '⏎', label: 'open' },
        { keyName: 'q', label: 'close' },
      ]}
      hint="memory edits open in $VISUAL or $EDITOR"
    />;
}
export const call: LocalJSXCommandCall = async onDone => {
  clearMemoryFileCaches();
  const existingMemoryFiles = await getMemoryFiles();
  return <MemoryCommand onDone={onDone} existingMemoryFiles={existingMemoryFiles} />;
};
