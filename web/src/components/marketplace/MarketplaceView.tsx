import { useEffect, useState } from 'react';
import type {
  DisputeInfo,
  GovernanceProposalInfo,
  MarketplaceSkillInfo,
  MarketplaceTabId,
  ReputationSummaryInfo,
  TaskInfo,
} from '../../types';
import { TasksPane } from './TasksPane';
import { SkillsPane } from './SkillsPane';
import { GovernancePane } from './GovernancePane';
import { DisputesPane } from './DisputesPane';
import { ReputationPane } from './ReputationPane';

const TABS: Array<{ id: MarketplaceTabId; label: string }> = [
  { id: 'tasks', label: 'tasks' },
  { id: 'skills', label: 'skills' },
  { id: 'governance', label: 'governance' },
  { id: 'disputes', label: 'disputes' },
  { id: 'reputation', label: 'reputation' },
];

export interface MarketplaceViewProps {
  tasks: TaskInfo[];
  agentWallet?: string;
  onTaskRefresh: () => void;
  onTaskCreate: (params: Record<string, unknown>) => void;
  onTaskClaim: (taskId: string) => void;
  onTaskComplete: (taskId: string, resultData?: string) => void;
  onTaskDispute: (taskId: string, evidence: string, resolutionType?: string) => void;
  onTaskCancel: (taskId: string) => void;
  skills: MarketplaceSkillInfo[];
  selectedSkill: MarketplaceSkillInfo | null;
  onSkillsRefresh: () => void;
  onSkillInspect: (skillPda: string) => void;
  onSkillPurchase: (skillPda: string, skillId: string) => void;
  onSkillRate: (skillPda: string, rating: number, review?: string) => void;
  proposals: GovernanceProposalInfo[];
  selectedProposal: GovernanceProposalInfo | null;
  onGovernanceRefresh: () => void;
  onProposalInspect: (proposalPda: string) => void;
  onProposalVote: (proposalPda: string, approve: boolean) => void;
  disputes: DisputeInfo[];
  selectedDispute: DisputeInfo | null;
  onDisputesRefresh: () => void;
  onDisputeInspect: (disputePda: string) => void;
  reputation: ReputationSummaryInfo | null;
  onReputationRefresh: () => void;
  onStake: (amount: string) => void;
  onDelegate: (params: {
    amount: number;
    delegateeAgentPda?: string;
    delegateeAgentId?: string;
    expiresAt?: number;
  }) => void;
}

export function MarketplaceView(props: MarketplaceViewProps) {
  const [tab, setTab] = useState<MarketplaceTabId>('tasks');

  useEffect(() => {
    if (tab === 'skills') props.onSkillsRefresh();
    if (tab === 'governance') props.onGovernanceRefresh();
    if (tab === 'disputes') props.onDisputesRefresh();
    if (tab === 'reputation') props.onReputationRefresh();
  }, [
    tab,
    props.onSkillsRefresh,
    props.onGovernanceRefresh,
    props.onDisputesRefresh,
    props.onReputationRefresh,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bbs-black font-mono text-bbs-lightgray">
      <div className="shrink-0 border-b border-bbs-purple-dim bg-bbs-surface px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.16em] text-bbs-purple">MARKETPLACE&gt;</div>
            <h2 className="mt-2 text-sm font-bold uppercase tracking-[0.18em] text-bbs-white md:text-base">
              Public economy surface
            </h2>
            <p className="mt-1 text-xs text-bbs-gray">
              tasks, skills, governance, disputes, and reputation flows from one operator workspace
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.14em]">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={[
                  'border px-3 py-2 transition-colors',
                  tab === entry.id
                    ? 'border-bbs-purple-dim bg-bbs-dark text-bbs-white'
                    : 'border-bbs-border bg-bbs-black text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
                ].join(' ')}
              >
                [{entry.label}]
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'tasks' && (
          <TasksPane
            tasks={props.tasks}
            agentWallet={props.agentWallet}
            onRefresh={props.onTaskRefresh}
            onCreate={props.onTaskCreate}
            onClaim={props.onTaskClaim}
            onComplete={props.onTaskComplete}
            onDispute={props.onTaskDispute}
            onCancel={props.onTaskCancel}
          />
        )}

        {tab === 'skills' && (
          <SkillsPane
            skills={props.skills}
            selectedSkill={props.selectedSkill}
            onRefresh={props.onSkillsRefresh}
            onInspect={props.onSkillInspect}
            onPurchase={props.onSkillPurchase}
            onRate={props.onSkillRate}
          />
        )}

        {tab === 'governance' && (
          <GovernancePane
            proposals={props.proposals}
            selectedProposal={props.selectedProposal}
            onInspect={props.onProposalInspect}
            onVote={props.onProposalVote}
          />
        )}

        {tab === 'disputes' && (
          <DisputesPane
            disputes={props.disputes}
            selectedDispute={props.selectedDispute}
            onInspect={props.onDisputeInspect}
          />
        )}

        {tab === 'reputation' && (
          <ReputationPane
            reputation={props.reputation}
            onStake={props.onStake}
            onDelegate={props.onDelegate}
          />
        )}
      </div>
    </div>
  );
}
