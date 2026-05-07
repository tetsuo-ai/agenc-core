// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import type { Command } from '../../commands.js'

type LocalJsxCommandModule = Awaited<
  ReturnType<Extract<Command, { type: 'local-jsx' }>['load']>
>

const btw = {
  type: 'local-jsx',
  name: 'btw',
  description:
    'Ask a quick side question without interrupting the main conversation',
  immediate: true,
  argumentHint: '<question>',
  load: async (): Promise<LocalJsxCommandModule> => {
    const mod = await import('./btw.js')
    return { call: mod.call as unknown as LocalJsxCommandModule['call'] }
  },
} satisfies Command

export default btw
