import figures from 'figures';

import { resolveAgenCTuiGlyphMode, selectAgenCTuiGlyphs } from '../../../glyphs.js';

export type PreviewBoxGlyphs = {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly teeLeft: string;
  readonly teeRight: string;
};

export type AskUserQuestionGlyphs = {
  readonly arrowDown: string;
  readonly arrowLeft: string;
  readonly arrowRight: string;
  readonly arrowUp: string;
  readonly checkboxOff: string;
  readonly checkboxOn: string;
  readonly ellipsis: string;
  readonly pointer: string;
  readonly previewBox: PreviewBoxGlyphs;
  readonly separator: string;
  readonly statusSuccess: string;
  readonly truncationMarker: string;
};

const UNICODE_PREVIEW_BOX_GLYPHS: PreviewBoxGlyphs = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
};

const ASCII_PREVIEW_BOX_GLYPHS: PreviewBoxGlyphs = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  teeLeft: '+',
  teeRight: '+',
};

export function selectAskUserQuestionGlyphs(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): AskUserQuestionGlyphs {
  const glyphs = selectAgenCTuiGlyphs(env);
  const mode = resolveAgenCTuiGlyphMode(env);

  if (mode === 'ascii') {
    return {
      arrowDown: glyphs.arrowDown,
      arrowLeft: glyphs.arrowLeft,
      arrowRight: glyphs.arrowRight,
      arrowUp: glyphs.arrowUp,
      checkboxOff: '[ ]',
      checkboxOn: '[x]',
      ellipsis: glyphs.ellipsis,
      pointer: glyphs.pointer,
      previewBox: ASCII_PREVIEW_BOX_GLYPHS,
      separator: glyphs.separator,
      statusSuccess: glyphs.statusSuccess,
      truncationMarker: 'cut',
    };
  }

  return {
    arrowDown: glyphs.arrowDown,
    arrowLeft: glyphs.arrowLeft,
    arrowRight: glyphs.arrowRight,
    arrowUp: glyphs.arrowUp,
    checkboxOff: figures.checkboxOff,
    checkboxOn: figures.checkboxOn,
    ellipsis: glyphs.ellipsis,
    pointer: glyphs.pointer,
    previewBox: UNICODE_PREVIEW_BOX_GLYPHS,
    separator: glyphs.separator,
    statusSuccess: glyphs.statusSuccess,
    truncationMarker: '✂',
  };
}

export function getPreviewBoxTruncationLabel(
  hiddenCount: number,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const glyphs = selectAskUserQuestionGlyphs(env);
  const box = glyphs.previewBox;
  return `${box.horizontal.repeat(3)} ${glyphs.truncationMarker} ${box.horizontal.repeat(3)} ${hiddenCount} lines hidden `;
}
