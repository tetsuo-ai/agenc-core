/**
 * PasteEvent type. Upstream references this type but never ships the
 * declaration; the structural shape matches `event.ts` + a `data` payload.
 */

import { Event } from './event.js'

export class PasteEvent extends Event {
  readonly type = 'paste' as const
  constructor(public readonly data: string) {
    super()
  }
}
