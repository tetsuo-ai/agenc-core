import React from 'react'
import { pathToFileURL } from 'node:url'
import { Link, Text } from '../ink-public.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import type { Theme } from '../theme.js'

type Props = {
  /** The image identifier shown in `[Image #N]`. */
  imageId: number
  /**
   * Optional resolved file path for the image. If provided and the
   * terminal supports OSC 8 hyperlinks, the rendered text becomes a
   * clickable link that opens the file. AgenC does not yet ship a
   * built-in image store, so callers resolve the path themselves.
   */
  imagePath?: string
  backgroundColor?: keyof Theme['colors']
  isSelected?: boolean
}

/**
 * Renders an image reference like `[Image #1]` as a clickable hyperlink
 * when both:
 *   - the terminal supports OSC 8 hyperlinks
 *   - the caller has resolved an `imagePath`
 *
 * Falls back to styled plain text otherwise.
 */
export function ClickableImageRef({
  imageId,
  imagePath,
  backgroundColor,
  isSelected = false,
}: Props): React.ReactElement {
  const displayText = `[Image #${imageId}]`

  if (imagePath && supportsHyperlinks()) {
    const fileUrl = pathToFileURL(imagePath).href
    const fallback = (
      <Text backgroundColor={backgroundColor} inverse={isSelected}>
        {displayText}
      </Text>
    )
    const inner = (
      <Text
        backgroundColor={backgroundColor}
        inverse={isSelected}
        bold={isSelected}
      >
        {displayText}
      </Text>
    )
    return (
      <Link url={fileUrl} fallback={fallback}>
        {inner}
      </Link>
    )
  }

  return (
    <Text backgroundColor={backgroundColor} inverse={isSelected}>
      {displayText}
    </Text>
  )
}
