/**
 * PlanApprovalMessage — renders plan approval request/response rows.
 *
 * Adapted from the upstream plan-approval row components.
 *
 * AgenC scope notes:
 *   - The upstream JSON-string parsers (`isPlanApprovalRequest`,
 *     `isPlanApprovalResponse`, `tryRenderPlanApprovalMessage`) live in
 *     `utils/teammateMailbox.js`, which encodes the upstream
 *     per-named-agent mailbox shape. AgenC uses
 *     `plan_approval_requested` / `plan_approval_completed` event
 *     payloads instead, so the parser helpers are dropped. Callers
 *     pass typed payloads directly.
 *   - The `planMode` color key from upstream maps to the AgenC mode-plan
 *     accent. `subtle` maps to `dim`. `cyan_FOR_SUBAGENTS_ONLY` maps to
 *     `accent` (the AgenC fuchsia brand).
 *   - Plan content rendering goes through AgenC's `MarkdownBlock` for
 *     consistency with the rest of the transcript.
 *
 * @module
 */

import React from 'react'

import { Box, Text } from '../../ink-public.js'
import { MarkdownBlock } from '../MarkdownBlock.js'

export interface PlanApprovalRequest {
  /** Display name of the requesting subagent. */
  readonly from: string
  /** Markdown plan body. */
  readonly planContent: string
  /** Path on disk where the plan was persisted (optional). */
  readonly planFilePath?: string
}

export interface PlanApprovalResponse {
  readonly approved: boolean
  /** Optional reviewer feedback. Required for rejection in upstream UX. */
  readonly feedback?: string
}

/**
 * Renders a plan approval request with a plan-mode-colored border. Shows
 * the plan body and the saved file path.
 */
export function PlanApprovalRequestDisplay({
  request,
}: {
  readonly request: PlanApprovalRequest
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderStyle="round"
        borderColor="modePlan"
        flexDirection="column"
        paddingX={1}
      >
        <Box marginBottom={1}>
          <Text color="modePlan" bold>
            {`Plan Approval Request from ${request.from}`}
          </Text>
        </Box>
        <Box
          borderStyle="dashed"
          borderColor="dim"
          borderLeft={false}
          borderRight={false}
          flexDirection="column"
          paddingX={1}
          marginBottom={1}
        >
          <MarkdownBlock content={request.planContent} isComplete />
        </Box>
        {request.planFilePath ? (
          <Text dimColor>{`Plan file: ${request.planFilePath}`}</Text>
        ) : null}
      </Box>
    </Box>
  )
}

/**
 * Renders a plan approval response — green-bordered for approval,
 * red-bordered for rejection — with optional feedback.
 */
export function PlanApprovalResponseDisplay({
  response,
  senderName,
}: {
  readonly response: PlanApprovalResponse
  readonly senderName: string
}): React.ReactElement {
  if (response.approved) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Box
          borderStyle="round"
          borderColor="success"
          flexDirection="column"
          paddingX={1}
          paddingY={1}
        >
          <Box>
            <Text color="success" bold>
              {`✓ Plan Approved by ${senderName}`}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text>
              {
                'You can now proceed with implementation. Your plan mode restrictions have been lifted.'
              }
            </Text>
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderStyle="round"
        borderColor="error"
        flexDirection="column"
        paddingX={1}
        paddingY={1}
      >
        <Box>
          <Text color="error" bold>
            {`✗ Plan Rejected by ${senderName}`}
          </Text>
        </Box>
        {response.feedback ? (
          <Box
            marginTop={1}
            borderStyle="dashed"
            borderColor="dim"
            borderLeft={false}
            borderRight={false}
            paddingX={1}
          >
            <Text>{`Feedback: ${response.feedback}`}</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text dimColor>
            {'Please revise your plan based on the feedback and call ExitPlanMode again.'}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Get a brief summary text for a plan approval payload. Used in places
 * like the inbox queue where we want a short single-line description.
 */
export function getPlanApprovalSummary(
  payload:
    | { readonly kind: 'request'; readonly from: string }
    | { readonly kind: 'response'; readonly approved: boolean; readonly feedback?: string },
): string {
  if (payload.kind === 'request') {
    return `[Plan Approval Request from ${payload.from}]`
  }
  if (payload.approved) {
    return '[Plan Approved] You can now proceed with implementation'
  }
  return `[Plan Rejected] ${payload.feedback || 'Please revise your plan'}`
}

export default PlanApprovalRequestDisplay
