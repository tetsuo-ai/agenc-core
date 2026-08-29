import {
  createDaemonTuiSession,
  type AgenCDaemonTuiClient,
  type AgenCDaemonTuiSessionOptions,
  type AgenCTuiBridgeSession,
} from "../../src/tui/daemon-session.js";

type RuntimeSettingsCursor =
  AgenCDaemonTuiSessionOptions["runtimeSettingsCursor"];

export type DaemonTuiSessionFixtureOptions = Omit<
  AgenCDaemonTuiSessionOptions,
  "runtimeSettingsCursor"
> & {
  readonly runtimeSettingsCursor?: RuntimeSettingsCursor;
};

const defaultRuntimeSettingsCursor = (): RuntimeSettingsCursor => ({
  eventId: "test-runtime-settings:initial",
  cwd: process.cwd(),
});

export function createDaemonTuiSessionFixture(
  options: DaemonTuiSessionFixtureOptions,
): ReturnType<typeof createDaemonTuiSession<AgenCTuiBridgeSession>> {
  return createDaemonTuiSession({
    runtimeSettingsCursor: defaultRuntimeSettingsCursor(),
    ...options,
  });
}

export async function attachDaemonTuiSessionFixture(
  options: DaemonTuiSessionFixtureOptions & {
    readonly client: AgenCDaemonTuiClient;
  },
): Promise<ReturnType<typeof createDaemonTuiSessionFixture>> {
  await options.client.request("session.attach", {
    sessionId: options.sessionId,
    clientId: options.clientId,
  });
  return createDaemonTuiSessionFixture(options);
}
