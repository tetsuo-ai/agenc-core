import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskCard } from './TaskCard';

afterEach(cleanup);

describe('TaskCard', () => {
  it('shows [cancel] only for own open task (creator === agentWallet)', () => {
    const onClaim = vi.fn();
    const onComplete = vi.fn();
    const onDispute = vi.fn();
    const onCancel = vi.fn();

    render(
      <TaskCard
        task={{
          id: 'task-own',
          status: 'open',
          description: 'My task',
          reward: '1.5',
          creator: 'wallet-abc',
        }}
        agentWallet="wallet-abc"
        onClaim={onClaim}
        onComplete={onComplete}
        onDispute={onDispute}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '[cancel]' }));

    expect(onCancel).toHaveBeenCalledWith('task-own');
    expect(screen.queryByRole('button', { name: '[claim]' })).toBeNull();
  });

  it('shows [claim] only for someone else\'s open task (creator !== agentWallet)', () => {
    const onClaim = vi.fn();
    const onComplete = vi.fn();
    const onDispute = vi.fn();
    const onCancel = vi.fn();

    render(
      <TaskCard
        task={{
          id: 'task-other',
          status: 'open',
          description: 'Someone else\'s task',
          reward: '2',
          creator: 'wallet-xyz',
        }}
        agentWallet="wallet-abc"
        onClaim={onClaim}
        onComplete={onComplete}
        onDispute={onDispute}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '[claim]' }));

    expect(onClaim).toHaveBeenCalledWith('task-other');
    expect(screen.queryByRole('button', { name: '[cancel]' })).toBeNull();
  });

  it('shows neither [claim] nor [cancel] when wallet is unavailable', () => {
    render(
      <TaskCard
        task={{
          id: 'task-open',
          status: 'open',
          description: 'Open task',
          reward: '1.5',
        }}
        onClaim={vi.fn()}
        onComplete={vi.fn()}
        onDispute={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '[claim]' })).toBeNull();
    expect(screen.queryByRole('button', { name: '[cancel]' })).toBeNull();
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
