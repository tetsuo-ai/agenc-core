/**
 * Renders an image attachment in user messages.
 *
 * AgenC's image-paste pipeline (composer → runtime image store) is
 * still in progress, so this renderer currently displays a static
 * `[Image #n]` label. When AgenC lands a hyperlink-capable image-store
 * lookup, swap the label for a clickable `Link` to the on-disk file
 * path.
 *
 * TODO(tranche-5): wire to AgenC image-paste store once ported and
 * gate the hyperlink on `supportsHyperlinks()`.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'

import { MessageResponse } from './_helpers.js'

export interface UserImageMessageProps {
  readonly imageId?: number
  readonly addMargin?: boolean
}

export function UserImageMessage({
  imageId,
  addMargin,
}: UserImageMessageProps): React.ReactNode {
  const label = imageId !== undefined ? `[Image #${imageId}]` : '[Image]'
  const content = <Text>{label}</Text>

  if (addMargin) {
    return <Box marginTop={1}>{content}</Box>
  }
  return <MessageResponse>{content}</MessageResponse>
}
