// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import type { Command } from '../../commands.js'

const provider = {
  type: 'local-jsx',
  name: 'provider',
  description: 'Manage API provider profiles',
  load: () => import('./provider.js'),
} satisfies Command

export default provider
