// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
// Content for the verify bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import cliMd from './verify/examples/cli.md'
import serverMd from './verify/examples/server.md'
import skillMd from './verify/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/cli.md': cliMd,
  'examples/server.md': serverMd,
}
