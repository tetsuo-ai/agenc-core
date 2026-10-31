/**
 * The provider authority a new session carries for its tools: the provider
 * environment and credential home they resolve a call's separate backends,
 * canonical keys, stored sign-ins and HTTP transport from
 * (tools/system/session-provider-authority.ts). Every path that creates a
 * session a tool can run under sets both when it creates the session, so a
 * tool never has to fall back to another session's at call time.
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
 * is created: a frozen copy of the parent's live provider environment (its
 * provider service's, which includes keys added during the session, the one
 * the child's providers are resolved from) and the parent's credential home.
 * Fields the parent lacks stay absent, so the child's tools fail closed
 * instead of reaching for anything else.
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
