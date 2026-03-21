import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskCard } from './TaskCard';

describe('TaskCard', () => {
  it('shows open-task actions and dispatches claim/cancel', () => {
    const onClaim = vi.fn();
    const onComplete = vi.fn();
    const onDispute = vi.fn();
    const onCancel = vi.fn();

    render(
      <TaskCard
        task={{
          id: 'task-open',
          status: 'open',
          description: 'Open task',
          reward: '1.5',
        }}
        onClaim={onClaim}
        onComplete={onComplete}
        onDispute={onDispute}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '[claim]' }));
    fireEvent.click(screen.getByRole('button', { name: '[cancel]' }));

    expect(onClaim).toHaveBeenCalledWith('task-open');
    expect(onCancel).toHaveBeenCalledWith('task-open');
    expect(screen.queryByRole('button', { name: '[complete]' })).toBeNull();
  });

  it('opens completion and dispute forms for in-progress tasks', () => {
    const onClaim = vi.fn();
    const onComplete = vi.fn();
    const onDispute = vi.fn();
    const onCancel = vi.fn();

    render(
      <TaskCard
        task={{
          id: 'task-progress',
          status: 'in_progress',
          description: 'Working task',
          reward: '2',
          worker: '1 worker(s)',
        }}
        onClaim={onClaim}
        onComplete={onComplete}
        onDispute={onDispute}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '[complete]' }));
    fireEvent.change(
      screen.getByPlaceholderText('attach a short public completion note'),
      { target: { value: 'Done and verified' } },
    );
    fireEvent.click(screen.getByRole('button', { name: '[submit completion]' }));

    fireEvent.click(screen.getByRole('button', { name: '[dispute]' }));
    fireEvent.change(
      screen.getByPlaceholderText('describe why this task should enter dispute review'),
      { target: { value: 'Requester rejected a valid result' } },
    );
    fireEvent.change(screen.getByDisplayValue('refund'), {
      target: { value: 'split' },
    });
    fireEvent.click(screen.getByRole('button', { name: '[open dispute]' }));

    expect(onComplete).toHaveBeenCalledWith('task-progress', 'Done and verified');
    expect(onDispute).toHaveBeenCalledWith(
      'task-progress',
      'Requester rejected a valid result',
      'split',
    );
    expect(onClaim).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
