import { compactSessionToken } from "./agenc-watch-format-payloads.mjs";
import { sanitizeInlineText, truncate } from "./agenc-watch-text-utils.mjs";

function sanitizeText(value, fallback = "") {
  const text = sanitizeInlineText(String(value ?? "").replace(/\s+/g, " "));
  return text || fallback;
}

function normalizeAgentStep(step = {}, index = 0) {
  const label = sanitizeText(step.label ?? step.stepName ?? step.id ?? `step ${index + 1}`, `step ${index + 1}`);
  const objective = sanitizeText(step.objective ?? "", "");
  const note = sanitizeText(step.note ?? "", "");
  const status = sanitizeText(step.status ?? "unknown", "unknown");
  const subagentSessionId = sanitizeText(step.subagentSessionId ?? "", "");
  return {
    id: sanitizeText(step.id ?? "", ""),
    label,
    objective,
    note,
    status,
    subagentSessionId,
    sessionToken: compactSessionToken(subagentSessionId) ?? null,
    order: Number.isFinite(Number(step.order)) ? Number(step.order) : index,
    updatedAt: Number.isFinite(Number(step.updatedAt)) ? Number(step.updatedAt) : 0,
  };
}

function agentStepQueryCandidates(step) {
  return [
    step.id,
    step.label,
    step.objective,
    step.note,
    step.status,
    step.subagentSessionId,
    step.sessionToken,
  ]
    .map((value) => sanitizeText(value, "").toLowerCase())
    .filter(Boolean);
}

function matchesAgentQuery(step, query) {
  const normalizedQuery = sanitizeText(query, "").toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return agentStepQueryCandidates(step).some((candidate) => candidate.includes(normalizedQuery));
}

function formatAgentStep(step, index) {
  const header = [
    `${index + 1}.`,
    truncate(step.label, 56),
    `· ${step.status}`,
    step.sessionToken ? `· ${step.sessionToken}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [header];
  if (step.objective && step.objective !== step.label) {
    lines.push(`   objective: ${truncate(step.objective, 108)}`);
  }
  if (step.note && step.note !== step.objective) {
    lines.push(`   note: ${truncate(step.note, 108)}`);
  }
  if (step.subagentSessionId) {
    lines.push(`   session: ${step.subagentSessionId}`);
  }
  if (step.updatedAt > 0) {
    lines.push(`   updated: ${new Date(step.updatedAt).toISOString()}`);
  }
  return lines.join("\n");
}

export function buildWatchAgentsReport({
  planSteps = [],
  plannerStatus = null,
  plannerNote = null,
  activeAgentLabel = null,
  activeAgentActivity = null,
  query = null,
  includeCompleted = false,
  limit = 12,
} = {}) {
  const normalizedSteps = Array.isArray(planSteps)
    ? planSteps.map((step, index) => normalizeAgentStep(step, index))
    : [];
  const scopedSteps = includeCompleted
    ? normalizedSteps
    : normalizedSteps.filter((step) => step.status === "running" || step.status === "planned");
  const matchingSteps = scopedSteps.filter((step) => matchesAgentQuery(step, query));
  const selectedSteps = matchingSteps
    .sort((left, right) => right.updatedAt - left.updatedAt || right.order - left.order)
    .slice(0, Math.max(1, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 12));

  const lines = [
    "Planner",
    `status: ${sanitizeText(plannerStatus, "idle")}`,
  ];
  const normalizedPlannerNote = sanitizeText(plannerNote, "");
  const normalizedActiveAgentLabel = sanitizeText(activeAgentLabel, "");
  const normalizedActiveAgentActivity = sanitizeText(activeAgentActivity, "");
  if (normalizedPlannerNote) {
    lines.push(`note: ${truncate(normalizedPlannerNote, 108)}`);
  }
  if (normalizedActiveAgentLabel) {
    lines.push(`focus: ${truncate(normalizedActiveAgentLabel, 108)}`);
  }
  if (normalizedActiveAgentActivity) {
    lines.push(`activity: ${truncate(normalizedActiveAgentActivity, 108)}`);
  }
  lines.push("");
  lines.push(
    includeCompleted
      ? `Agents (${matchingSteps.length}/${normalizedSteps.length})`
      : `Active agents (${matchingSteps.length}/${scopedSteps.length})`,
  );
  if (selectedSteps.length === 0) {
    lines.push(
      sanitizeText(query, "")
        ? `No agents matched ${sanitizeText(query)}.`
        : includeCompleted
          ? "No planner or subagent steps recorded yet."
          : "No active subagent threads.",
    );
  } else {
    lines.push(...selectedSteps.map((step, index) => formatAgentStep(step, index)));
    if (matchingSteps.length > selectedSteps.length) {
      lines.push(`… ${matchingSteps.length - selectedSteps.length} more agent step(s)`);
    }
  }
  return lines.join("\n");
}
