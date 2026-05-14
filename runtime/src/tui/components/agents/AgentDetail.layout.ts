const AGENT_DETAIL_HORIZONTAL_CHROME = 4;

function normalizeColumns(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.trunc(columns)) : 0;
}

export function getAgentDetailValueColumns(columns: number): number {
  return Math.max(1, normalizeColumns(columns) - AGENT_DETAIL_HORIZONTAL_CHROME);
}

export function getAgentDetailIndentedValueColumns(columns: number, indentColumns: number): number {
  return Math.max(1, getAgentDetailValueColumns(columns) - Math.max(0, Math.trunc(indentColumns)));
}
