import React from 'react'
import type { Theme } from '../theme.js'
import ThemedText from './ThemedText.js'

type Props = {
  /** Progress fraction in [0, 1]. */
  ratio: number
  /** How many characters wide to draw the progress bar. */
  width: number
  /** Optional theme color key for the filled portion. */
  fillColor?: keyof Theme['colors']
  /** Optional theme color key for the empty (background) portion. */
  emptyColor?: keyof Theme['colors']
}

const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

/**
 * Single-line block-character progress bar. Sub-cell precision via
 * the eighth-block characters; clamps `ratio` to [0, 1].
 *
 * @example
 * <ProgressBar ratio={0.42} width={20} fillColor="accent" emptyColor="line" />
 */
export function ProgressBar({
  ratio: inputRatio,
  width,
  fillColor,
  emptyColor,
}: Props) {
  const ratio = Math.min(1, Math.max(0, inputRatio))
  const whole = Math.floor(ratio * width)
  const segments: string[] = [BLOCKS[BLOCKS.length - 1].repeat(whole)]
  if (whole < width) {
    const remainder = ratio * width - whole
    const middle = Math.floor(remainder * BLOCKS.length)
    segments.push(BLOCKS[middle])
    const empty = width - whole - 1
    if (empty > 0) {
      segments.push(BLOCKS[0].repeat(empty))
    }
  }
  return (
    <ThemedText color={fillColor} backgroundColor={emptyColor}>
      {segments.join('')}
    </ThemedText>
  )
}
