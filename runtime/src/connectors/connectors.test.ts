import { describe, expect, test } from "vitest";

import { collectAccessibleConnectors } from "./accessible.js";
import {
  accessibleConnectorsFromTools,
  appIsEnabled,
  appToolPolicyFromAppsConfig,
  applyRequirementsAppsConstraints,
  withAppEnabledState,
  withAppPluginSources,
} from "./connectors.js";
import {
  filterDisallowedConnectors,
  filterToolSuggestDiscoverableConnectors,
  isConnectorIdAllowed,
} from "./filter.js";
import {
  connectorInstallUrl,
  connectorMentionSlug,
  sanitizeName,
} from "./metadata.js";
import {
  mergeConnectors,
  mergePluginConnectors,
  mergePluginConnectorsWithAccessible,
  pluginConnectorToAppInfo,
} from "./merge.js";
import type { AppInfo } from "./types.js";

describe("connector metadata", () => {
  test("builds stable slugs, safe names, and install identifiers without network domains", () => {
    const connector = app("calendar", "Google Calendar");

    expect(connectorMentionSlug(connector)).toBe("google-calendar");
    expect(sanitizeName("Google Calendar!")).toBe("google_calendar");
    expect(connectorInstallUrl("Google Calendar", "connector/calendar")).toBe(
      "urn:agenc:connector:google-calendar:connector%2Fcalendar",
    );
    expect(connectorInstallUrl("", "calendar")).toBe("urn:agenc:connector:app:calendar");
  });
});

describe("accessible connector aggregation", () => {
  test("dedupes tools by connector and upgrades placeholder names", () => {
    expect(
      collectAccessibleConnectors([
        {
          connectorId: "calendar",
          connectorName: " ",
          pluginDisplayNames: ["sample", "sample"],
        },
        {
          connectorId: "calendar",
          connectorName: "Google Calendar",
          connectorDescription: " Plan events ",
          pluginDisplayNames: ["beta", "sample"],
        },
        {
          connectorId: "drive",
          connectorName: "Drive",
        },
      ]),
    ).toEqual([
      {
        id: "drive",
        name: "Drive",
        installUrl: "urn:agenc:connector:drive:drive",
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: [],
      },
      {
        id: "calendar",
        name: "Google Calendar",
        description: "Plan events",
        installUrl: "urn:agenc:connector:google-calendar:calendar",
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ["beta", "sample"],
      },
    ]);
  });

  test("uses ordinal ordering for connector names and plugin display names", () => {
    expect(
      collectAccessibleConnectors([
        {
          connectorId: "lower",
          connectorName: "alpha",
          pluginDisplayNames: ["beta", "Alpha"],
        },
        {
          connectorId: "upper",
          connectorName: "Beta",
          pluginDisplayNames: ["sample", "Beta"],
        },
      ]),
    ).toEqual([
      {
        id: "upper",
        name: "Beta",
        installUrl: "urn:agenc:connector:beta:upper",
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ["Beta", "sample"],
      },
      {
        id: "lower",
        name: "alpha",
        installUrl: "urn:agenc:connector:alpha:lower",
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ["Alpha", "beta"],
      },
    ]);
  });

  test("collects accessible connectors only from the app MCP server", () => {
    expect(
      accessibleConnectorsFromTools([
        {
          serverName: "agenc_apps",
          connectorId: "calendar",
          connectorName: "Calendar",
          pluginDisplayNames: ["calendar-plugin"],
        },
        {
          serverName: "other",
          connectorId: "drive",
          connectorName: "Drive",
          pluginDisplayNames: ["ignored"],
        },
      ]),
    ).toEqual([
      {
        id: "calendar",
        name: "Calendar",
        installUrl: "urn:agenc:connector:calendar:calendar",
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ["calendar-plugin"],
      },
    ]);
  });
});

describe("connector merging", () => {
  test("replaces plugin placeholder names and dedupes plugin display names", () => {
    const plugin = {
      ...pluginConnectorToAppInfo("calendar"),
      pluginDisplayNames: ["sample", "alpha", "sample"],
    };
    const accessible = {
      ...app("calendar", "Google Calendar"),
      description: "Plan events",
      logoUrl: "urn:agenc:connector-logo",
      logoUrlDark: "urn:agenc:connector-logo-dark",
      distributionChannel: "workspace",
      isAccessible: true,
      pluginDisplayNames: ["beta", "alpha"],
    };

    expect(mergeConnectors([plugin], [accessible])).toEqual([
      {
        id: "calendar",
        name: "Google Calendar",
        description: "Plan events",
        logoUrl: "urn:agenc:connector-logo",
        logoUrlDark: "urn:agenc:connector-logo-dark",
        distributionChannel: "workspace",
        installUrl: "urn:agenc:connector:calendar:calendar",
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ["alpha", "beta", "sample"],
      },
    ]);
  });

  test("adds plugin connector placeholders and keeps only accessible plugin connectors when requested", () => {
    expect(
      mergePluginConnectors([app("calendar", "Calendar")], ["drive", "calendar"])
        .map((connector) => [connector.id, connector.isAccessible]),
    ).toEqual([
      ["calendar", false],
      ["drive", false],
    ]);

    expect(
      mergePluginConnectorsWithAccessible(
        ["drive", "calendar"],
        [{ ...app("calendar", "Calendar"), isAccessible: true }],
      ).map((connector) => [connector.id, connector.isAccessible]),
    ).toEqual([["calendar", true]]);
  });
});

describe("connector filtering", () => {
  test("filters disallowed connector IDs and discoverable duplicates", () => {
    expect(isConnectorIdAllowed("connector_openai_hidden")).toBe(false);
    expect(isConnectorIdAllowed("connector_0f9c9d4592e54d0a9a12b3f44a1e2010", true)).toBe(false);

    expect(
      filterDisallowedConnectors([
        app("connector_openai_hidden", "Hidden"),
        app("calendar", "Calendar"),
      ], "agenc_cli"),
    ).toEqual([app("calendar", "Calendar")]);

    expect(
      filterToolSuggestDiscoverableConnectors(
        [
          app("drive", "Drive"),
          app("calendar", "Calendar"),
          app("mail", "Mail"),
          app("upper", "Beta"),
          app("lower", "alpha"),
        ],
        [{ ...app("calendar", "Calendar"), isAccessible: true }],
        new Set(["drive", "calendar", "upper", "lower"]),
        "agenc_cli",
      ).map((connector) => connector.id),
    ).toEqual(["upper", "drive", "lower"]);
  });

  test("uses the first-party originator denylist end to end", () => {
    const firstPartyOnly = app("connector_0f9c9d4592e54d0a9a12b3f44a1e2010", "First Party");
    const standardOnly = app("connector_2b0a9009c9c64bf9933a3dae3f2b1254", "Standard");
    const hiddenPrefix = app("connector_openai_hidden", "Hidden");

    expect(
      filterDisallowedConnectors(
        [firstPartyOnly, standardOnly, hiddenPrefix],
        "agenc_cli",
      ).map((connector) => connector.id),
    ).toEqual([firstPartyOnly.id]);
    expect(
      filterDisallowedConnectors(
        [firstPartyOnly, standardOnly, hiddenPrefix],
        "agenc_atlas",
      ).map((connector) => connector.id),
    ).toEqual([standardOnly.id]);
  });
});

describe("connector app policy", () => {
  test("applies user and requirements enabled state overlays", () => {
    expect(appIsEnabled({ default: { enabled: false } }, "calendar")).toBe(false);
    expect(
      withAppEnabledState(
        [app("calendar", "Calendar"), app("drive", "Drive")],
        {
          default: { enabled: false },
          apps: { calendar: { enabled: true } },
        },
        { apps: { calendar: { enabled: false } } },
      ).map((connector) => [connector.id, connector.isEnabled]),
    ).toEqual([
      ["calendar", false],
      ["drive", false],
    ]);
  });

  test("merges requirement constraints into app config", () => {
    expect(
      applyRequirementsAppsConstraints(
        {
          apps: {
            calendar: { enabled: true },
          },
        },
        {
          apps: {
            calendar: { enabled: false },
            drive: { enabled: true },
          },
        },
      ),
    ).toEqual({
      apps: {
        calendar: { enabled: false },
      },
    });
  });

  test("uses app tool defaults, per-tool overrides, and capability hints", () => {
    const appsConfig = {
      default: {
        enabled: true,
        destructiveEnabled: false,
        openWorldEnabled: true,
      },
      apps: {
        calendar: {
          enabled: true,
          defaultToolsEnabled: true,
          defaultToolsApprovalMode: "prompt" as const,
          tools: {
            tools: {
              "events.create": { enabled: false, approvalMode: "approve" as const },
              "Events Create": { enabled: true },
            },
          },
        },
      },
    };

    expect(
      appToolPolicyFromAppsConfig(
        appsConfig,
        "calendar",
        "events.create",
        null,
        { destructiveHint: false },
      ),
    ).toEqual({ enabled: false, approval: "approve" });
    expect(
      appToolPolicyFromAppsConfig(
        appsConfig,
        "calendar",
        "missing",
        "Events Create",
        { destructiveHint: false },
      ),
    ).toEqual({ enabled: true, approval: "prompt" });
    expect(
      appToolPolicyFromAppsConfig(
        { default: { enabled: true, destructiveEnabled: false } },
        "calendar",
        "events.delete",
        null,
        { destructiveHint: true },
      ),
    ).toEqual({ enabled: false, approval: "auto" });
  });

  test("matches default tool and missing-hint policy edges", () => {
    expect(
      appToolPolicyFromAppsConfig(
        {
          default: { enabled: true, destructiveEnabled: false, openWorldEnabled: true },
        },
        "calendar",
        "events.create",
        null,
        { openWorldHint: false },
      ),
    ).toEqual({ enabled: false, approval: "auto" });
    expect(
      appToolPolicyFromAppsConfig(
        {
          default: { enabled: true, destructiveEnabled: true, openWorldEnabled: false },
        },
        "calendar",
        "events.search",
        null,
        { destructiveHint: false },
      ),
    ).toEqual({ enabled: false, approval: "auto" });
    expect(
      appToolPolicyFromAppsConfig(
        {
          default: { enabled: true, destructiveEnabled: true, openWorldEnabled: true },
          apps: {
            calendar: {
              defaultToolsEnabled: false,
              tools: {
                tools: {
                  "events.safe": { enabled: true },
                },
              },
            },
          },
        },
        "calendar",
        "events.safe",
        null,
        { destructiveHint: true, openWorldHint: true },
      ),
    ).toEqual({ enabled: true, approval: "auto" });
    expect(
      appToolPolicyFromAppsConfig(
        {
          default: { enabled: true, destructiveEnabled: true, openWorldEnabled: true },
          apps: {
            calendar: {
              defaultToolsEnabled: false,
            },
          },
        },
        "calendar",
        "events.other",
        null,
        { destructiveHint: false, openWorldHint: false },
      ),
    ).toEqual({ enabled: false, approval: "auto" });
  });

  test("overlays plugin display names from provenance by connector ID", () => {
    expect(
      withAppPluginSources(
        [app("calendar", "Calendar"), app("drive", "Drive")],
        { calendar: ["team-calendar"] },
      ).map((connector) => [connector.id, connector.pluginDisplayNames]),
    ).toEqual([
      ["calendar", ["team-calendar"]],
      ["drive", []],
    ]);
  });
});

function app(id: string, name: string): AppInfo {
  return {
    id,
    name,
    isAccessible: false,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}
