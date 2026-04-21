import { useCallback, useMemo, useState } from 'react';

interface CreateTaskFormProps {
  onCreate: (params: Record<string, unknown>) => void;
}

type TaskTemplateFieldOption = {
  label: string;
  value: string;
};

type TaskTemplateField = {
  id: string;
  label: string;
  type: 'text' | 'select';
  placeholder?: string;
  options?: TaskTemplateFieldOption[];
};

type TaskTemplate = {
  id: string;
  label: string;
  shortLabel: string;
  summary: string;
  goal: string;
  defaultReward: string;
  sourcePolicy: string;
  outputFormat: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  fields: TaskTemplateField[];
  titleFieldId: string;
};

const TASK_TEMPLATE_VERSION = 1;

const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'web_research_brief',
    label: 'Web Research Brief',
    shortLabel: 'Research brief',
    summary: 'Summarize a topic from bounded public sources.',
    goal: 'Compile a concise public-web research brief with citations and a scoped source list.',
    defaultReward: '0.05',
    sourcePolicy: 'Allowlisted public web only',
    outputFormat: 'markdown brief',
    deliverables: ['Cited markdown brief', 'Source list'],
    acceptanceCriteria: [
      'Include citations for each major claim.',
      'Keep the response scoped to the selected topic, region, and timeframe.',
    ],
    titleFieldId: 'topic',
    fields: [
      { id: 'topic', label: 'Topic', type: 'text', placeholder: 'AI meeting assistants' },
      { id: 'region', label: 'Region', type: 'text', placeholder: 'North America' },
      {
        id: 'timeframe',
        label: 'Timeframe',
        type: 'select',
        options: [
          { label: 'Last 30 days', value: 'last 30 days' },
          { label: 'Last 90 days', value: 'last 90 days' },
          { label: 'Last 12 months', value: 'last 12 months' },
        ],
      },
      {
        id: 'sources',
        label: 'Allowed sources',
        type: 'select',
        options: [
          { label: 'Company sites + public news', value: 'company websites and public news' },
          { label: 'Company sites + review sites', value: 'company websites and approved review sites' },
          { label: 'Public news only', value: 'public news sources only' },
        ],
      },
      {
        id: 'maxSources',
        label: 'Max sources',
        type: 'select',
        options: [
          { label: '5', value: '5' },
          { label: '10', value: '10' },
          { label: '20', value: '20' },
        ],
      },
      {
        id: 'outputLength',
        label: 'Output length',
        type: 'select',
        options: [
          { label: 'Short brief', value: 'short brief' },
          { label: 'Standard brief', value: 'standard brief' },
          { label: 'Brief + comparison table', value: 'brief plus comparison table' },
        ],
      },
    ],
  },
  {
    id: 'lead_list_building',
    label: 'Lead List Building',
    shortLabel: 'Lead list',
    summary: 'Build a public-data lead list with clear sourcing.',
    goal: 'Collect a public lead list from approved sources and return a structured output.',
    defaultReward: '0.08',
    sourcePolicy: 'Public websites and approved directories only',
    outputFormat: 'csv',
    deliverables: ['CSV lead list', 'Source URLs'],
    acceptanceCriteria: [
      'Each row must include a source URL.',
      'Results must stay within the selected geography, company size, and role scope.',
    ],
    titleFieldId: 'industry',
    fields: [
      { id: 'industry', label: 'Industry', type: 'text', placeholder: 'HVAC companies' },
      { id: 'geography', label: 'Geography', type: 'text', placeholder: 'Canada' },
      {
        id: 'companySize',
        label: 'Company size',
        type: 'select',
        options: [
          { label: 'Small business', value: 'small business' },
          { label: 'Mid-market', value: 'mid-market' },
          { label: 'Enterprise', value: 'enterprise' },
          { label: 'Any size', value: 'any size' },
        ],
      },
      { id: 'roleTitles', label: 'Role titles', type: 'text', placeholder: 'service manager, owner' },
      {
        id: 'maxRows',
        label: 'Max rows',
        type: 'select',
        options: [
          { label: '25', value: '25' },
          { label: '50', value: '50' },
          { label: '100', value: '100' },
        ],
      },
      {
        id: 'outputMode',
        label: 'Output',
        type: 'select',
        options: [
          { label: 'Company + source only', value: 'company name, role, and source url' },
          { label: 'Company + contact page', value: 'company, contact page, role, and source url' },
          { label: 'Full public lead row', value: 'company, contact page, role, geography, and source url' },
        ],
      },
    ],
  },
  {
    id: 'product_comparison_report',
    label: 'Product Comparison Report',
    shortLabel: 'Comparison report',
    summary: 'Compare products from approved sources using bounded criteria.',
    goal: 'Produce a structured comparison report for a defined product category and feature set.',
    defaultReward: '0.06',
    sourcePolicy: 'Vendor sites and approved review sources only',
    outputFormat: 'markdown comparison report',
    deliverables: ['Comparison matrix', 'Recommendation summary'],
    acceptanceCriteria: [
      'Compare only products that fit the selected budget and region.',
      'List the required features in the final comparison output.',
    ],
    titleFieldId: 'category',
    fields: [
      { id: 'category', label: 'Category', type: 'text', placeholder: 'Project management tools' },
      { id: 'budget', label: 'Budget', type: 'text', placeholder: 'under $20 per user per month' },
      { id: 'requiredFeatures', label: 'Required features', type: 'text', placeholder: 'API access, SSO, Kanban boards' },
      { id: 'region', label: 'Region', type: 'text', placeholder: 'US and Canada' },
      {
        id: 'maxProducts',
        label: 'Max products',
        type: 'select',
        options: [
          { label: '5', value: '5' },
          { label: '8', value: '8' },
          { label: '10', value: '10' },
        ],
      },
      {
        id: 'rankingStyle',
        label: 'Ranking style',
        type: 'select',
        options: [
          { label: 'Best fit recommendation', value: 'best fit recommendation' },
          { label: 'Weighted scorecard', value: 'weighted scorecard' },
          { label: 'Pros and cons matrix', value: 'pros and cons matrix' },
        ],
      },
    ],
  },
  {
    id: 'spreadsheet_cleanup_classification',
    label: 'Spreadsheet Cleanup / Classification',
    shortLabel: 'Spreadsheet cleanup',
    summary: 'Normalize or classify tabular data without a freeform task prompt.',
    goal: 'Clean or classify a spreadsheet using explicit column and output instructions.',
    defaultReward: '0.04',
    sourcePolicy: 'No network access by default',
    outputFormat: 'csv or xlsx',
    deliverables: ['Cleaned sheet', 'Change summary'],
    acceptanceCriteria: [
      'Return data in the selected output format.',
      'Only modify the specified columns and requested cleanup mode.',
    ],
    titleFieldId: 'columns',
    fields: [
      {
        id: 'fileType',
        label: 'Input file type',
        type: 'select',
        options: [
          { label: 'CSV', value: 'csv' },
          { label: 'XLSX', value: 'xlsx' },
          { label: 'TSV', value: 'tsv' },
        ],
      },
      { id: 'columns', label: 'Target columns', type: 'text', placeholder: 'company, contact_email, status' },
      {
        id: 'cleanupMode',
        label: 'Cleanup mode',
        type: 'select',
        options: [
          { label: 'Normalize values', value: 'normalize values' },
          { label: 'Deduplicate rows', value: 'deduplicate rows' },
          { label: 'Classify rows', value: 'classify rows' },
          { label: 'Normalize + classify', value: 'normalize values and classify rows' },
        ],
      },
      { id: 'ruleSet', label: 'Rules', type: 'text', placeholder: 'normalize company names and classify lead status' },
      {
        id: 'outputMode',
        label: 'Output format',
        type: 'select',
        options: [
          { label: 'CSV', value: 'csv' },
          { label: 'XLSX', value: 'xlsx' },
        ],
      },
    ],
  },
  {
    id: 'transcript_to_deliverables',
    label: 'Transcript To Deliverables',
    shortLabel: 'Transcript deliverables',
    summary: 'Turn a transcript into a bounded output package.',
    goal: 'Convert a transcript or meeting notes into one of the approved output bundles.',
    defaultReward: '0.04',
    sourcePolicy: 'Transcript-only processing unless attachments are supplied separately',
    outputFormat: 'markdown or docx deliverable set',
    deliverables: ['Summary packet', 'Requested follow-up artifacts'],
    acceptanceCriteria: [
      'Keep the result limited to the selected output bundle.',
      'Extract action items and owners when the selected bundle calls for them.',
    ],
    titleFieldId: 'meetingType',
    fields: [
      {
        id: 'meetingType',
        label: 'Meeting type',
        type: 'select',
        options: [
          { label: 'Sales call', value: 'sales call' },
          { label: 'Internal sync', value: 'internal sync' },
          { label: 'Customer interview', value: 'customer interview' },
          { label: 'Board update', value: 'board update' },
        ],
      },
      {
        id: 'requestedOutputs',
        label: 'Requested outputs',
        type: 'select',
        options: [
          { label: 'Summary + action items', value: 'summary and action items' },
          { label: 'Summary + follow-up email', value: 'summary and follow-up email draft' },
          { label: 'CRM notes + follow-up', value: 'crm notes and follow-up email draft' },
          { label: 'Executive recap', value: 'executive recap with decisions and risks' },
        ],
      },
      {
        id: 'audience',
        label: 'Audience',
        type: 'select',
        options: [
          { label: 'Internal team', value: 'internal team' },
          { label: 'Customer-facing', value: 'customer-facing' },
          { label: 'Executive', value: 'executive stakeholders' },
        ],
      },
      {
        id: 'tone',
        label: 'Tone',
        type: 'select',
        options: [
          { label: 'Concise', value: 'concise' },
          { label: 'Neutral', value: 'neutral' },
          { label: 'Executive', value: 'executive' },
        ],
      },
    ],
  },
];

function defaultValuesForTemplate(template: TaskTemplate): Record<string, string> {
  return template.fields.reduce<Record<string, string>>((accumulator, field) => {
    if (field.type === 'select' && field.options?.[0]) {
      accumulator[field.id] = field.options[0].value;
    } else {
      accumulator[field.id] = '';
    }
    return accumulator;
  }, {});
}

function truncateLabel(value: string, maxLength = 44): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatFieldLines(template: TaskTemplate, values: Record<string, string>): string[] {
  return template.fields.map((field) => `- ${field.label}: ${values[field.id] || 'Not provided'}`);
}

export function buildTaskTemplatePayload(templateId: string, values: Record<string, string>, reward: string): Record<string, unknown> {
  const template = TASK_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) {
    throw new Error(`Unknown task template: ${templateId}`);
  }

  const titleSeed = values[template.titleFieldId]?.trim() || template.label;
  const description = `${template.shortLabel}: ${truncateLabel(titleSeed)}`;
  const fieldLines = formatFieldLines(template, values);

  return {
    description,
    reward: reward ? Number(reward) : undefined,
    fullDescription: [
      template.label,
      '',
      template.goal,
      '',
      'Bounded inputs:',
      ...fieldLines,
      '',
      'Expected output:',
      `- ${template.outputFormat}`,
      '',
      'Execution posture:',
      '- Use the approved task template fields only.',
      '- Keep the result inside the declared output bundle.',
    ].join('\n'),
    acceptanceCriteria: template.acceptanceCriteria,
    deliverables: template.deliverables,
    constraints: {
      taskTemplateId: template.id,
      taskTemplateVersion: TASK_TEMPLATE_VERSION,
      sourcePolicy: template.sourcePolicy,
      outputFormat: template.outputFormat,
      inputs: values,
    },
    jobSpec: {
      kind: 'agenc.web.boundedTaskTemplateRequest',
      schemaVersion: 1,
      templateId: template.id,
      templateVersion: TASK_TEMPLATE_VERSION,
      goal: template.goal,
      sourcePolicy: template.sourcePolicy,
      outputFormat: template.outputFormat,
      inputs: values,
    },
  };
}

export function CreateTaskForm({ onCreate }: CreateTaskFormProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState(TASK_TEMPLATES[0]?.id ?? '');
  const [reward, setReward] = useState(TASK_TEMPLATES[0]?.defaultReward ?? '');
  const [values, setValues] = useState<Record<string, string>>(defaultValuesForTemplate(TASK_TEMPLATES[0]!));

  const selectedTemplate = useMemo(
    () => TASK_TEMPLATES.find((template) => template.id === selectedTemplateId) ?? TASK_TEMPLATES[0],
    [selectedTemplateId],
  );

  const isValid = useMemo(
    () => selectedTemplate.fields.every((field) => (values[field.id] ?? '').trim().length > 0),
    [selectedTemplate, values],
  );

  const handleTemplateChange = useCallback((templateId: string) => {
    const nextTemplate = TASK_TEMPLATES.find((template) => template.id === templateId);
    if (!nextTemplate) return;
    setSelectedTemplateId(nextTemplate.id);
    setReward(nextTemplate.defaultReward);
    setValues(defaultValuesForTemplate(nextTemplate));
  }, []);

  const handleSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    if (!isValid) return;
    onCreate(buildTaskTemplatePayload(selectedTemplate.id, values, reward));
    setReward(selectedTemplate.defaultReward);
    setValues(defaultValuesForTemplate(selectedTemplate));
    setExpanded(false);
  }, [isValid, onCreate, reward, selectedTemplate, values]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full border border-dashed border-bbs-border bg-bbs-dark px-4 py-4 text-xs uppercase tracking-[0.16em] text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
      >
        [new task]
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 border border-bbs-purple-dim bg-bbs-surface px-4 py-4 animate-panel-enter"
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
        <span className="text-bbs-purple">TASK&gt;</span>
        <span>approved task recipe</span>
      </div>

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">Task type</div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {TASK_TEMPLATES.map((template) => {
            const active = template.id === selectedTemplate.id;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => handleTemplateChange(template.id)}
                className={[
                  'border px-3 py-3 text-left transition-colors',
                  active
                    ? 'border-bbs-purple-dim bg-bbs-dark text-bbs-white'
                    : 'border-bbs-border bg-bbs-dark/80 text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
                ].join(' ')}
              >
                <div className="text-[11px] uppercase tracking-[0.16em]">{template.label}</div>
                <div className="mt-1 text-[11px] normal-case tracking-normal text-bbs-gray">
                  {template.summary}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border border-bbs-border bg-bbs-dark/70 px-3 py-3 text-xs text-bbs-lightgray">
        <div className="uppercase tracking-[0.16em] text-bbs-purple">Template summary</div>
        <div className="mt-2">{selectedTemplate.goal}</div>
        <div className="mt-2 text-bbs-gray">Source policy: {selectedTemplate.sourcePolicy}</div>
        <div className="text-bbs-gray">Output: {selectedTemplate.outputFormat}</div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {selectedTemplate.fields.map((field) => {
          const inputId = `task-template-${selectedTemplate.id}-${field.id}`;
          return (
            <div key={field.id} className="md:col-span-1">
              <label
                htmlFor={inputId}
                className="mb-2 block text-[10px] uppercase tracking-[0.16em] text-bbs-gray"
              >
                {field.label}
              </label>
              {field.type === 'select' ? (
                <select
                  id={inputId}
                  value={values[field.id] ?? ''}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                  className="w-full border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-white outline-none transition-colors focus:border-bbs-purple-dim"
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={inputId}
                  type="text"
                  value={values[field.id] ?? ''}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                  autoFocus={field.id === selectedTemplate.fields[0]?.id}
                  placeholder={field.placeholder}
                  className="w-full border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
                />
              )}
            </div>
          );
        })}
      </div>

      <div>
        <label htmlFor="task-template-reward" className="mb-2 block text-[10px] uppercase tracking-[0.16em] text-bbs-gray">Reward (SOL)</label>
        <input
          id="task-template-reward"
          type="number"
          min="0"
          step="0.01"
          value={reward}
          onChange={(event) => setReward(event.target.value)}
          placeholder={selectedTemplate.defaultReward}
          className="w-full border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs uppercase tracking-[0.14em]">
        <button
          type="submit"
          disabled={!isValid}
          className={[
            'border px-4 py-2 transition-colors',
            isValid
              ? 'border-bbs-green/40 bg-bbs-dark text-bbs-green hover:text-bbs-white'
              : 'border-bbs-border bg-bbs-dark text-bbs-gray',
          ].join(' ')}
        >
          [create]
        </button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="border border-bbs-border bg-bbs-dark px-4 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
        >
          [cancel]
        </button>
      </div>
    </form>
  );
}
