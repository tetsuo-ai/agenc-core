/**
 * The provider authority a new session is created with: the provider
 * environment and credential home that seed its own provider service, whose
 * live state its model calls and its tools read
 * (tools/system/session-provider-authority.ts). Every path that creates a
 * session a tool can run under sets both when it creates the session; after
 * that the session's state is its own, so a key added or rotated in one
 * session never reaches another.
 *
 * @module
 */

import type { HomeContext } from "../config/home.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";

export interface SessionToolAuthority {
  readonly providerEnvironment?: ProviderEnvironment;
  readonly credentialHome?: HomeContext;
}

interface ParentSessionAuthority {
  readonly providerService?: { environment?(): ProviderEnvironment } | undefined;
  readonly services: {
    readonly providerEnvironment?: ProviderEnvironment;
    readonly credentialHome?: HomeContext;
  };
}

/**
 * A child session's own copy of its parent's authority, taken when the child
 * is created: a frozen copy of the parent's current provider environment
 * (its provider service's, keys added during the session included) and the
 * parent's credential home. The child's provider service is seeded from
 * them. Fields the parent lacks stay absent, so the child's tools fail
 * closed instead of reaching for anything else.
 */
export function childSessionAuthority(parent: ParentSessionAuthority): SessionToolAuthority {
  const environment = parent.providerService?.environment?.() ?? parent.services.providerEnvironment;
  return {
    ...(environment !== undefined
      ? { providerEnvironment: Object.freeze({ ...environment }) as ProviderEnvironment }
      : {}),
    ...(parent.services.credentialHome !== undefined
      ? { credentialHome: parent.services.credentialHome }
      : {}),
  };
}
