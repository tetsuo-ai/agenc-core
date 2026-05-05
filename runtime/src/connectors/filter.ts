import type { AppInfo } from "./types.js";
import { ordinalCompare } from "./metadata.js";

export const DISALLOWED_CONNECTOR_IDS = Object.freeze([
  "asdk_app_6938a94a61d881918ef32cb999ff937c",
  "connector_2b0a9009c9c64bf9933a3dae3f2b1254",
  "connector_3f8d1a79f27c4c7ba1a897ab13bf37dc",
  "connector_68de829bf7648191acd70a907364c67c",
  "connector_68e004f14af881919eb50893d3d9f523",
  "connector_69272cb413a081919685ec3c88d1744e",
] as const);

export const FIRST_PARTY_CHAT_DISALLOWED_CONNECTOR_IDS = Object.freeze([
  "connector_0f9c9d4592e54d0a9a12b3f44a1e2010",
] as const);

export const DISALLOWED_CONNECTOR_PREFIX = "connector_openai_";

const FIRST_PARTY_CHAT_ORIGINATORS = new Set(["agenc_atlas", "agenc_desktop"]);

export function filterToolSuggestDiscoverableConnectors(
  directoryConnectors: readonly AppInfo[],
  accessibleConnectors: readonly AppInfo[],
  discoverableConnectorIds: ReadonlySet<string> | readonly string[],
  originatorValue: string,
): AppInfo[] {
  const discoverableIds = asReadonlySet(discoverableConnectorIds);
  const accessibleConnectorIds = new Set(
    accessibleConnectors
      .filter((connector) => connector.isAccessible)
      .map((connector) => connector.id),
  );

  return filterDisallowedConnectors(directoryConnectors, originatorValue)
    .filter((connector) => !accessibleConnectorIds.has(connector.id))
    .filter((connector) => discoverableIds.has(connector.id))
    .sort((left, right) =>
      ordinalCompare(left.name, right.name) ||
      ordinalCompare(left.id, right.id)
    );
}

export function filterDisallowedConnectors(
  connectors: readonly AppInfo[],
  originatorValue: string,
): AppInfo[] {
  const firstPartyChatOriginator = isFirstPartyChatOriginator(originatorValue);
  return connectors.filter((connector) =>
    isConnectorIdAllowed(connector.id, firstPartyChatOriginator),
  );
}

export function isConnectorIdAllowed(
  connectorId: string,
  firstPartyChatOriginator = false,
): boolean {
  const disallowedConnectorIds = firstPartyChatOriginator
    ? FIRST_PARTY_CHAT_DISALLOWED_CONNECTOR_IDS
    : DISALLOWED_CONNECTOR_IDS;

  return !connectorId.startsWith(DISALLOWED_CONNECTOR_PREFIX) &&
    !(disallowedConnectorIds as readonly string[]).includes(connectorId);
}

export function isFirstPartyChatOriginator(originatorValue: string): boolean {
  return FIRST_PARTY_CHAT_ORIGINATORS.has(originatorValue);
}

function asReadonlySet(
  values: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values);
}
