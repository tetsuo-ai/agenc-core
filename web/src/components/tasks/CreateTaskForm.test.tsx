import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskForm } from './CreateTaskForm';

afterEach(() => {
  cleanup();
});

describe('CreateTaskForm', () => {
  it('renders approved task templates instead of a blank freeform task box', () => {
    render(<CreateTaskForm onCreate={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '[new task]' }));

    expect(screen.getByText('approved task recipe')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Web Research Brief/i })).toBeTruthy();
    expect(screen.queryByPlaceholderText('describe the task expected from the agent')).toBeNull();
  });

  it('submits a bounded template payload for the selected task type', () => {
    const onCreate = vi.fn();
    render(<CreateTaskForm onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: '[new task]' }));
    fireEvent.change(screen.getByPlaceholderText('AI meeting assistants'), {
      target: { value: 'AI note-taking tools' },
    });
    fireEvent.change(screen.getByPlaceholderText('North America'), {
      target: { value: 'United States' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Timeframe' }), {
      target: { value: 'last 12 months' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Allowed sources' }), {
      target: { value: 'company websites and approved review sites' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Max sources' }), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Output length' }), {
      target: { value: 'brief plus comparison table' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Reward (SOL)' }), {
      target: { value: '0.12' },
    });

    fireEvent.click(screen.getByRole('button', { name: '[create]' }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Research brief: AI note-taking tools',
      reward: 0.12,
      acceptanceCriteria: expect.arrayContaining(['Include citations for each major claim.']),
      deliverables: ['Cited markdown brief', 'Source list'],
      constraints: expect.objectContaining({
        taskTemplateId: 'web_research_brief',
        taskTemplateVersion: 1,
        outputFormat: 'markdown brief',
      }),
      jobSpec: expect.objectContaining({
        kind: 'agenc.web.boundedTaskTemplateRequest',
        templateId: 'web_research_brief',
        templateVersion: 1,
        sourcePolicy: 'Allowlisted public web only',
        inputs: expect.objectContaining({
          topic: 'AI note-taking tools',
          region: 'United States',
          timeframe: 'last 12 months',
        }),
      }),
    }));
  });
});
