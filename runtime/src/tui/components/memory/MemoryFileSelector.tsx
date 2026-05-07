import { feature } from 'bun:bundle';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import * as React from 'react';
import { use, useEffect, useState } from 'react';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import {
  getAutoMemPath,
  getMemoryFiles,
  getProjectMemoryPathForSelector,
  isAutoMemoryEnabled,
} from '../../../memory/index.js';
import * as teamMemPathsModule from '../../../memdir/teamMemPaths.js';
import { logEvent } from '../../../services/analytics/index.js';
import { isAutoDreamEnabled } from '../../../services/autoDream/config.js';
import { readLastConsolidatedAt } from '../../../services/autoDream/consolidationLock.js';
import { getAgentMemoryDir } from '../../../tools/AgentTool/agentMemory.js';
import { openPath } from '../../../utils/browser.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getAgenCConfigHomeDir } from '../../../utils/envUtils.js';
import { getDisplayPath } from '../../../utils/file.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { formatRelativeTimeAgo } from '../../../utils/format.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { logError } from '../../../utils/log.js';
import { projectIsInGitRepo } from '../../../utils/memory/versions.js';
import { updateSettingsForSource } from '../../../utils/settings/settings.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { useAppState } from '../../state/AppState.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Select } from '../CustomSelect/select.js';
import { ListItem } from '../design-system/ListItem.js';
import {
  buildMemoryFileSelectorOptions,
  getInitialMemoryPath,
  OPEN_FOLDER_PREFIX,
  type AgentMemoryDefinitionForSelector,
} from './selector-options.js';

/**
 * Ports the TUI source reference `src/components/memory/MemoryFileSelector.tsx`
 * onto AgenC's project-memory API and TUI component tree.
 *
 * Why this lives here / shape difference from upstream:
 *   - Project selector path resolution is owned by `memory/project-memory.ts`
 *     after MM-03, so this component imports that public surface directly.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Team memory remains behind its existing feature gate.
 */

const teamMemPaths: typeof teamMemPathsModule | null = feature('TEAMMEM')
  ? teamMemPathsModule
  : null;

type AgentDefinitionsState = {
  activeAgents?: readonly AgentMemoryDefinitionForSelector[];
};

let lastSelectedPath: string | undefined;
type MemoryFilesPromise = ReturnType<typeof getMemoryFiles>;
let memoryFilesPromise: MemoryFilesPromise | null = null;

type Props = {
  onSelect: (path: string) => void;
  onCancel: () => void;
};

function getActiveAgents(
  agentDefinitions: AgentDefinitionsState | undefined,
): readonly AgentMemoryDefinitionForSelector[] {
  return agentDefinitions?.activeAgents ?? [];
}

export function clearMemoryFileSelectorCache(): void {
  memoryFilesPromise = null;
}

export function primeMemoryFileSelectorCache(
  promise: MemoryFilesPromise,
): MemoryFilesPromise {
  memoryFilesPromise = promise;
  return promise;
}

export function getMemoryFilesForSelector(): MemoryFilesPromise {
  memoryFilesPromise ??= getMemoryFiles();
  return memoryFilesPromise;
}

async function openMemoryFolder(folderPath: string): Promise<void> {
  try {
    await mkdir(folderPath, { recursive: true });
    const opened = await openPath(folderPath);
    if (!opened) {
      logError(new Error(`Failed to open memory folder: ${folderPath}`));
    }
  } catch (error) {
    logError(error);
  }
}

export function MemoryFileSelector({
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const existingMemoryFiles = use(getMemoryFilesForSelector());
  const originalCwd = getOriginalCwd();
  const userMemoryPath = join(getAgenCConfigHomeDir(), 'AGENC.md');
  const projectMemoryPath = getProjectMemoryPathForSelector(
    existingMemoryFiles,
    originalCwd,
  );
  const agentDefinitions = useAppState(
    (state: { agentDefinitions?: AgentDefinitionsState }) =>
      state.agentDefinitions,
  ) as AgentDefinitionsState | undefined;
  const activeAgents = getActiveAgents(agentDefinitions);
  const teamMemoryEnabled = Boolean(
    feature('TEAMMEM') && teamMemPaths?.isTeamMemoryEnabled(),
  );
  const teamMemoryPath = teamMemoryEnabled
    ? teamMemPaths?.getTeamMemPath()
    : undefined;
  const memoryOptions = buildMemoryFileSelectorOptions({
    existingMemoryFiles,
    userMemoryPath,
    projectMemoryPath,
    autoMemoryEnabled: isAutoMemoryEnabled(),
    autoMemoryPath: getAutoMemPath(),
    teamMemoryEnabled,
    teamMemoryPath,
    activeAgents,
    projectInGitRepo: projectIsInGitRepo(originalCwd),
    displayPathFor: getDisplayPath,
    agentMemoryDirFor: getAgentMemoryDir,
  });
  const initialPath = getInitialMemoryPath(memoryOptions, lastSelectedPath);
  const [autoMemoryOn, setAutoMemoryOn] = useState(() =>
    isAutoMemoryEnabled(),
  );
  const [autoDreamOn, setAutoDreamOn] = useState(() => isAutoDreamEnabled());
  const [showDreamRow] = useState(() => isAutoMemoryEnabled());
  const isDreamRunning = useAppState(
    (state: { tasks?: Record<string, { type?: string; status?: string }> }) =>
      Object.values(state.tasks ?? {}).some(
        task => task.type === 'dream' && task.status === 'running',
      ),
  ) as boolean;
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null);
  const [focusedToggle, setFocusedToggle] = useState<number | null>(null);
  const toggleFocused = focusedToggle !== null;
  const lastToggleIndex = showDreamRow ? 1 : 0;

  useEffect(() => {
    if (!showDreamRow) return;
    let active = true;
    readLastConsolidatedAt()
      .then(value => {
        if (active) setLastDreamAt(value);
      })
      .catch(logError);
    return () => {
      active = false;
    };
  }, [showDreamRow, isDreamRunning]);

  const dreamStatus = isDreamRunning
    ? 'running'
    : lastDreamAt === null
      ? ''
      : lastDreamAt === 0
        ? 'never'
        : `last ran ${formatRelativeTimeAgo(new Date(lastDreamAt))}`;

  const handleToggleAutoMemory = (): void => {
    const newValue = !autoMemoryOn;
    updateSettingsForSource('userSettings', {
      autoMemoryEnabled: newValue,
    });
    setAutoMemoryOn(newValue);
    logEvent('agenc_auto_memory_toggled', {
      enabled: newValue,
    });
  };

  const handleToggleAutoDream = (): void => {
    const newValue = !autoDreamOn;
    updateSettingsForSource('userSettings', {
      autoDreamEnabled: newValue,
    });
    setAutoDreamOn(newValue);
    logEvent('agenc_auto_dream_toggled', {
      enabled: newValue,
    });
  };

  useExitOnCtrlCDWithKeybindings();
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' });
  useKeybinding(
    'confirm:yes',
    () => {
      if (focusedToggle === 0) {
        handleToggleAutoMemory();
      } else if (focusedToggle === 1) {
        handleToggleAutoDream();
      }
    },
    {
      context: 'Confirmation',
      isActive: toggleFocused,
    },
  );
  useKeybinding(
    'select:next',
    () => {
      setFocusedToggle(previous =>
        previous !== null && previous < lastToggleIndex ? previous + 1 : null,
      );
    },
    {
      context: 'Select',
      isActive: toggleFocused,
    },
  );
  useKeybinding(
    'select:previous',
    () => {
      setFocusedToggle(previous =>
        previous !== null && previous > 0 ? previous - 1 : previous,
      );
    },
    {
      context: 'Select',
      isActive: toggleFocused,
    },
  );

  const handleSelect = (value: string): void => {
    if (value.startsWith(OPEN_FOLDER_PREFIX)) {
      void openMemoryFolder(value.slice(OPEN_FOLDER_PREFIX.length));
      return;
    }
    lastSelectedPath = value;
    onSelect(value);
  };

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" marginBottom={1}>
        <ListItem isFocused={focusedToggle === 0}>
          <Text>Auto-memory: {autoMemoryOn ? 'on' : 'off'}</Text>
        </ListItem>
        {showDreamRow && (
          <ListItem isFocused={focusedToggle === 1} styled={false}>
            <Text color={focusedToggle === 1 ? 'suggestion' : undefined}>
              Auto-dream: {autoDreamOn ? 'on' : 'off'}
              {dreamStatus && <Text dimColor> - {dreamStatus}</Text>}
              {!isDreamRunning && autoDreamOn && (
                <Text dimColor> - /dream to run</Text>
              )}
            </Text>
          </ListItem>
        )}
      </Box>
      <Select
        defaultFocusValue={initialPath}
        options={memoryOptions}
        isDisabled={toggleFocused}
        onChange={handleSelect}
        onCancel={onCancel}
        onUpFromFirstItem={() => setFocusedToggle(lastToggleIndex)}
      />
    </Box>
  );
}
