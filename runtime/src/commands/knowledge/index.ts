// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import type { Command } from '../../commands.js'

const knowledge: Command = {
  type: 'local',
  name: 'knowledge',
  description: 'Manage native Knowledge Graph',
  supportsNonInteractive: true,
  argumentHint: 'enable <yes|no> | clear | status | list',
  load: () => import('./knowledge.js'),
}

export default knowledge
