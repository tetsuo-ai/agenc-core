import { selectAgenCTuiGlyphs } from '../../../glyphs.js';

export type BashPermissionFooterState = {
  readonly focusedOption: string | null | undefined;
  readonly yesInputMode: boolean;
  readonly noInputMode: boolean;
  readonly explainerEnabled: boolean;
  readonly explainerVisible: boolean;
};

export function getBashPermissionFooterText(
  state: BashPermissionFooterState,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const glyphs = selectAgenCTuiGlyphs(env);
  const parts = ['Esc to cancel'];

  if (
    (state.focusedOption === 'yes' && !state.yesInputMode) ||
    (state.focusedOption === 'no' && !state.noInputMode)
  ) {
    parts.push('Tab to amend');
  }

  if (state.explainerEnabled) {
    parts.push(`ctrl+e to ${state.explainerVisible ? 'hide' : 'explain'}`);
  }

  return parts.join(` ${glyphs.separator} `);
}
