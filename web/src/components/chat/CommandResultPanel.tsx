import type { ReactNode } from 'react';
import type {
  SessionCommandViewDiffData,
  SessionCommandViewExtensionsData,
  SessionCommandViewFilesData,
  SessionCommandResult,
  SessionCommandViewAgentsData,
  SessionCommandViewGrepData,
  SessionCommandViewGitData,
  SessionCommandViewPolicyData,
  SessionCommandViewReviewData,
  SessionCommandViewSessionData,
  SessionCommandViewTasksData,
  SessionCommandViewVerifyData,
  SessionCommandViewWorkflowData,
} from '../../types';

interface CommandResultPanelProps {
  result: SessionCommandResult;
}

function Section({
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

function InlineStat({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-bbs-border/50 py-1 last:border-b-0">
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

function JsonBlock({ value }: { value: unknown }) {
  if (value === undefined) return null;
  return <TextBlock content={JSON.stringify(value, null, 2)} />;
}

function SessionResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewSessionData;
}) {
  if (data.currentSession) {
    return (
      <Section title="Session Status">
        <InlineStat label="Session" value={data.currentSession.sessionId} />
        <InlineStat label="Runtime" value={data.currentSession.runtimeSessionId} />
        <InlineStat label="Profile" value={data.currentSession.shellProfile} />
        <InlineStat label="Stage" value={data.currentSession.workflowState.stage} />
        <InlineStat label="Worktree" value={data.currentSession.workflowState.worktreeMode} />
        <InlineStat label="Workspace" value={data.currentSession.workspaceRoot} />
        <InlineStat label="Messages" value={data.currentSession.historyMessages} />
        {data.currentSession.model && (
          <InlineStat label="Model" value={data.currentSession.model} />
        )}
        {data.currentSession.workflowState.objective && (
          <InlineStat
            label="Objective"
            value={data.currentSession.workflowState.objective}
          />
        )}
        {data.currentSession.ownership && data.currentSession.ownership.length > 0 && (
          <JsonBlock value={data.currentSession.ownership} />
        )}
      </Section>
    );
  }

  if (data.sessions) {
    return (
      <Section title="Session Catalog">
        <div className="space-y-2">
          {data.sessions.map((session: NonNullable<SessionCommandViewSessionData['sessions']>[number]) => (
            <div key={session.sessionId} className="border border-bbs-border bg-bbs-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-bbs-white">{session.label}</span>
                <span className="text-bbs-cyan">{session.shellProfile}</span>
              </div>
              <div className="mt-1 text-bbs-gray">
                {session.workflowStage} - {session.resumabilityState}
              </div>
              <div className="mt-1 truncate text-bbs-lightgray">{session.preview}</div>
            </div>
          ))}
        </div>
      </Section>
    );
  }

  if (data.detail) {
    return (
      <Section title="Session Inspect">
        <InlineStat label="Session" value={data.detail.sessionId} />
        <InlineStat label="Profile" value={data.detail.shellProfile} />
        <InlineStat label="Stage" value={data.detail.workflowStage} />
        <InlineStat label="State" value={data.detail.resumabilityState} />
        <InlineStat label="Messages" value={data.detail.messageCount} />
        <InlineStat label="Children" value={data.detail.childSessionCount} />
        <InlineStat label="Worktrees" value={data.detail.worktreeCount} />
        {data.detail.branch && <InlineStat label="Branch" value={data.detail.branch} />}
        {data.detail.workspaceRoot && (
          <InlineStat label="Workspace" value={data.detail.workspaceRoot} />
        )}
        {data.detail.repoRoot && (
          <InlineStat label="Repo" value={data.detail.repoRoot} />
        )}
        {data.detail.lastAssistantOutputPreview && (
          <TextBlock content={data.detail.lastAssistantOutputPreview} />
        )}
        {data.detail.preview && <TextBlock content={data.detail.preview} />}
      </Section>
    );
  }

  if (data.history) {
    return (
      <Section title="Session History">
        <div className="space-y-2">
          {data.history.map((entry: NonNullable<SessionCommandViewSessionData['history']>[number], index: number) => (
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
      </Section>
    );
  }

  if (data.resumed) {
    return (
      <Section title="Session Resume">
        <InlineStat label="Session" value={data.resumed.sessionId} />
        <InlineStat label="Messages" value={data.resumed.messageCount} />
        {data.resumed.workspaceRoot && (
          <InlineStat label="Workspace" value={data.resumed.workspaceRoot} />
        )}
      </Section>
    );
  }

  if (data.forked) {
    return (
      <Section title="Session Fork">
        <InlineStat label="Source" value={data.forked.sourceSessionId} />
        <InlineStat label="Target" value={data.forked.targetSessionId} />
        {data.forked.forkSource && (
          <InlineStat label="Fork Source" value={data.forked.forkSource} />
        )}
      </Section>
    );
  }

  return <TextBlock content={result.content} />;
}

function WorkflowResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewWorkflowData;
}) {
  return (
    <Section title="Workflow">
      <InlineStat label="Command" value={data.subcommand} />
      <InlineStat label="Profile" value={data.shellProfile} />
      <InlineStat label="Stage" value={data.workflowState.stage} />
      <InlineStat label="Worktree" value={data.workflowState.worktreeMode} />
      <InlineStat label="Planner" value={data.plannerStatus} />
      {data.suggestedNextStage && (
        <InlineStat label="Suggested" value={data.suggestedNextStage} />
      )}
      {data.workflowState.objective && (
        <InlineStat label="Objective" value={data.workflowState.objective} />
      )}
      {data.delegated && (
        <InlineStat
          label="Delegated"
          value={`${data.delegated.sessionId} [${data.delegated.status}]`}
        />
      )}
      <TextBlock content={result.content} />
    </Section>
  );
}

function AgentsResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewAgentsData;
}) {
  return (
    <Section title="Agents">
      <InlineStat label="Command" value={data.subcommand} />
      {Array.isArray(data.roles) && data.roles.length > 0 && (
        <div className="space-y-2">
          {data.roles.map((role: NonNullable<SessionCommandViewAgentsData['roles']>[number], index: number) => (
            <div key={`${role.id ?? index}`} className="border border-bbs-border bg-bbs-surface p-3">
              <div className="text-bbs-white">{String(role.displayName ?? role.id ?? 'unknown')}</div>
              <div className="text-bbs-gray">{String(role.description ?? '')}</div>
            </div>
          ))}
        </div>
      )}
      {Array.isArray(data.entries) && data.entries.length > 0 && (
        <div className="space-y-2">
          {data.entries.map((entry: NonNullable<SessionCommandViewAgentsData['entries']>[number], index: number) => (
            <div key={`${entry.sessionId ?? entry.taskId ?? index}`} className="border border-bbs-border bg-bbs-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-bbs-white">{String(entry.role ?? entry.sessionId ?? 'agent')}</span>
                <span className="text-bbs-cyan">{String(entry.status ?? 'unknown')}</span>
              </div>
              {typeof entry.taskId === 'string' && (
                <div className="text-bbs-gray">Task: {String(entry.taskId)}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {!data.roles?.length && !data.entries?.length && <TextBlock content={result.content} />}
    </Section>
  );
}

function GitResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewGitData;
}) {
  return (
    <Section title="Git">
      <InlineStat label="Command" value={data.subcommand} />
      {typeof data.branchInfo?.branch === 'string' && (
        <InlineStat label="Branch" value={String(data.branchInfo.branch)} />
      )}
      {data.changeSummary?.summary !== undefined && (
        <TextBlock content={JSON.stringify(data.changeSummary.summary, null, 2)} />
      )}
      <TextBlock content={result.content} />
    </Section>
  );
}

function DiffResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewDiffData;
}) {
  return (
    <Section title="Diff">
      <InlineStat label="Command" value={data.subcommand} />
      <TextBlock content={result.content} />
      {data.diff && <JsonBlock value={data.diff} />}
    </Section>
  );
}

function FilesResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewFilesData;
}) {
  return (
    <Section title="Files">
      <InlineStat label="Mode" value={data.mode} />
      {data.query && <InlineStat label="Query" value={data.query} />}
      <TextBlock content={result.content} />
      {data.result && <JsonBlock value={data.result} />}
    </Section>
  );
}

function GrepResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewGrepData;
}) {
  return (
    <Section title="Grep">
      <InlineStat label="Pattern" value={data.pattern} />
      <TextBlock content={result.content} />
      {data.result && <JsonBlock value={data.result} />}
    </Section>
  );
}

function TasksResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewTasksData;
}) {
  return (
    <Section title="Tasks">
      <InlineStat label="Command" value={data.subcommand} />
      {data.taskId && <InlineStat label="Task" value={data.taskId} />}
      <TextBlock content={result.content} />
      {data.result && <JsonBlock value={data.result} />}
    </Section>
  );
}

function PolicyResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewPolicyData;
}) {
  return (
    <Section title="Policy">
      <InlineStat label="Command" value={data.subcommand} />
      {data.sessionPolicyState && (
        <>
          <InlineStat
            label="Allow"
            value={data.sessionPolicyState.elevatedPatterns.join(', ') || 'none'}
          />
          <InlineStat
            label="Deny"
            value={data.sessionPolicyState.deniedPatterns.join(', ') || 'none'}
          />
        </>
      )}
      <TextBlock content={result.content} />
      {data.preview && <JsonBlock value={data.preview} />}
      {data.leases && data.leases.length > 0 && <JsonBlock value={data.leases} />}
    </Section>
  );
}

function ExtensionsResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewExtensionsData;
}) {
  return (
    <Section title={data.surface.toUpperCase()}>
      <InlineStat label="Command" value={data.subcommand} />
      {data.target && <InlineStat label="Target" value={data.target} />}
      <TextBlock content={result.content} />
      {data.status && <JsonBlock value={data.status} />}
      {data.detail && <JsonBlock value={data.detail} />}
      {data.entries && data.entries.length > 0 && <JsonBlock value={data.entries} />}
    </Section>
  );
}

function ReviewResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewReviewData;
}) {
  return (
    <Section title="Review">
      <InlineStat label="Mode" value={data.mode} />
      <InlineStat label="Delegated" value={data.delegated ? 'yes' : 'no'} />
      {data.reviewSurface && (
        <InlineStat
          label="State"
          value={`${data.reviewSurface.status} (${data.reviewSurface.source})`}
        />
      )}
      {data.delegatedResult && (
        <InlineStat
          label="Reviewer"
          value={`${data.delegatedResult.sessionId} [${data.delegatedResult.status}]`}
        />
      )}
      <TextBlock content={result.content} />
    </Section>
  );
}

function VerifyResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: SessionCommandViewVerifyData;
}) {
  return (
    <Section title="Verify">
      <InlineStat label="Delegated" value={data.delegated ? 'yes' : 'no'} />
      {data.verificationSurface && (
        <InlineStat
          label="State"
          value={`${data.verificationSurface.status} (${data.verificationSurface.source})`}
        />
      )}
      {data.verificationSurface?.verdict && (
        <InlineStat label="Verdict" value={data.verificationSurface.verdict} />
      )}
      {data.delegatedResult && (
        <InlineStat
          label="Verifier"
          value={`${data.delegatedResult.sessionId} [${data.delegatedResult.status}]`}
        />
      )}
      <TextBlock content={result.content} />
    </Section>
  );
}

export function CommandResultPanel({ result }: CommandResultPanelProps) {
  const data = result.data;
  const panelKind = result.viewKind ?? data?.kind ?? null;

  return (
    <aside className="h-full overflow-y-auto border-l border-bbs-border bg-bbs-surface">
      <div className="border-b border-bbs-border px-4 py-3">
        <div className="text-[11px] uppercase tracking-wide text-bbs-purple">
          Command Result
        </div>
        <div className="mt-1 text-sm font-semibold text-bbs-white">
          /{result.commandName}
        </div>
      </div>

      <div className="space-y-3 p-4">
        {data?.kind === 'session' && (
          <SessionResultView result={result} data={data} />
        )}
        {data?.kind === 'workflow' && (
          <WorkflowResultView result={result} data={data} />
        )}
        {data?.kind === 'agents' && (
          <AgentsResultView result={result} data={data} />
        )}
        {panelKind === 'git' && data?.kind === 'git' && (
          <GitResultView result={result} data={data} />
        )}
        {panelKind === 'diff' && data?.kind === 'diff' && (
          <DiffResultView result={result} data={data} />
        )}
        {panelKind === 'files' && data?.kind === 'files' && (
          <FilesResultView result={result} data={data} />
        )}
        {panelKind === 'grep' && data?.kind === 'grep' && (
          <GrepResultView result={result} data={data} />
        )}
        {panelKind === 'tasks' && data?.kind === 'tasks' && (
          <TasksResultView result={result} data={data} />
        )}
        {panelKind === 'policy' && data?.kind === 'policy' && (
          <PolicyResultView result={result} data={data} />
        )}
        {panelKind === 'extensions' && data?.kind === 'extensions' && (
          <ExtensionsResultView result={result} data={data} />
        )}
        {data?.kind === 'review' && (
          <ReviewResultView result={result} data={data} />
        )}
        {data?.kind === 'verify' && (
          <VerifyResultView result={result} data={data} />
        )}
        {!data && <TextBlock content={result.content} />}
      </div>
    </aside>
  );
}
