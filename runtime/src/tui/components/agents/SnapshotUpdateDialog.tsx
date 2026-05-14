import React, { useCallback, useMemo } from 'react'

import type { AgentMemoryScope } from '../../../tools/AgentTool/agentMemory.js'
import { Box, Text } from '../../ink.js'
import { Select, type OptionWithDescription } from '../CustomSelect/select'
import { Dialog } from '../design-system/Dialog'

export type SnapshotUpdateChoice = 'merge' | 'keep' | 'replace'

type Props = {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (choice: SnapshotUpdateChoice) => void
  onCancel: () => void
}

function scopeLabel(scope: AgentMemoryScope): string {
  switch (scope) {
    case 'user':
      return 'User memory'
    case 'project':
      return 'Project memory'
    case 'local':
      return 'Local memory'
  }
}

function formatSnapshotTimestamp(snapshotTimestamp: string): string {
  const date = new Date(snapshotTimestamp)
  if (Number.isNaN(date.getTime())) {
    return snapshotTimestamp || 'unknown time'
  }
  return date.toLocaleString()
}

export function SnapshotUpdateDialog({
  agentType,
  scope,
  snapshotTimestamp,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const options = useMemo<OptionWithDescription<SnapshotUpdateChoice>[]>(
    () => [
      {
        label: 'Merge snapshot into my current memory',
        description: 'Keep local notes and copy newer snapshot files into this memory.',
        value: 'merge',
      },
      {
        label: 'Keep my current memory',
        description: 'Do not change local memory, but mark this snapshot as handled.',
        value: 'keep',
      },
      {
        label: 'Replace my current memory with the snapshot',
        description: 'Delete current memory files for this agent and copy the snapshot.',
        value: 'replace',
      },
    ],
    [],
  )
  const handleChange = useCallback(
    (choice: SnapshotUpdateChoice) => {
      onComplete(choice)
    },
    [onComplete],
  )

  return (
    <Dialog
      title="Update Agent Memory"
      subtitle={`${scopeLabel(scope)} for ${agentType}`}
      color="warning"
      onCancel={onCancel}
      hideInputGuide={true}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          A newer project snapshot is available for this agent's persistent memory.
        </Text>
        <Text dimColor={true}>
          Snapshot updated: {formatSnapshotTimestamp(snapshotTimestamp)}
        </Text>
        <Text dimColor={true}>Choose how to handle the local memory before continuing.</Text>
        <Select options={options} onChange={handleChange} onCancel={onCancel} />
      </Box>
    </Dialog>
  )
}
