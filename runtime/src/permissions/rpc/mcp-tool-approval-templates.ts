/**
 * Ports the donor runtime MCP tool approval template renderer onto AgenC.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC does not yet own the donor app-connector catalogue or namespace.
 *     The renderer and schema are live here, while callers inject AgenC-owned
 *     templates when they have a connector surface to approve.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Filesystem loading of the bundled donor catalogue. The default bundle is
 *     intentionally empty until AgenC has a matching connector namespace.
 */

import { asRecord, isRecord } from "../../utils/record.js";

export const MCP_TOOL_APPROVAL_TEMPLATES_SCHEMA_VERSION = 4;
const MCP_CONNECTOR_NAME_TEMPLATE_VAR = "{connector_name}";

export type McpToolApprovalJsonPrimitive = string | number | boolean | null;
export type McpToolApprovalJsonValue =
  | McpToolApprovalJsonPrimitive
  | readonly McpToolApprovalJsonValue[]
  | { readonly [key: string]: McpToolApprovalJsonValue | undefined };

export interface McpToolApprovalJsonObject {
  readonly [key: string]: McpToolApprovalJsonValue | undefined;
}

export interface RenderedMcpToolApprovalParam {
  readonly name: string;
  readonly value: McpToolApprovalJsonValue;
  readonly displayName: string;
}

export interface RenderedMcpToolApprovalTemplate {
  readonly question: string;
  readonly elicitationMessage: string;
  readonly toolParams: McpToolApprovalJsonObject | null;
  readonly toolParamsDisplay: readonly RenderedMcpToolApprovalParam[];
}

export interface McpToolApprovalTemplateParam {
  readonly name: string;
  readonly label: string;
}

export interface McpToolApprovalTemplate {
  readonly connectorId: string;
  readonly serverName: string;
  readonly toolTitle: string;
  readonly template: string;
  readonly templateParams: readonly McpToolApprovalTemplateParam[];
}

export interface McpToolApprovalTemplateFile {
  readonly schemaVersion: number;
  readonly templates: readonly McpToolApprovalTemplate[];
}

export const EMPTY_MCP_TOOL_APPROVAL_TEMPLATE_FILE: McpToolApprovalTemplateFile =
  Object.freeze({
    schemaVersion: MCP_TOOL_APPROVAL_TEMPLATES_SCHEMA_VERSION,
    templates: Object.freeze([]) as readonly McpToolApprovalTemplate[],
  });

function readAliasedField(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return Object.hasOwn(record, camel) ? record[camel] : record[snake];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeTemplateParam(
  value: unknown,
): McpToolApprovalTemplateParam | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = stringValue(record.name);
  const label = stringValue(record.label);
  if (name === null || label === null) return null;
  return { name, label };
}

function normalizeTemplate(value: unknown): McpToolApprovalTemplate | null {
  const record = asRecord(value);
  if (record === null) return null;
  const connectorId = stringValue(readAliasedField(record, "connectorId", "connector_id"));
  const serverName = stringValue(readAliasedField(record, "serverName", "server_name"));
  const toolTitle = stringValue(readAliasedField(record, "toolTitle", "tool_title"));
  const template = stringValue(record.template);
  const rawParams = readAliasedField(record, "templateParams", "template_params");
  if (
    connectorId === null ||
    serverName === null ||
    toolTitle === null ||
    template === null ||
    !Array.isArray(rawParams)
  ) {
    return null;
  }
  const templateParams: McpToolApprovalTemplateParam[] = [];
  for (const param of rawParams) {
    const normalized = normalizeTemplateParam(param);
    if (normalized === null) return null;
    templateParams.push(normalized);
  }
  return {
    connectorId,
    serverName,
    toolTitle,
    template,
    templateParams,
  };
}

export function loadMcpToolApprovalTemplatesFromJson(
  raw: unknown,
): McpToolApprovalTemplateFile | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const record = asRecord(value);
  if (record === null) return null;
  const schemaVersion = readAliasedField(record, "schemaVersion", "schema_version");
  if (schemaVersion !== MCP_TOOL_APPROVAL_TEMPLATES_SCHEMA_VERSION) {
    return null;
  }
  if (!Array.isArray(record.templates)) return null;
  const templates: McpToolApprovalTemplate[] = [];
  for (const template of record.templates) {
    const normalized = normalizeTemplate(template);
    if (normalized === null) return null;
    templates.push(normalized);
  }
  return {
    schemaVersion,
    templates,
  };
}

function renderQuestionTemplate(
  template: string,
  connectorName: string | null | undefined,
): string | null {
  const trimmed = template.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.includes(MCP_CONNECTOR_NAME_TEMPLATE_VAR)) {
    return trimmed;
  }
  const name = connectorName?.trim();
  if (!name) return null;
  return trimmed.replaceAll(MCP_CONNECTOR_NAME_TEMPLATE_VAR, name);
}

function isJsonObject(value: unknown): value is McpToolApprovalJsonObject {
  return isRecord(value);
}

function renderToolParams(
  toolParams: McpToolApprovalJsonObject,
  templateParams: readonly McpToolApprovalTemplateParam[],
): {
  readonly toolParams: McpToolApprovalJsonObject;
  readonly display: readonly RenderedMcpToolApprovalParam[];
} | null {
  const display: RenderedMcpToolApprovalParam[] = [];
  const displayNames = new Set<string>();
  const handledNames = new Set<string>();

  for (const templateParam of templateParams) {
    const label = templateParam.label.trim();
    if (label.length === 0) return null;
    if (!Object.hasOwn(toolParams, templateParam.name)) continue;
    const value = toolParams[templateParam.name];
    if (value === undefined) continue;
    if (displayNames.has(label)) return null;
    displayNames.add(label);
    handledNames.add(templateParam.name);
    display.push({
      name: templateParam.name,
      value,
      displayName: label,
    });
  }

  const remaining = Object.keys(toolParams)
    .filter((name) => !handledNames.has(name))
    .sort();
  for (const name of remaining) {
    const value = toolParams[name];
    if (value === undefined) continue;
    if (displayNames.has(name)) return null;
    displayNames.add(name);
    display.push({
      name,
      value,
      displayName: name,
    });
  }

  return {
    toolParams: { ...toolParams },
    display,
  };
}

export function renderMcpToolApprovalTemplateFromTemplates(
  templates: readonly McpToolApprovalTemplate[],
  serverName: string,
  connectorId: string | null | undefined,
  connectorName: string | null | undefined,
  toolTitle: string | null | undefined,
  toolParams?: McpToolApprovalJsonValue | null,
): RenderedMcpToolApprovalTemplate | null {
  if (connectorId === null || connectorId === undefined) return null;
  const title = toolTitle?.trim();
  if (!title) return null;
  const template = templates.find((candidate) =>
    candidate.serverName === serverName &&
    candidate.connectorId === connectorId &&
    candidate.toolTitle === title,
  );
  if (template === undefined) return null;
  const elicitationMessage = renderQuestionTemplate(
    template.template,
    connectorName,
  );
  if (elicitationMessage === null) return null;

  if (toolParams === undefined || toolParams === null) {
    return {
      question: elicitationMessage,
      elicitationMessage,
      toolParams: null,
      toolParamsDisplay: [],
    };
  }
  if (!isJsonObject(toolParams)) return null;
  const renderedParams = renderToolParams(toolParams, template.templateParams);
  if (renderedParams === null) return null;
  return {
    question: elicitationMessage,
    elicitationMessage,
    toolParams: renderedParams.toolParams,
    toolParamsDisplay: renderedParams.display,
  };
}

export function renderMcpToolApprovalTemplate(
  serverName: string,
  connectorId: string | null | undefined,
  connectorName: string | null | undefined,
  toolTitle: string | null | undefined,
  toolParams?: McpToolApprovalJsonValue | null,
  templateFile: McpToolApprovalTemplateFile = EMPTY_MCP_TOOL_APPROVAL_TEMPLATE_FILE,
): RenderedMcpToolApprovalTemplate | null {
  return renderMcpToolApprovalTemplateFromTemplates(
    templateFile.templates,
    serverName,
    connectorId,
    connectorName,
    toolTitle,
    toolParams,
  );
}
