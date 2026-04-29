import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceView } from './MarketplaceView';
import type { MarketplaceViewProps } from './MarketplaceView';

afterEach(() => {
  cleanup();
});

function createProps(): MarketplaceViewProps {
  return {
    tasks: [
      {
        id: 'task-open',
        status: 'open',
        description: 'Open marketplace task',
        reward: '1.5',
        viewerAgentPda: 'viewer-agent-pda',
        ownedBySigner: true,
      },
    ],
    onTaskRefresh: vi.fn(),
    onTaskCreate: vi.fn(),
    onTaskClaim: vi.fn(),
    onTaskComplete: vi.fn(),
    onTaskDispute: vi.fn(),
    onTaskCancel: vi.fn(),
    skills: [
      {
        skillPda: 'skill-pda-1',
        skillId: 'skill-id-1',
        author: 'author-1',
        name: 'Alpha Skill',
        tags: ['defi'],
        priceLamports: '1000',
        priceSol: '0.000001',
        priceMint: null,
        rating: 4.5,
        ratingCount: 3,
        downloads: 12,
        version: 1,
        isActive: true,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    selectedSkill: null,
    onSkillsRefresh: vi.fn(),
    onSkillInspect: vi.fn(),
    onSkillPurchase: vi.fn(),
    onSkillRate: vi.fn(),
    proposals: [],
    selectedProposal: null,
    onGovernanceRefresh: vi.fn(),
    onProposalInspect: vi.fn(),
    onProposalVote: vi.fn(),
    disputes: [],
    selectedDispute: null,
    onDisputesRefresh: vi.fn(),
    onDisputeInspect: vi.fn(),
    reputation: null,
    onReputationRefresh: vi.fn(),
    onStake: vi.fn(),
    onDelegate: vi.fn(),
  };
}

describe('MarketplaceView', () => {
  it('renders the tasks pane by default', () => {
    render(<MarketplaceView {...createProps()} />);

    expect(screen.getByText('Open marketplace task')).toBeTruthy();
    expect(screen.getByRole('button', { name: '[REFRESH]' })).toBeTruthy();
  });

  it('defaults task scope to yours and can switch to all tasks', () => {
    const props = createProps();
    props.tasks = [
      {
        id: 'task-owned',
        status: 'open',
        description: 'Owned task',
        reward: '1.5',
        viewerAgentPda: 'viewer-agent-pda',
        ownedBySigner: true,
      },
      {
        id: 'task-foreign',
        status: 'open',
        description: 'Other task',
        reward: '3',
        viewerAgentPda: 'viewer-agent-pda',
        ownedBySigner: false,
        assignedToSigner: false,
        claimableBySigner: true,
      },
    ];

    render(<MarketplaceView {...props} />);

    const scopeControls = screen.getByText('scope:').parentElement;
    if (!scopeControls) {
      throw new Error('Task scope controls not found');
    }

    expect(screen.getByText('Owned task')).toBeTruthy();
    expect(screen.queryByText('Other task')).toBeNull();

    fireEvent.click(within(scopeControls).getAllByRole('button', { name: '[all:2]' })[0]);
    expect(screen.getByText('Other task')).toBeTruthy();

    fireEvent.click(within(scopeControls).getByRole('button', { name: '[yours:1]' }));
    expect(screen.queryByText('Other task')).toBeNull();
  });

  it('switches panes across the marketplace workspace', () => {
    const props = createProps();
    render(<MarketplaceView {...props} />);

    const header = screen
      .getAllByText('Public economy surface')[0]
      ?.closest('div')
      ?.parentElement;
    if (!header) {
      throw new Error('Marketplace header not found');
    }
    const tabs = within(header);

    fireEvent.click(tabs.getByRole('button', { name: '[skills]' }));
    expect(screen.getByText('Alpha Skill')).toBeTruthy();

    fireEvent.click(tabs.getByRole('button', { name: '[governance]' }));
    expect(screen.getByText('[no proposals returned]')).toBeTruthy();

    fireEvent.click(tabs.getByRole('button', { name: '[disputes]' }));
    expect(screen.getByText('[no disputes returned]')).toBeTruthy();

    fireEvent.click(tabs.getByRole('button', { name: '[reputation]' }));
    expect(
      screen.getByText('[no signer-backed agent registration found for this runtime wallet]'),
    ).toBeTruthy();
  });
});
