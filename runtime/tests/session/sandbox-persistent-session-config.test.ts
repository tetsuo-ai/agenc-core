import { describe, expect, test } from "vitest";

import { defaultConfig } from "../../src/config/schema.js";
import {
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
  sessionConfigurationFromAgenCConfig,
  sessionExecutionAuthorityFromConfiguration,
} from "../../src/session/configuration.js";

const WORKSPACE = "/tmp/ws";

function configure(sandbox?: { readonly persistent_session?: boolean }) {
  return sessionConfigurationFromAgenCConfig({
    config: {
      ...defaultConfig(),
      ...(sandbox === undefined ? {} : { sandbox }),
    },
    workspaceRoot: WORKSPACE,
    model: "grok-4.3",
  });
}

describe("sandbox persistent_session config projection", () => {
  test("omits the sparse opt-out unless the operator disables the session sandbox", () => {
    const configured = configure();
    const authority = sessionExecutionAuthorityFromConfiguration(configured);

    expect(configured.sandboxPersistentSession).toBeUndefined();
    expect(authority.sandboxPersistentSession).toBeUndefined();
    expect(
      sandboxExecutionBrokerAuthorityFromSessionAuthority(authority, WORKSPACE)
        .persistentSession,
    ).toBeUndefined();
  });

  test("maps persistent_session false onto broker authority without other sandbox changes", () => {
    const configured = configure({ persistent_session: false });
    const authority = sessionExecutionAuthorityFromConfiguration(configured);
    const broker = sandboxExecutionBrokerAuthorityFromSessionAuthority(
      authority,
      WORKSPACE,
    );

    expect(configured.sandboxPersistentSession).toBe(false);
    expect(authority.sandboxPersistentSession).toBe(false);
    expect(broker.persistentSession).toBe(false);
    expect(configured.sandboxPolicy.value).toBe("workspace_write");
    expect(broker.mode).toBe("workspace_write");
  });

  test("treats an explicit true the same as an omitted field", () => {
    const configured = configure({ persistent_session: true });
    const authority = sessionExecutionAuthorityFromConfiguration(configured);

    expect(configured.sandboxPersistentSession).toBeUndefined();
    expect(
      sandboxExecutionBrokerAuthorityFromSessionAuthority(authority, WORKSPACE)
        .persistentSession,
    ).toBeUndefined();
  });
});
