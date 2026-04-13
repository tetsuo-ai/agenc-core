import type { ReactNode } from 'react';
import type { CockpitSnapshot, ContinuityDetail } from '../../types';

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-bbs-border bg-bbs-dark">
      <div className="border-b border-bbs-border px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-bbs-purple">
        {title}
      </div>
      <div className="space-y-2 px-3 py-3 text-xs text-bbs-lightgray">{children}</div>
    </section>
  );
}

function StatRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-bbs-border/50 py-1 last:border-b-0">
      <span className="text-bbs-gray">{label}</span>
      <span className="text-right text-bbs-white">{value}</span>
    </div>
  );
}

function TextBlock({ content }: { content?: string }) {
  if (!content) return null;
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-bbs-border bg-bbs-black/70 p-3 font-mono text-[11px] text-bbs-lightgray">
      {content}
    </pre>
  );
}

export function SessionInspectPanel({
  detail,
  onResume,
  onFork,
  onLoadHistory,
}: {
  detail: ContinuityDetail;
  onResume?: (sessionId: string) => void;
  onFork?: (sessionId: string) => void;
  onLoadHistory?: (sessionId: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto space-y-3 border-l border-bbs-border bg-bbs-black p-3">
      <PanelSection title="Session Inspect">
        <StatRow label="Session" value={detail.sessionId} />
        <StatRow label="Profile" value={detail.shellProfile} />
        <StatRow label="Stage" value={detail.workflowStage} />
        <StatRow label="State" value={detail.resumabilityState} />
        <StatRow label="Messages" value={detail.messageCount} />
        <StatRow label="Children" value={detail.childSessionCount} />
        <StatRow label="Worktrees" value={detail.worktreeCount} />
        <StatRow label="Approvals" value={detail.pendingApprovalCount} />
        {detail.branch && <StatRow label="Branch" value={detail.branch} />}
        {detail.head && <StatRow label="Head" value={detail.head} />}
        {detail.workspaceRoot && <StatRow label="Workspace" value={detail.workspaceRoot} />}
        {detail.repoRoot && <StatRow label="Repo" value={detail.repoRoot} />}
        {detail.activeTaskSummary && (
          <StatRow label="Active Task" value={detail.activeTaskSummary} />
        )}
        {detail.lastAssistantOutputPreview && (
          <TextBlock content={detail.lastAssistantOutputPreview} />
        )}
        <TextBlock content={detail.preview} />
        {detail.forkLineage && (
          <TextBlock
            content={[
              `Parent: ${detail.forkLineage.parentSessionId}`,
              `Source: ${detail.forkLineage.source}`,
              `Forked: ${new Date(detail.forkLineage.forkedAt).toLocaleString()}`,
            ].join('\n')}
          />
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {onResume && (
            <button
              onClick={() => onResume(detail.sessionId)}
              className="text-xs text-bbs-purple hover:text-bbs-white"
            >
              [RESUME]
            </button>
          )}
          {onLoadHistory && (
            <button
              onClick={() => onLoadHistory(detail.sessionId)}
              className="text-xs text-bbs-cyan hover:text-bbs-white"
            >
              [HISTORY]
            </button>
          )}
          {onFork && (
            <button
              onClick={() => onFork(detail.sessionId)}
              className="text-xs text-bbs-green hover:text-bbs-white"
            >
              [FORK]
            </button>
          )}
        </div>
      </PanelSection>

      {detail.runtimeState && (
        <PanelSection title="Runtime State">
          {detail.runtimeState.reviewStatus && (
            <StatRow label="Review" value={detail.runtimeState.reviewStatus} />
          )}
          {detail.runtimeState.verificationStatus && (
            <StatRow label="Verify" value={detail.runtimeState.verificationStatus} />
          )}
          {detail.runtimeState.verificationVerdict && (
            <StatRow label="Verdict" value={detail.runtimeState.verificationVerdict} />
          )}
          {Boolean(detail.runtimeState.activeTaskContext) && (
            <TextBlock content={JSON.stringify(detail.runtimeState.activeTaskContext, null, 2)} />
          )}
        </PanelSection>
      )}

      {detail.backgroundRun && (
        <PanelSection title="Background Run">
          <StatRow label="Run" value={detail.backgroundRun.runId} />
          <StatRow label="State" value={detail.backgroundRun.state} />
          {detail.backgroundRun.currentPhase && (
            <StatRow label="Phase" value={detail.backgroundRun.currentPhase} />
          )}
          {detail.backgroundRun.objective && (
            <TextBlock content={detail.backgroundRun.objective} />
          )}
        </PanelSection>
      )}

      {detail.recentHistory && detail.recentHistory.length > 0 && (
        <PanelSection title="Recent History">
          <div className="space-y-2">
            {detail.recentHistory.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className="border border-bbs-border bg-bbs-surface p-3">
                <div className="mb-1 text-[11px] uppercase tracking-wide text-bbs-purple">
                  {entry.sender}
                  {entry.toolName ? ` - ${entry.toolName}` : ''}
                </div>
                <div className="whitespace-pre-wrap break-words text-bbs-lightgray">
                  {entry.content}
                </div>
              </div>
            ))}
          </div>
        </PanelSection>
      )}
    </div>
  );
}

export function CockpitPanel({ cockpit }: { cockpit: CockpitSnapshot }) {
  return (
    <div className="h-full overflow-y-auto space-y-3 border-l border-bbs-border bg-bbs-black p-3">
      <PanelSection title="Cockpit Session">
        <StatRow label="Session" value={cockpit.session.sessionId} />
        <StatRow label="Profile" value={cockpit.session.shellProfile} />
        <StatRow label="Stage" value={cockpit.session.workflowStage} />
        <StatRow label="State" value={cockpit.session.resumabilityState} />
        <StatRow label="Messages" value={cockpit.session.messageCount} />
        {cockpit.session.objective && <TextBlock content={cockpit.session.objective} />}
      </PanelSection>

      <PanelSection title="Repo">
        <StatRow label="Available" value={cockpit.repo.available ? 'yes' : 'no'} />
        {cockpit.repo.branch && <StatRow label="Branch" value={cockpit.repo.branch} />}
        {cockpit.repo.head && <StatRow label="Head" value={cockpit.repo.head} />}
        {cockpit.repo.workspaceRoot && (
          <StatRow label="Workspace" value={cockpit.repo.workspaceRoot} />
        )}
        {cockpit.repo.repoRoot && <StatRow label="Repo" value={cockpit.repo.repoRoot} />}
        {cockpit.repo.cached !== undefined && (
          <StatRow label="Cached" value={cockpit.repo.cached ? 'yes' : 'no'} />
        )}
        {cockpit.repo.dirtyCounts && (
          <TextBlock
            content={[
              `staged: ${cockpit.repo.dirtyCounts.staged}`,
              `unstaged: ${cockpit.repo.dirtyCounts.unstaged}`,
              `untracked: ${cockpit.repo.dirtyCounts.untracked}`,
              `conflicted: ${cockpit.repo.dirtyCounts.conflicted}`,
            ].join('\n')}
          />
        )}
        {cockpit.repo.changedFiles && cockpit.repo.changedFiles.length > 0 && (
          <TextBlock content={cockpit.repo.changedFiles.join('\n')} />
        )}
        {cockpit.repo.unavailableReason && (
          <TextBlock content={cockpit.repo.unavailableReason} />
        )}
      </PanelSection>

      <PanelSection title="Review / Verify">
        <StatRow label="Review" value={`${cockpit.review.status} (${cockpit.review.source})`} />
        <StatRow
          label="Verify"
          value={`${cockpit.verification.status} (${cockpit.verification.source})`}
        />
        {cockpit.verification.verdict && (
          <StatRow label="Verdict" value={cockpit.verification.verdict} />
        )}
        {cockpit.review.summaryPreview && <TextBlock content={cockpit.review.summaryPreview} />}
        {!cockpit.review.summaryPreview && cockpit.verification.summaryPreview && (
          <TextBlock content={cockpit.verification.summaryPreview} />
        )}
      </PanelSection>

      {cockpit.approvals.count > 0 && (
        <PanelSection title="Approvals">
          <div className="space-y-2">
            {cockpit.approvals.entries.map((entry) => (
              <div key={entry.requestId} className="border border-bbs-border bg-bbs-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-bbs-white">{entry.toolName}</span>
                  <span className="text-bbs-cyan">{entry.state}</span>
                </div>
                <div className="mt-1 text-bbs-gray">{entry.requestId}</div>
                {entry.deadlineAt && (
                  <div className="mt-1 text-bbs-gray">
                    deadline: {new Date(entry.deadlineAt).toLocaleString()}
                  </div>
                )}
                {entry.approverRoles && entry.approverRoles.length > 0 && (
                  <div className="mt-1 text-bbs-gray">
                    roles: {entry.approverRoles.join(', ')}
                  </div>
                )}
                {entry.preview && <div className="mt-1 text-bbs-lightgray">{entry.preview}</div>}
              </div>
            ))}
          </div>
        </PanelSection>
      )}

      {cockpit.worktrees.entries.length > 0 && (
        <PanelSection title="Worktrees">
          <div className="space-y-2">
            {cockpit.worktrees.entries.map((entry) => (
              <div key={entry.path} className="border border-bbs-border bg-bbs-surface p-3">
                <div className="text-bbs-white">{entry.path}</div>
                <div className="mt-1 text-bbs-gray">
                  {entry.branch ?? 'detached'} {entry.clean === false ? '- dirty' : '- clean'}
                </div>
                {(entry.ownerRole || entry.ownerSessionId || entry.ownerWorkerId) && (
                  <div className="mt-1 text-bbs-gray">
                    {entry.ownerRole ?? 'runtime'}
                    {entry.ownerSessionId ? ` - ${entry.ownerSessionId}` : ''}
                    {entry.ownerWorkerId ? ` - worker ${entry.ownerWorkerId}` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </PanelSection>
      )}

      {cockpit.ownership.length > 0 && (
        <PanelSection title="Ownership">
          <div className="space-y-2">
            {cockpit.ownership.map((entry, index) => (
              <div key={`${entry.childSessionId ?? entry.taskId ?? index}`} className="border border-bbs-border bg-bbs-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-bbs-white">{entry.role}</span>
                  <span className="text-bbs-cyan">{entry.state}</span>
                </div>
                <div className="mt-1 text-bbs-gray">
                  {entry.shellProfile ?? 'n/a'}
                  {entry.roleSource ? ` - ${entry.roleSource}` : ''}
                  {entry.toolBundle ? ` - ${entry.toolBundle}` : ''}
                </div>
                <div className="mt-1 text-bbs-gray">
                  {entry.worktreePath ? `worktree ${entry.worktreePath}` : 'no worktree'}
                  {entry.taskId ? ` - task ${entry.taskId}` : ''}
                  {entry.childSessionId ? ` - ${entry.childSessionId}` : ''}
                </div>
              </div>
            ))}
          </div>
        </PanelSection>
      )}
    </div>
  );
}
