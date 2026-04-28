/**
 * TrustDialog
 *
 * Ported from upstream. Asks the operator whether they trust the current
 * workspace before AgenC reads, edits, or executes files inside it.
 *
 * Wires to `runtime/src/permissions/approval-policy.ts`'s `ProjectTrust`
 * shape — the dialog returns `'trusted'` on accept and `'untrusted'` on
 * decline. The host is expected to persist that decision (so the prompt
 * is not re-shown on every launch) and call `resolveApprovalPolicy` with
 * the new trust value.
 */

import React, { useCallback, useMemo } from 'react'

import { Box, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

import type { ProjectTrust } from '../../permissions/approval-policy.js'

type DialogValue = 'enable_all' | 'exit'

export interface TrustDialogProps {
  /** Workspace path that the operator is being asked to trust. */
  readonly cwd: string
  /**
   * Called once the operator picks an answer. The value is the
   * resolved `ProjectTrust` for the workspace (`'trusted'` or
   * `'untrusted'`). The host is expected to persist this and pass it
   * into `resolveApprovalPolicy({ projectTrust })`.
   */
  readonly onResolve: (trust: ProjectTrust) => void
  /**
   * Optional list of human-readable reasons explaining why this prompt
   * was triggered (e.g. "this workspace ships hooks", "MCP servers
   * configured at project scope"). Surfaced as dim secondary text.
   */
  readonly reasons?: readonly string[]
}

const OPTIONS: ReadonlyArray<{ value: DialogValue; label: string }> = [
  { value: 'enable_all', label: 'Yes, I trust this folder' },
  { value: 'exit', label: 'No, exit' },
]

export function TrustDialog({
  cwd,
  onResolve,
  reasons = [],
}: TrustDialogProps): React.ReactElement {
  const handleChange = useCallback(
    (value: DialogValue) => {
      onResolve(value === 'enable_all' ? 'trusted' : 'untrusted')
    },
    [onResolve],
  )

  const handleCancel = useCallback(() => {
    onResolve('untrusted')
  }, [onResolve])

  const reasonList = useMemo(
    () => reasons.filter((reason) => reason.trim().length > 0),
    [reasons],
  )

  return (
    <Dialog
      title="Accessing workspace:"
      color="warning"
      onCancel={handleCancel}
    >
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold={true}>{cwd}</Text>
        <Text>
          Quick safety check: is this a project you created or one you trust?
          (Like your own code, a well-known open-source project, or work from
          your team.) If not, take a moment to review what is in this folder
          first.
        </Text>
        <Text>
          AgenC will be able to read, edit, and execute files here.
        </Text>
        {reasonList.length > 0 ? (
          <Box flexDirection="column">
            <Text dimColor={true}>This workspace also has:</Text>
            {reasonList.map((reason) => (
              <Text key={reason} dimColor={true}>
                {`  · ${reason}`}
              </Text>
            ))}
          </Box>
        ) : null}
        <Select<DialogValue>
          options={OPTIONS}
          onChange={handleChange}
          onCancel={handleCancel}
        />
      </Box>
    </Dialog>
  )
}

export default TrustDialog
