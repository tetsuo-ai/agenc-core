/**
 * Renders an attachment summary line in the user-message stream
 * (e.g. "Read /path/to/file.ts (124 lines)" or "Listed directory
 * /src/").
 *
 * AgenC stub. The full upstream renderer dispatches across ~30
 * attachment sub-types (notebooks, IDE selections, MCP resources,
 * plan-file references, hook events, teammate mailbox, skill
 * discovery, etc.). AgenC's attachment shape is still evolving — see
 * `runtime/src/prompts/attachments/types.ts` once those are wired
 * into the transcript stream — so this stub renders a minimal
 * display-only row that the lead can extend per attachment kind in
 * tranche 5.
 *
 * TODO(tranche-5): expand the dispatch table once AgenC's attachment
 * type union is finalized.
 */
import * as React from 'react'

import { Box, Text, type TextProps } from '../../ink-public.js'

import FullWidthRow from '../../design-system/FullWidthRow.js'

import { MessageResponse } from './_helpers.js'

export interface AttachmentMessageStubAttachment {
  /** Discriminator for the attachment variant. */
  readonly type: string
  /**
   * Best-effort display path; populated by the attachment producer
   * for file/directory references. Optional so unknown attachment
   * variants render a one-line fallback.
   */
  readonly displayPath?: string
}

export interface AttachmentMessageProps {
  readonly addMargin: boolean
  readonly attachment: AttachmentMessageStubAttachment
  readonly verbose: boolean
  readonly isTranscriptMode?: boolean
}

export function AttachmentMessage({
  attachment,
}: AttachmentMessageProps): React.ReactNode {
  // Until the AgenC attachment shape is finalized, render a minimal
  // one-line summary. Concrete sub-cases (file/notebook/selected-lines/
  // etc.) will replace this in tranche 5 — see TODO at top of file.
  if (attachment.displayPath) {
    return (
      <Line>
        Attachment <Text bold>{attachment.displayPath}</Text>{' '}
        <Text dimColor>({attachment.type})</Text>
      </Line>
    )
  }
  return (
    <Line>
      <Text dimColor>{attachment.type}</Text>
    </Line>
  )
}

function Line({
  children,
  color,
  dimColor = true,
}: {
  children: React.ReactNode
  color?: TextProps['color']
  dimColor?: boolean
}): React.ReactNode {
  return (
    <Box>
      <MessageResponse>
        <FullWidthRow>
          <Text {...(color !== undefined ? { color } : {})} dimColor={dimColor}>
            {children}
          </Text>
        </FullWidthRow>
      </MessageResponse>
    </Box>
  )
}
