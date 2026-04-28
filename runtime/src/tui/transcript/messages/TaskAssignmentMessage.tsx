/**
 * TaskAssignmentMessage — renders a task-assignment row when one subagent
 * delegates work to another.
 *
 * Adapted from the upstream task-assignment row component.
 *
 * AgenC scope notes:
 *   - Upstream wires this to its `teammateMailbox` JSON-string parser
 *     (per-named-agent swarm shape). AgenC's runtime emits structured
 *     `collab_agent_spawn_*` / `collab_agent_interaction_*` events
 *     instead, so the JSON-string parser path is dropped. Callers pass
 *     typed payloads directly.
 *   - The upstream `cyan_FOR_SUBAGENTS_ONLY` border color maps to AgenC's
 *     `accent` brand color.
 *   - Per-agent custom colors don't exist in AgenC's thread state. Use
 *     `accent` as the default border color.
 *
 * @module
 */

import React from 'react'

import { Box, Text } from '../../ink-public.js'

export interface TaskAssignment {
  /** Stable task identifier — usually the runtime's `callId`. */
  readonly taskId: string
  /** Display name / nickname of the delegating subagent. */
  readonly assignedBy: string
  /** Short single-line subject of the task. */
  readonly subject: string
  /** Optional longer description of the task. */
  readonly description?: string
}

/**
 * Renders a task assignment row with a brand-accent border.
 */
export function TaskAssignmentDisplay({
  assignment,
}: {
  readonly assignment: TaskAssignment
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderStyle="round"
        borderColor="accent"
        flexDirection="column"
        paddingX={1}
        paddingY={1}
      >
        <Box marginBottom={1}>
          <Text color="accent" bold>
            {`Task #${assignment.taskId} assigned by ${assignment.assignedBy}`}
          </Text>
        </Box>
        <Box>
          <Text bold>{assignment.subject}</Text>
        </Box>
        {assignment.description ? (
          <Box marginTop={1}>
            <Text dimColor>{assignment.description}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

/**
 * Get a brief summary text for a task assignment. Used in places like
 * the inbox queue where we want a short single-line description.
 */
export function getTaskAssignmentSummary(
  assignment: TaskAssignment,
): string {
  return `[Task Assigned] #${assignment.taskId} - ${assignment.subject}`
}

export default TaskAssignmentDisplay
