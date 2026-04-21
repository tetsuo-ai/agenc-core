/**
 * ResizeEvent type. Upstream references this type but never ships the
 * declaration; the structural shape matches `event.ts` + width/height.
 */

import { Event } from './event.js'

export class ResizeEvent extends Event {
  readonly type = 'resize' as const
  constructor(
    public readonly columns: number,
    public readonly rows: number,
  ) {
    super()
  }
}
