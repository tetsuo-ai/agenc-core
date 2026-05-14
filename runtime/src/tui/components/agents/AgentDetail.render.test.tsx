import React from 'react';
import stripAnsi from 'strip-ansi';
import { describe, expect, test, vi } from 'vitest';

import { renderToString } from '../../../utils/staticRender.js';
import { AgentDetail } from './AgentDetail.js';

vi.mock('bun:bundle', () => ({
  feature: () => false,
}));

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 24, rows: 20 }),
}));

vi.mock('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: () => undefined,
}));

vi.mock('../markdown/Markdown.js', () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => children,
}));

describe('AgentDetail rendering', () => {
  test('wraps long detail values inside the visible width', async () => {
    const agent = {
      agentType: 'very-long-agent-name',
      source: 'projectSettings',
      baseDir: '/tmp/very/long/agent/base/path/that/should/wrap',
      filename: 'agent-with-a-very-long-file-name.md',
      whenToUse: 'Use this agent when a request includes extremely long descriptive metadata.',
      tools: ['Read', 'VeryLongMissingToolNameThatMustWrap'],
      hooks: {
        VeryLongHookNameThatMustWrap: [],
      },
      skills: ['VeryLongSkillNameThatMustWrap'],
      model: 'very-long-model-name-that-must-wrap',
      permissionMode: 'default',
      memory: 'project',
      getSystemPrompt: () => 'System prompt content with enough text to wrap in the detail pane.',
    };

    const output = stripAnsi(await renderToString(
      <AgentDetail
        agent={agent as any}
        tools={[{ name: 'Read' }] as any}
        onBack={() => undefined}
      />,
      24,
    ));

    expect(output).toContain('Description');
    expect(output).toContain('VeryLongMissingToolN');
    expect(output).toContain('ameThatMustWrap');
    expect(Math.max(...output.split('\n').map(line => line.length))).toBeLessThanOrEqual(24);
  });
});
