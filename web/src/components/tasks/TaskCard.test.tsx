import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskCard } from './TaskCard';

afterEach(() => {
  cleanup();
});

describe('TaskCard', () => {
  it('shows claim for open tasks the signer can accept', () => {
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
          claimableBySigner: true,
        }}
        onClaim={onClaim}
        onComplete={onComplete}
        onDispute={onDispute}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '[claim]' }));

    expect(onClaim).toHaveBeenCalledWith('task-open');
    expect(screen.queryByRole('button', { name: '[cancel]' })).toBeNull();
    expect(screen.queryByRole('button', { name: '[complete]' })).toBeNull();
  });

  it('shows cancel for signer-owned open tasks', () => {
    const onClaim = vi.fn();
    const onComplete = vi.fn();
    const onDispute = vi.fn();
    const onCancel = vi.fn();

    render(
      <TaskCard
        task={{
          id: 'task-owned',
          status: 'open',
          description: 'Owned task',
          reward: '2',
          ownedBySigner: true,
        }}
        onClaim={onClaim}
        onComplete={onComplete}
        onDispute={onDispute}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '[cancel]' }));

    expect(onCancel).toHaveBeenCalledWith('task-owned');
    expect(screen.queryByRole('button', { name: '[claim]' })).toBeNull();
  });

  it('opens completion and dispute forms for signer-assigned in-progress tasks', () => {
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
          assignedToSigner: true,
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
