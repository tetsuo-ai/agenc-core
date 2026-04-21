/**
 * Cursor state for rendered frames. Upstream references this type from
 * `frame.ts` but never ships the declaration; the structural shape is fixed
 * by log-update.ts and ink.tsx which read `cursor.x`, `cursor.y`, and
 * `cursor.visible`.
 */

export type Cursor = {
  x: number
  y: number
  visible: boolean
}
