import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SessionCommandResult } from '../../types';
import { CommandResultPanel } from './CommandResultPanel';

function makeResult(data: any, overrides: Partial<SessionCommandResult> = {}) {
  return {
    commandName: 'test',
    content: 'fallback content',
    viewKind: data?.kind ?? 'text',
    data,
    ...overrides,
  } as SessionCommandResult;
}

describe('CommandResultPanel', () => {
  it('renders runtime, policy, and extensions as structured views', () => {
    render(
      <CommandResultPanel
        result={makeResult({
          kind: 'runtime',
          surface: 'status',
          status: 'healthy',
          metrics: [
            { label: 'Queued', value: '2', tone: 'neutral' },
            { label: 'Draining', value: '0', tone: 'success' },
          ],
          sections: [
            {
              title: 'Memory',
              body: 'Context cache is warm.',
              items: ['inputs: 4', 'hits: 12'],
            },
          ],
          detail: { source: 'daemon' },
        })}
      />,
    );

    expect(screen.getByText('Runtime / status')).toBeTruthy();
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('Memory')).toBeTruthy();
    expect(screen.getByText('Context cache is warm.')).toBeTruthy();
    expect(screen.getByText(/source/i)).toBeTruthy();
  });

  it('renders git, diff, files, grep, and tasks summaries from structured data', () => {
    const { rerender } = render(
      <CommandResultPanel
        result={makeResult({
          kind: 'git',
          subcommand: 'status',
          branchInfo: {
            branch: 'feature/session-contract-hardening',
            head: 'abc123',
            upstream: 'origin/main',
            ahead: 1,
            behind: 0,
          },
          changeSummary: {
            summary: '2 files changed',
            files: [
              {
                path: 'web/src/components/chat/CommandResultPanel.tsx',
                status: 'modified',
                additions: 12,
                deletions: 3,
              },
            ],
          },
        })}
      />,
    );

    expect(screen.getByText('Git')).toBeTruthy();
    expect(screen.getByText('feature/session-contract-hardening')).toBeTruthy();
    expect(screen.getAllByText(/2 files changed/).length).toBeGreaterThan(0);
    expect(screen.getByText('web/src/components/chat/CommandResultPanel.tsx')).toBeTruthy();

    rerender(
      <CommandResultPanel
        result={makeResult({
          kind: 'diff',
          subcommand: 'workspace',
          branchInfo: {
            branch: 'feature/session-contract-hardening',
            head: 'abc123',
          },
          changeSummary: {
            summary: '1 file changed',
            staged: 1,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
          },
          diff: {
            type: 'patch',
            files: [
              {
                path: 'web/src/types.ts',
                status: 'modified',
                additions: 4,
                deletions: 1,
              },
            ],
          },
        })}
      />,
    );

    expect(screen.getByText('Diff')).toBeTruthy();
    expect(screen.getByText('1 file changed')).toBeTruthy();
    expect(screen.getByText('web/src/types.ts')).toBeTruthy();

    rerender(
      <CommandResultPanel
        result={makeResult({
          kind: 'files',
          mode: 'search',
          query: 'CommandResultPanel',
          result: {
            count: 1,
            root: '/workspace',
            files: [
              {
                path: 'web/src/components/chat/CommandResultPanel.tsx',
                type: 'file',
                size: 1200,
                preview: 'CommandResultPanel',
              },
            ],
          },
        })}
      />,
    );

    expect(screen.getAllByText('Files').length).toBeGreaterThan(0);
    expect(screen.getAllByText('CommandResultPanel').length).toBeGreaterThan(0);

    rerender(
      <CommandResultPanel
        result={makeResult({
          kind: 'grep',
          pattern: 'bootstrap',
          result: {
            matchCount: 1,
            root: '/workspace',
            matches: [
              {
                path: 'web/src/hooks/useChat.ts',
                line: 42,
                column: 3,
                snippet: 'bootstrap ready',
              },
            ],
          },
        })}
      />,
    );

    expect(screen.getByText('Grep')).toBeTruthy();
    expect(screen.getByText('bootstrap')).toBeTruthy();
    expect(screen.getByText('web/src/hooks/useChat.ts')).toBeTruthy();

    rerender(
      <CommandResultPanel
        result={makeResult({
          kind: 'tasks',
          subcommand: 'list',
          taskId: 'task-1',
          result: {
            count: 1,
            status: 'open',
            tasks: [
              {
                id: 'task-1',
                status: 'open',
                worker: 'worker-7',
                reward: '10',
                description: 'Finish the slice',
              },
            ],
          },
        })}
      />,
    );

    expect(screen.getAllByText('Tasks').length).toBeGreaterThan(0);
    expect(screen.getAllByText('task-1').length).toBeGreaterThan(0);
    expect(screen.getByText('Finish the slice')).toBeTruthy();
  });

  it('renders review and verify summaries without collapsing to raw JSON first', () => {
    const { rerender } = render(
      <CommandResultPanel
        result={makeResult({
          kind: 'review',
          mode: 'security',
          delegated: true,
          branchInfo: { branch: 'main', head: 'def456' },
          changeSummary: { summary: 'security review queued', files: ['a.ts', 'b.ts'] },
          reviewSurface: {
            status: 'running',
            source: 'delegated',
            summaryPreview: 'Review in progress',
          },
          delegatedResult: {
            sessionId: 'subagent:review',
            status: 'running',
            output: 'Reviewing',
          },
        })}
      />,
    );

    expect(screen.getByText('Review')).toBeTruthy();
    expect(screen.getByText('security')).toBeTruthy();
    expect(screen.getByText('running (delegated)')).toBeTruthy();
    expect(screen.getAllByText('Review in progress').length).toBeGreaterThan(0);

    rerender(
      <CommandResultPanel
        result={makeResult({
          kind: 'verify',
          delegated: false,
          branchInfo: { branch: 'main', head: 'def456' },
          changeSummary: { tasks: ['verify-a', 'verify-b'] },
          runtimeStatusSnapshot: {
            status: 'healthy',
            load: 'low',
            budget: 'open',
            phase: 'stabilizing',
          },
          verificationSurface: {
            status: 'completed',
            source: 'local',
            verdict: 'pass',
            summaryPreview: 'All checks passed',
          },
        })}
      />,
    );

    expect(screen.getByText('Verify')).toBeTruthy();
    expect(screen.getByText('pass')).toBeTruthy();
    expect(screen.getByText('All checks passed')).toBeTruthy();
    expect(screen.getAllByText('healthy').length).toBeGreaterThan(0);
  });
});
