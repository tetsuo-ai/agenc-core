import { selectAgenCTuiGlyphs } from '../../../glyphs.js';

export function getEnterPlanModeBulletPrefix(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  return ` ${selectAgenCTuiGlyphs(env).separator} `;
}
