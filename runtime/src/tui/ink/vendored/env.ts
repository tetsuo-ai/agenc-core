/**
 * Vendored from AgenC/src/utils/env.ts — only the `env` object fields
 * referenced by the Ink core. Terminal detection is trimmed to what the
 * ported code actually consults (`env.terminal`).
 */

function detectTerminal(): string | null {
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('cursor')) return 'cursor'
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('windsurf')) {
    return 'windsurf'
  }
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('antigravity')) {
    return 'antigravity'
  }

  if (process.env.TERM === 'xterm-ghostty') return 'ghostty'
  if (process.env.TERM?.includes('kitty')) return 'kitty'

  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM

  if (process.env.TMUX) return 'tmux'
  if (process.env.STY) return 'screen'

  if (process.env.KONSOLE_VERSION) return 'konsole'
  if (process.env.GNOME_TERMINAL_SERVICE) return 'gnome-terminal'
  if (process.env.XTERM_VERSION) return 'xterm'
  if (process.env.VTE_VERSION) return 'vte-based'
  if (process.env.TERMINATOR_UUID) return 'terminator'
  if (process.env.KITTY_WINDOW_ID) return 'kitty'
  if (process.env.ALACRITTY_LOG) return 'alacritty'
  if (process.env.TILIX_ID) return 'tilix'

  if (process.env.WT_SESSION) return 'windows-terminal'

  if (process.env.TERM) {
    const term = process.env.TERM
    if (term.includes('alacritty')) return 'alacritty'
    if (term.includes('rxvt')) return 'rxvt'
    if (term.includes('termite')) return 'termite'
    return term
  }

  if (!process.stdout.isTTY) return 'non-interactive'

  return null
}

export const env = {
  terminal: detectTerminal(),
  platform: (['win32', 'darwin'].includes(process.platform)
    ? process.platform
    : 'linux') as 'win32' | 'darwin' | 'linux',
}
