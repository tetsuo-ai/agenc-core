import type { DOMElement } from '../../ink.js'
import type { SpinnerMode } from './types.js'

const noopRef = (_element: DOMElement | null): void => {}

export function useShimmerAnimation(
  _mode: SpinnerMode,
  _message: string,
  _isStalled: boolean,
): [ref: (element: DOMElement | null) => void, glimmerIndex: number] {
  return [noopRef, -100]
}
