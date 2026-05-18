import { describe, expect, it } from "vitest";
import {
  EMPTY_MCP_TOOL_APPROVAL_TEMPLATE_FILE,
  MCP_TOOL_APPROVAL_TEMPLATES_SCHEMA_VERSION,
  loadMcpToolApprovalTemplatesFromJson,
  renderMcpToolApprovalTemplate,
  renderMcpToolApprovalTemplateFromTemplates,
  type McpToolApprovalTemplate,
} from "./mcp-tool-approval-templates.js";

const calendarTemplate: McpToolApprovalTemplate = {
  connectorId: "calendar",
  serverName: "agenc_apps",
  toolTitle: "create_event",
  template: "Allow {connector_name} to create an event?",
  templateParams: [
    { name: "calendar_id", label: "Calendar" },
    { name: "title", label: "Title" },
  ],
};

describe("MCP tool approval templates", () => {
  it("renders an exact match with readable param labels and sorted leftovers", () => {
    const rendered = renderMcpToolApprovalTemplateFromTemplates(
      [calendarTemplate],
      "agenc_apps",
      "calendar",
      "Calendar",
      " create_event ",
      {
        title: "Roadmap review",
        calendar_id: "primary",
        timezone: "UTC",
        attendees: 3,
      },
    );

    expect(rendered).toEqual({
      question: "Allow Calendar to create an event?",
      elicitationMessage: "Allow Calendar to create an event?",
      toolParams: {
        title: "Roadmap review",
        calendar_id: "primary",
        timezone: "UTC",
        attendees: 3,
      },
      toolParamsDisplay: [
        {
          name: "calendar_id",
          value: "primary",
          displayName: "Calendar",
        },
        {
          name: "title",
          value: "Roadmap review",
          displayName: "Title",
        },
        {
          name: "attendees",
          value: 3,
          displayName: "attendees",
        },
        {
          name: "timezone",
          value: "UTC",
          displayName: "timezone",
        },
      ],
    });
  });

  it("returns null when no exact match exists", () => {
    expect(
      renderMcpToolApprovalTemplateFromTemplates(
        [calendarTemplate],
        "agenc_apps",
        "calendar",
        "Calendar",
        "delete_event",
        {},
      ),
    ).toBeNull();
  });

  it("rejects duplicate display labels", () => {
    expect(
      renderMcpToolApprovalTemplateFromTemplates(
        [
          {
            ...calendarTemplate,
            templateParams: [
              { name: "calendar_id", label: "timezone" },
            ],
          },
        ],
        "agenc_apps",
        "calendar",
        "Calendar",
        "create_event",
        {
          calendar_id: "primary",
          timezone: "UTC",
        },
      ),
    ).toBeNull();
  });

  it("renders literal templates without connector substitution", () => {
    const rendered = renderMcpToolApprovalTemplateFromTemplates(
      [
        {
          connectorId: "issues",
          serverName: "agenc_apps",
          toolTitle: "add_comment",
          template: "Allow Issues to add a comment?",
          templateParams: [],
        },
      ],
      "agenc_apps",
      "issues",
      null,
      "add_comment",
      {},
    );

    expect(rendered).toEqual({
      question: "Allow Issues to add a comment?",
      elicitationMessage: "Allow Issues to add a comment?",
      toolParams: {},
      toolParamsDisplay: [],
    });
  });

  it("requires connector names for placeholder templates", () => {
    expect(
      renderMcpToolApprovalTemplateFromTemplates(
        [calendarTemplate],
        "agenc_apps",
        "calendar",
        " ",
        "create_event",
        {},
      ),
    ).toBeNull();
  });

  it("returns null for empty literal templates", () => {
    expect(
      renderMcpToolApprovalTemplateFromTemplates(
        [
          {
            connectorId: "calendar",
            serverName: "agenc_apps",
            toolTitle: "create_event",
            template: "   ",
            templateParams: [],
          },
        ],
        "agenc_apps",
        "calendar",
        "Calendar",
        "create_event",
        {},
      ),
    ).toBeNull();
  });

  it("rejects non-object tool params", () => {
    expect(
      renderMcpToolApprovalTemplateFromTemplates(
        [calendarTemplate],
        "agenc_apps",
        "calendar",
        "Calendar",
        "create_event",
        ["not", "object"],
      ),
    ).toBeNull();
  });

  it("loads schema-versioned template files and rejects mismatches", () => {
    const loaded = loadMcpToolApprovalTemplatesFromJson({
      schema_version: MCP_TOOL_APPROVAL_TEMPLATES_SCHEMA_VERSION,
      templates: [
        {
          connector_id: "calendar",
          server_name: "agenc_apps",
          tool_title: "create_event",
          template: "Allow {connector_name}?",
          template_params: [
            { name: "title", label: "Title" },
          ],
        },
      ],
    });

    expect(loaded).toEqual({
      schemaVersion: MCP_TOOL_APPROVAL_TEMPLATES_SCHEMA_VERSION,
      templates: [
        {
          connectorId: "calendar",
          serverName: "agenc_apps",
          toolTitle: "create_event",
          template: "Allow {connector_name}?",
          templateParams: [
            { name: "title", label: "Title" },
          ],
        },
      ],
    });
    expect(
      loadMcpToolApprovalTemplatesFromJson({
        schema_version: MCP_TOOL_APPROVAL_TEMPLATES_SCHEMA_VERSION + 1,
        templates: [],
      }),
    ).toBeNull();
  });

  it("renders null from the safe empty default bundle", () => {
    expect(
      renderMcpToolApprovalTemplate(
        "agenc_apps",
        "calendar",
        "Calendar",
        "create_event",
        {},
      ),
    ).toBeNull();
    expect(EMPTY_MCP_TOOL_APPROVAL_TEMPLATE_FILE.templates).toHaveLength(0);
  });

  it("renders through an injected template file", () => {
    const rendered = renderMcpToolApprovalTemplate(
      "agenc_apps",
      "calendar",
      "Calendar",
      "create_event",
      null,
      {
        schemaVersion: MCP_TOOL_APPROVAL_TEMPLATES_SCHEMA_VERSION,
        templates: [calendarTemplate],
      },
    );

    expect(rendered).toEqual({
      question: "Allow Calendar to create an event?",
      elicitationMessage: "Allow Calendar to create an event?",
      toolParams: null,
      toolParamsDisplay: [],
    });
  });
});
