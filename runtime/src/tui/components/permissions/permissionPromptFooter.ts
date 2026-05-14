import { selectAgenCTuiGlyphs } from '../../glyphs.js';

export function getPermissionPromptFooterText(
  showTabHint: boolean,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  if (!showTabHint) {
    return 'Esc to cancel';
  }

  return `Esc to cancel ${selectAgenCTuiGlyphs(env).separator} Tab to amend`;
}
