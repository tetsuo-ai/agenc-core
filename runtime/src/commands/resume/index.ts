// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import type { Command } from '../../commands.js'

const resume: Command = {
  type: 'local-jsx',
  name: 'resume',
  description: 'Resume a previous conversation',
  aliases: ['continue'],
  argumentHint: '[conversation id or search term]',
  load: () => import('./resume.js'),
}

export default resume
