// Git-related behaviors that depend on user settings.
//
// This lives outside git.ts because git.ts is in the vscode extension's
// dep graph and must stay free of settings.ts and its transitive runtime deps.
// It's also a cycle:
// settings.ts → git/gitignore.ts → git.ts, so git.ts → settings.ts loops.
//
// If you're tempted to add `import settings` to git.ts — don't. Put it here.

import { getExecutionAuthoritySettings } from './settings/settings.js'

export function shouldIncludeGitInstructions(): boolean {
  return getExecutionAuthoritySettings().includeGitInstructions ?? true
}
