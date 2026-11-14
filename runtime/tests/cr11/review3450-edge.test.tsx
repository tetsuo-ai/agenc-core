/**
 * Two regressions an independent review found in the transcript display
 * changes (review of PR 3450, 2026-11-12). Both passed before those changes.
 */
import React from 'react';
import { marked, type Tokens } from 'marked';
import { expect, test, vi } from 'vitest';
import { renderToString } from '../../src/utils/staticRender.js';
import { MarkdownTable } from '../../src/tui/components/markdown/MarkdownTable.js';

vi.mock('bun:bundle', () => ({ feature: () => false }));
const fixture = vi.hoisted(() => ({ commands: [] as any[] }));
vi.mock('../../src/tui/hooks/useCommandQueue.js', () => ({ useCommandQueue: () => fixture.commands }));
vi.mock('../../src/tui/state/AppState.js', () => ({ useAppState: (selector: any) => selector({ isBriefOnly: false }) }));

test('a header-only table still renders its headers at narrow widths', async () => {
  const token = marked.lexer('| LongHeader | OtherHeader |\n| --- | --- |\n').find(t => t.type === 'table') as Tokens.Table;
  expect(token.rows).toHaveLength(0);
  for (const width of [12, 20, 30, 60, 120]) {
    const output = await renderToString(<MarkdownTable token={token} highlight={null} forceWidth={width} />, width);
    // Both headers, each whole.
    expect([width, output.includes('LongHeader'), output.includes('OtherHeader')]).toEqual([width, true, true]);
  }
});

test('a queued image-only content-block input retains a visible attachment indicator', async () => {
  fixture.commands = [{ mode: 'prompt', value: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }];
  const { PromptInputQueuedCommands } = await import('../../src/tui/components/PromptInput/PromptInputQueuedCommands.js');
  const output = await renderToString(<PromptInputQueuedCommands />, 80);
  expect(output).toMatch(/image/i);
  expect(output).toContain('1  [image]');
});

test('a queued input with text and an image shows both', async () => {
  fixture.commands = [{
    mode: 'prompt',
    value: [
      { type: 'text', text: 'what is on this screen' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
    ],
  }];
  const { PromptInputQueuedCommands } = await import('../../src/tui/components/PromptInput/PromptInputQueuedCommands.js');
  const output = await renderToString(<PromptInputQueuedCommands />, 80);
  expect(output).toContain('1  what is on this screen [image]');
});
