import { basename } from 'path';

export type MemorySelectorFileInfo = {
  path: string;
  type: string;
  content: string;
  parent?: string;
  isNested?: boolean;
};

export type AgentMemoryScopeForSelector = 'user' | 'project' | 'local';

export type AgentMemoryDefinitionForSelector = {
  agentType: string;
  memory?: AgentMemoryScopeForSelector | false | null;
};

export type MemorySelectorOption = {
  label: string;
  value: string;
  description: string;
  kind: 'user' | 'project' | 'import' | 'memory' | 'folder' | 'agent';
  state: 'present' | 'absent' | 'folder';
};

type ExtendedMemoryFileInfo = MemorySelectorFileInfo & {
  exists: boolean;
};

type BuildMemoryFileSelectorOptionsInput = {
  existingMemoryFiles: readonly MemorySelectorFileInfo[];
  userMemoryPath: string;
  projectMemoryPath: string;
  autoMemoryEnabled: boolean;
  autoMemoryPath: string;
  teamMemoryEnabled: boolean;
  teamMemoryPath?: string;
  activeAgents: readonly AgentMemoryDefinitionForSelector[];
  projectInGitRepo: boolean;
  displayPathFor: (path: string) => string;
  agentMemoryDirFor: (
    agentType: string,
    scope: AgentMemoryScopeForSelector,
  ) => string;
};

export const OPEN_FOLDER_PREFIX = '__open_folder__';

function hasUsableMemoryScope(
  agent: AgentMemoryDefinitionForSelector,
): agent is AgentMemoryDefinitionForSelector & {
  memory: AgentMemoryScopeForSelector;
} {
  return (
    agent.memory === 'user' ||
    agent.memory === 'project' ||
    agent.memory === 'local'
  );
}

function memoryFileDepth(
  file: ExtendedMemoryFileInfo,
  depths: Map<string, number>,
): number {
  const depth = file.parent ? (depths.get(file.parent) ?? 0) + 1 : 0;
  depths.set(file.path, depth);
  return depth;
}

function memoryFileLabel(
  file: ExtendedMemoryFileInfo,
  depth: number,
  userMemoryPath: string,
  projectMemoryPath: string,
  displayPathFor: (path: string) => string,
): string {
  if (file.type === 'User' && !file.isNested && file.path === userMemoryPath) {
    return 'User memory';
  }
  if (
    file.type === 'Project' &&
    !file.isNested &&
    file.path === projectMemoryPath
  ) {
    return 'Project memory';
  }

  const displayPath = displayPathFor(file.path);
  if (depth > 0) {
    const indent = '  '.repeat(depth - 1);
    return `${indent}L ${displayPath}`;
  }
  return displayPath;
}

function memoryFileDescription(
  file: ExtendedMemoryFileInfo,
  projectMemoryPath: string,
  projectMemoryFileName: string,
  projectInGitRepo: boolean,
): string {
  if (file.type === 'User' && !file.isNested) {
    return 'Saved in ~/.agenc/AGENC.md';
  }
  if (
    file.type === 'Project' &&
    !file.isNested &&
    file.path === projectMemoryPath
  ) {
    return `${projectInGitRepo ? 'Checked in at' : 'Saved in'} ./${projectMemoryFileName}`;
  }
  if (file.parent) {
    return '@-imported';
  }
  if (file.isNested) {
    return 'dynamically loaded';
  }
  return '';
}

function memoryFileKind(
  file: ExtendedMemoryFileInfo,
  userMemoryPath: string,
  projectMemoryPath: string,
): MemorySelectorOption['kind'] {
  if (file.type === 'User' && !file.isNested && file.path === userMemoryPath) {
    return 'user';
  }
  if (
    file.type === 'Project' &&
    !file.isNested &&
    file.path === projectMemoryPath
  ) {
    return 'project';
  }
  if (file.parent) {
    return 'import';
  }
  return 'memory';
}

export function buildMemoryFileSelectorOptions({
  existingMemoryFiles,
  userMemoryPath,
  projectMemoryPath,
  autoMemoryEnabled,
  autoMemoryPath,
  teamMemoryEnabled,
  teamMemoryPath,
  activeAgents,
  projectInGitRepo,
  displayPathFor,
  agentMemoryDirFor,
}: BuildMemoryFileSelectorOptionsInput): MemorySelectorOption[] {
  const projectMemoryFileName = basename(projectMemoryPath);
  const hasUserMemory = existingMemoryFiles.some(
    file => file.path === userMemoryPath,
  );
  const hasProjectMemory = existingMemoryFiles.some(
    file => file.path === projectMemoryPath,
  );
  const allMemoryFiles: ExtendedMemoryFileInfo[] = [
    ...existingMemoryFiles
      .filter(file => file.type !== 'AutoMem' && file.type !== 'TeamMem')
      .map(file => ({ ...file, exists: true })),
    ...(hasUserMemory
      ? []
      : [
          {
            path: userMemoryPath,
            type: 'User',
            content: '',
            exists: false,
          },
        ]),
    ...(hasProjectMemory
      ? []
      : [
          {
            path: projectMemoryPath,
            type: 'Project',
            content: '',
            exists: false,
          },
        ]),
  ];

  const depths = new Map<string, number>();
  const memoryOptions: MemorySelectorOption[] = allMemoryFiles.map((file): MemorySelectorOption => {
    const depth = memoryFileDepth(file, depths);
    return {
      label: memoryFileLabel(
        file,
        depth,
        userMemoryPath,
        projectMemoryPath,
        displayPathFor,
      ),
      value: file.path,
      description: memoryFileDescription(
        file,
        projectMemoryPath,
        projectMemoryFileName,
        projectInGitRepo,
      ),
      kind: memoryFileKind(file, userMemoryPath, projectMemoryPath),
      state: file.exists ? 'present' : 'absent',
    };
  });

  if (!autoMemoryEnabled) {
    return memoryOptions;
  }

  memoryOptions.push({
    label: 'Open auto-memory folder',
    value: `${OPEN_FOLDER_PREFIX}${autoMemoryPath}`,
    description: '',
    kind: 'folder',
    state: 'folder',
  });

  if (teamMemoryEnabled && teamMemoryPath) {
    memoryOptions.push({
      label: 'Open team memory folder',
      value: `${OPEN_FOLDER_PREFIX}${teamMemoryPath}`,
      description: '',
      kind: 'folder',
      state: 'folder',
    });
  }

  for (const agent of activeAgents) {
    if (!hasUsableMemoryScope(agent)) continue;
    const agentDir = agentMemoryDirFor(agent.agentType, agent.memory);
    memoryOptions.push({
      label: `Open ${agent.agentType} agent memory`,
      value: `${OPEN_FOLDER_PREFIX}${agentDir}`,
      description: `${agent.memory} scope`,
      kind: 'agent',
      state: 'folder',
    });
  }

  return memoryOptions;
}

export function getInitialMemoryPath(
  memoryOptions: readonly MemorySelectorOption[],
  selectedPath: string | undefined,
): string {
  if (
    selectedPath &&
    memoryOptions.some(option => option.value === selectedPath)
  ) {
    return selectedPath;
  }
  return memoryOptions[0]?.value ?? '';
}
