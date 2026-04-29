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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function DetailList({
  items,
}: {
  items: Array<{ label: string; value?: ReactNode }>;
}) {
  const visible = items.filter((item) => item.value !== undefined && item.value !== null);
  if (visible.length === 0) return null;
  return (
    <div className="space-y-1">
      {visible.map((item) => (
        <InlineStat key={item.label} label={item.label} value={item.value as ReactNode} />
      ))}
    </div>
  );
}

type RuntimeCommandSurface = 'context' | 'status' | 'profile' | 'model' | 'effort' | 'voice' | 'memory';

interface RuntimeCommandMetric {
  label: string;
  value: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}

interface RuntimeCommandSection {
  title: string;
  body?: string;
  items?: readonly string[];
}

interface RuntimeCommandData {
  kind: 'runtime';
  surface: RuntimeCommandSurface;
  status?: string;
  metrics?: readonly RuntimeCommandMetric[];
  sections?: readonly RuntimeCommandSection[];
  detail?: Record<string, unknown>;
}

function isRuntimeCommandData(value: unknown): value is RuntimeCommandData {
  return isRecord(value) && value.kind === 'runtime';
}

function CardList({
  title,
  entries,
}: {
  title: string;
  entries: Array<{
    key: string;
    title: ReactNode;
    body?: ReactNode;
    stats?: Array<{ label: string; value?: ReactNode }>;
  }>;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-bbs-gray">{title}</div>
      {entries.map((entry) => (
        <div key={entry.key} className="border border-bbs-border bg-bbs-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-bbs-white">{entry.title}</div>
          </div>
          {entry.stats && entry.stats.length > 0 && (
            <div className="mt-2 space-y-1">
              {entry.stats.map((stat) => (
                <InlineStat key={`${entry.key}:${stat.label}`} label={stat.label} value={stat.value ?? '—'} />
              ))}
            </div>
          )}
          {entry.body && <div className="mt-2 break-words text-bbs-lightgray">{entry.body}</div>}
        </div>
      ))}
    </div>
  );
}

function renderRecordSummary(record: Record<string, unknown>, fields: string[]) {
  return fields
    .map((field) => {
      const raw = record[field];
      if (raw === undefined || raw === null) return null;
      if (typeof raw === 'string') return `${field}: ${raw}`;
      if (typeof raw === 'number' || typeof raw === 'boolean') return `${field}: ${String(raw)}`;
      if (Array.isArray(raw)) {
        const items = getStringArray(raw);
        return items ? `${field}: ${items.join(', ')}` : `${field}: ${raw.length} item${raw.length === 1 ? '' : 's'}`;
      }
      return `${field}: ${JSON.stringify(raw)}`;
    })
    .filter((entry): entry is string => entry !== null);
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
      {result.content && <TextBlock content={result.content} />}
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
  const branchInfo = isRecord(data.branchInfo) ? data.branchInfo : undefined;
  const changeSummary = isRecord(data.changeSummary) ? data.changeSummary : undefined;
  const diff = isRecord(data.diff) ? data.diff : undefined;
  const summaryLines = changeSummary
    ? renderRecordSummary(changeSummary, [
        'summary',
        'status',
        'branch',
        'head',
        'upstream',
        'ahead',
        'behind',
        'staged',
        'unstaged',
        'untracked',
        'conflicted',
        'renamed',
        'deleted',
      ])
    : [];
  return (
    <Section title="Git">
      <InlineStat label="Command" value={data.subcommand} />
      <DetailList
        items={[
          { label: 'Branch', value: getString(branchInfo?.branch) },
          { label: 'Head', value: getString(branchInfo?.head) },
          { label: 'Upstream', value: getString(branchInfo?.upstream) },
          { label: 'Ahead', value: getNumber(branchInfo?.ahead) },
          { label: 'Behind', value: getNumber(branchInfo?.behind) },
          { label: 'Dirty', value: getBoolean(branchInfo?.dirty) ? 'yes' : undefined },
          { label: 'Summary', value: getString(changeSummary?.summary) },
        ]}
      />
      {summaryLines.length > 0 && (
        <div className="space-y-1 rounded border border-bbs-border bg-bbs-black/50 p-3 font-mono text-[11px] text-bbs-lightgray">
          {summaryLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      {Array.isArray(changeSummary?.files) && changeSummary.files.length > 0 && (
        <CardList
          title="Changed Files"
          entries={changeSummary.files
            .filter(isRecord)
            .slice(0, 8)
            .map((file, index) => ({
              key: `${String(file.path ?? file.file ?? index)}`,
              title: getString(file.path) ?? getString(file.file) ?? `file-${index}`,
              stats: [
                { label: 'Status', value: getString(file.status) },
                { label: 'Additions', value: getNumber(file.additions) },
                { label: 'Deletions', value: getNumber(file.deletions) },
                { label: 'Mode', value: getString(file.mode) },
              ],
            }))}
        />
      )}
      {diff && (
        <DetailList
          items={[
            { label: 'Diff Type', value: getString(diff.type) },
            { label: 'Files', value: Array.isArray(diff.files) ? diff.files.length : undefined },
            { label: 'Summary', value: getString(diff.summary) },
          ]}
        />
      )}
      {result.content && <TextBlock content={result.content} />}
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
  const branchInfo = isRecord(data.branchInfo) ? data.branchInfo : undefined;
  const changeSummary = isRecord(data.changeSummary) ? data.changeSummary : undefined;
  const diff = isRecord(data.diff) ? data.diff : undefined;
  const changeSummaryFiles = Array.isArray(changeSummary?.files) ? changeSummary.files.filter(isRecord) : [];
  const fileEntries = Array.isArray(diff?.files)
    ? diff.files.filter(isRecord).slice(0, 8).map((file, index) => ({
        key: `${String(file.path ?? file.file ?? index)}`,
        title: getString(file.path) ?? getString(file.file) ?? `file-${index}`,
        stats: [
          { label: 'Status', value: getString(file.status) },
          { label: 'Additions', value: getNumber(file.additions) },
          { label: 'Deletions', value: getNumber(file.deletions) },
        ],
      }))
    : [];
  return (
    <Section title="Diff">
      <InlineStat label="Command" value={data.subcommand} />
      <DetailList
        items={[
          { label: 'Branch', value: getString(branchInfo?.branch) },
          { label: 'Head', value: getString(branchInfo?.head) },
          { label: 'Upstream', value: getString(branchInfo?.upstream) },
          { label: 'Summary', value: getString(changeSummary?.summary) },
          { label: 'Staged', value: getNumber(changeSummary?.staged) },
          { label: 'Unstaged', value: getNumber(changeSummary?.unstaged) },
          { label: 'Untracked', value: getNumber(changeSummary?.untracked) },
          { label: 'Conflicted', value: getNumber(changeSummary?.conflicted) },
        ]}
      />
      {fileEntries.length > 0 && <CardList title="Diff Files" entries={fileEntries} />}
      {changeSummaryFiles.length > 0 && !fileEntries.length && (
        <CardList
          title="Changed Files"
          entries={changeSummaryFiles.slice(0, 8).map((file, index) => ({
            key: `${String(file.path ?? file.file ?? index)}`,
            title: getString(file.path) ?? getString(file.file) ?? `file-${index}`,
            stats: [
              { label: 'Status', value: getString(file.status) },
              { label: 'Additions', value: getNumber(file.additions) },
              { label: 'Deletions', value: getNumber(file.deletions) },
            ],
          }))}
        />
      )}
      {diff && !fileEntries.length && !changeSummaryFiles.length && <JsonBlock value={data.diff} />}
      {result.content && !diff && <TextBlock content={result.content} />}
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
  const structured = isRecord(data.result) ? data.result : undefined;
  const fileEntries = Array.isArray(structured?.files)
    ? structured.files.filter(isRecord).slice(0, 10).map((file, index) => ({
        key: `${String(file.path ?? file.name ?? index)}`,
        title: getString(file.path) ?? getString(file.name) ?? `file-${index}`,
        stats: [
          { label: 'Type', value: getString(file.type) },
          { label: 'Size', value: getNumber(file.size) },
          { label: 'Language', value: getString(file.language) },
        ],
        body: getString(file.preview),
      }))
    : [];
  return (
    <Section title="Files">
      <InlineStat label="Mode" value={data.mode} />
      {data.query && <InlineStat label="Query" value={data.query} />}
      {fileEntries.length > 0 && <CardList title="Results" entries={fileEntries} />}
      {structured && !fileEntries.length && (
        <DetailList
          items={[
            { label: 'Count', value: getNumber(structured.count) },
            { label: 'Root', value: getString(structured.root) },
            { label: 'Query', value: getString(structured.query) },
          ]}
        />
      )}
      {structured && !fileEntries.length && <JsonBlock value={data.result} />}
      {result.content && !structured && <TextBlock content={result.content} />}
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
  const structured = isRecord(data.result) ? data.result : undefined;
  const matches = Array.isArray(structured?.matches)
    ? structured.matches.filter(isRecord).slice(0, 10).map((match, index) => ({
        key: `${String(match.path ?? match.file ?? index)}`,
        title: getString(match.path) ?? getString(match.file) ?? `match-${index}`,
        stats: [
          { label: 'Line', value: getNumber(match.line) },
          { label: 'Column', value: getNumber(match.column) },
          { label: 'Score', value: getNumber(match.score) },
        ],
        body: getString(match.snippet) ?? getString(match.content),
      }))
    : [];
  return (
    <Section title="Grep">
      <InlineStat label="Pattern" value={data.pattern} />
      {matches.length > 0 && <CardList title="Matches" entries={matches} />}
      {structured && !matches.length && (
        <DetailList
          items={[
            { label: 'Files', value: getNumber(structured.files) },
            { label: 'Matches', value: getNumber(structured.matchCount) },
            { label: 'Root', value: getString(structured.root) },
          ]}
        />
      )}
      {structured && !matches.length && <JsonBlock value={data.result} />}
      {result.content && !structured && <TextBlock content={result.content} />}
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
  const structured = isRecord(data.result) ? data.result : undefined;
  const tasks = Array.isArray(structured?.tasks)
    ? structured.tasks.filter(isRecord).slice(0, 10).map((task, index) => ({
        key: `${String(task.id ?? task.taskId ?? index)}`,
        title: getString(task.id) ?? getString(task.taskId) ?? `task-${index}`,
        stats: [
          { label: 'Status', value: getString(task.status) },
          { label: 'Worker', value: getString(task.worker) },
          { label: 'Reward', value: getString(task.reward) },
        ],
        body: getString(task.description),
      }))
    : [];
  return (
    <Section title="Tasks">
      <InlineStat label="Command" value={data.subcommand} />
      {data.taskId && <InlineStat label="Task" value={data.taskId} />}
      {tasks.length > 0 && <CardList title="Tasks" entries={tasks} />}
      {structured && !tasks.length && (
        <DetailList
          items={[
            { label: 'Count', value: getNumber(structured.count) },
            { label: 'Status', value: getString(structured.status) },
            { label: 'Worker', value: getString(structured.worker) },
          ]}
        />
      )}
      {structured && !tasks.length && <JsonBlock value={data.result} />}
      {result.content && !structured && <TextBlock content={result.content} />}
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
  const preview = isRecord(data.preview) ? data.preview : undefined;
  const leases = Array.isArray(data.leases) ? data.leases.filter(isRecord) : [];
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
      {preview && (
        <DetailList
          items={[
            { label: 'Action', value: getString(preview.action) },
            { label: 'State', value: getString(preview.state) },
            { label: 'Tool', value: getString(preview.toolName) },
            { label: 'Request', value: getString(preview.requestId) },
          ]}
        />
      )}
      {leases.length > 0 && (
        <CardList
          title="Leases"
          entries={leases.slice(0, 8).map((lease, index) => ({
            key: `${String(lease.requestId ?? lease.id ?? index)}`,
            title: getString(lease.toolName) ?? getString(lease.requestId) ?? `lease-${index}`,
            stats: [
              { label: 'State', value: getString(lease.state) },
              { label: 'Deadline', value: getString(lease.deadlineAt) },
              { label: 'Approvers', value: getStringArray(lease.approverRoles)?.join(', ') },
            ],
            body: getString(lease.preview) ?? getString(lease.message),
          }))}
        />
      )}
      {result.content && !preview && !leases.length && <TextBlock content={result.content} />}
      {preview && !leases.length && <JsonBlock value={data.preview} />}
      {leases.length > 0 && leases.every((lease) => !getString(lease.preview) && !getString(lease.message)) && (
        <JsonBlock value={data.leases} />
      )}
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
  const status = isRecord(data.status) ? data.status : undefined;
  const detail = isRecord(data.detail) ? data.detail : undefined;
  const entries = Array.isArray(data.entries) ? data.entries.filter(isRecord) : [];
  const entryCards = entries.slice(0, 8).map((entry, index) => ({
    key: `${String(entry.id ?? entry.name ?? index)}`,
    title:
      getString(entry.displayName) ??
      getString(entry.name) ??
      getString(entry.id) ??
      `entry-${index}`,
    stats: [
      { label: 'Enabled', value: getBoolean(entry.enabled) === false ? 'no' : getBoolean(entry.enabled) === true ? 'yes' : undefined },
      { label: 'Source', value: getString(entry.source) },
      { label: 'Trust', value: getString(entry.trustTier) ?? getString(entry.trustLabel) },
      { label: 'Server', value: getString(entry.server) },
    ],
    body: getString(entry.description),
  }));
  return (
    <Section title={data.surface.toUpperCase()}>
      <InlineStat label="Command" value={data.subcommand} />
      {data.target && <InlineStat label="Target" value={data.target} />}
      {status && (
        <DetailList
          items={[
            { label: 'Connected', value: getBoolean(status.connected) ? 'yes' : getBoolean(status.connected) === false ? 'no' : undefined },
            { label: 'Enabled', value: getBoolean(status.enabled) ? 'yes' : getBoolean(status.enabled) === false ? 'no' : undefined },
            { label: 'Trust', value: getString(status.trustTier) ?? getString(status.trustLabel) },
            { label: 'Tools', value: getNumber(status.toolCount) },
          ]}
        />
      )}
      {detail && (
        <DetailList
          items={[
            { label: 'State', value: getString(detail.state) },
            { label: 'Source', value: getString(detail.source) },
            { label: 'Path', value: getString(detail.path) },
            { label: 'Missing', value: getStringArray(detail.missingRequirements)?.join(', ') },
          ]}
        />
      )}
      {entryCards.length > 0 && <CardList title={data.surface} entries={entryCards} />}
      {result.content && !status && !detail && !entryCards.length && <TextBlock content={result.content} />}
      {status && !entryCards.length && !detail && <JsonBlock value={data.status} />}
      {detail && !entryCards.length && <JsonBlock value={data.detail} />}
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
  const branchInfo = isRecord(data.branchInfo) ? data.branchInfo : undefined;
  const changeSummary = isRecord(data.changeSummary) ? data.changeSummary : undefined;
  const diff = isRecord(data.diff) ? data.diff : undefined;
  const reviewFileCount = Array.isArray(changeSummary?.files) ? changeSummary.files.length : undefined;
  const diffFileCount = Array.isArray(diff?.files) ? diff.files.length : undefined;
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
      {data.reviewSurface?.summaryPreview && (
        <TextBlock content={data.reviewSurface.summaryPreview} />
      )}
      <DetailList
        items={[
          { label: 'Branch', value: getString(branchInfo?.branch) },
          { label: 'Head', value: getString(branchInfo?.head) },
          { label: 'Summary', value: getString(changeSummary?.summary) },
          { label: 'Files', value: reviewFileCount },
        ]}
      />
      {diff && (
        <DetailList
          items={[
            { label: 'Diff Type', value: getString(diff.type) },
            { label: 'Files', value: diffFileCount },
            { label: 'Status', value: getString(diff.status) },
          ]}
        />
      )}
      {data.delegatedResult?.output && <TextBlock content={data.delegatedResult.output} />}
      {result.content && <TextBlock content={result.content} />}
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
  const branchInfo = isRecord(data.branchInfo) ? data.branchInfo : undefined;
  const changeSummary = isRecord(data.changeSummary) ? data.changeSummary : undefined;
  const runtimeStatusSnapshot = isRecord(data.runtimeStatusSnapshot)
    ? data.runtimeStatusSnapshot
    : undefined;
  const taskCount = Array.isArray(changeSummary?.tasks) ? changeSummary.tasks.length : undefined;
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
      {data.verificationSurface?.summaryPreview && (
        <TextBlock content={data.verificationSurface.summaryPreview} />
      )}
      <DetailList
        items={[
          { label: 'Branch', value: getString(branchInfo?.branch) },
          { label: 'Head', value: getString(branchInfo?.head) },
          { label: 'Tasks', value: taskCount },
          { label: 'Runtime', value: getString(runtimeStatusSnapshot?.status) },
        ]}
      />
      {runtimeStatusSnapshot && (
        <DetailList
          items={[
            { label: 'Load', value: getString(runtimeStatusSnapshot.load) },
            { label: 'Budget', value: getString(runtimeStatusSnapshot.budget) },
            { label: 'Phase', value: getString(runtimeStatusSnapshot.phase) },
          ]}
        />
      )}
      {result.content && <TextBlock content={result.content} />}
    </Section>
  );
}

function RuntimeResultView({
  result,
  data,
}: {
  result: SessionCommandResult;
  data: RuntimeCommandData;
}) {
  return (
    <Section title={`Runtime / ${data.surface}`}>
      <InlineStat label="Surface" value={data.surface} />
      {data.status && <InlineStat label="Status" value={data.status} />}
      {data.metrics && data.metrics.length > 0 && (
        <div className="space-y-1">
          {data.metrics.map((metric: RuntimeCommandMetric) => (
            <InlineStat key={`${metric.label}:${metric.value}`} label={metric.label} value={metric.value} />
          ))}
        </div>
      )}
      {data.sections && data.sections.length > 0 && (
        <div className="space-y-2">
          {data.sections.map((section: RuntimeCommandSection) => (
            <div key={section.title} className="border border-bbs-border bg-bbs-surface p-3">
              <div className="mb-2 text-[10px] uppercase tracking-wide text-bbs-gray">{section.title}</div>
              {section.body && <div className="mb-2 text-bbs-lightgray">{section.body}</div>}
              {section.items && section.items.length > 0 && (
                <div className="space-y-1">
                  {section.items.map((item: string, index: number) => (
                    <div key={`${section.title}-${index}`} className="text-bbs-lightgray">
                      {item}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {data.detail && <JsonBlock value={data.detail} />}
      {result.content && !data.metrics?.length && !data.sections?.length && !data.detail && (
        <TextBlock content={result.content} />
      )}
    </Section>
  );
}

export function CommandResultPanel({ result }: CommandResultPanelProps) {
  const data = result.data;
  const panelKind = result.viewKind ?? data?.kind ?? null;
  const runtimeData = isRuntimeCommandData(data) ? data : null;

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
        {runtimeData && (
          <RuntimeResultView result={result} data={runtimeData} />
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
