import "../bootstrap/node-env.js";
import { prepareCliRuntime } from "./cli-runtime.js";
import { runCliProcessMain } from "./cli-process-main.js";
import { beginProgressiveAgenCCompileCachePublication, flushAgenCCompileCache } from "./compile-cache.js";
import { runDefaultCliRoute, type DefaultCliRouteAdapters } from "./default-cli-route.js";

type Client = Pick<DefaultCliRouteAdapters,
  "bootTUIEntry" | "resumeTUIEntry" | "continueTUIEntry" | "oneShotCLI">;
type ClientLoad = { readonly ok: true; readonly client: Client } |
  { readonly ok: false; readonly error: unknown };

/** The same print route, with client imports overlapping canonical daemon readiness. */
export async function printMain(
  loadClient?: () => Promise<Client>,
  prepareProvisionalDaemon?: DefaultCliRouteAdapters["prepareProvisionalDaemon"],
): Promise<number> {
  const ingressExitCode = prepareCliRuntime();
  if (ingressExitCode !== null) return ingressExitCode;

  type Scope = ReturnType<typeof import("../app-server/daemon-print-connection.js").createDaemonPrintConnectionScope>;
  let connection: Scope | undefined;
  let loadingConnection: Promise<Scope> | undefined;
  const scope = (): Promise<Scope> => loadingConnection ??= import("../app-server/daemon-print-connection.js")
    .then(({ createDaemonPrintConnectionScope }) => connection = createDaemonPrintConnectionScope());
  const defaultLoad = async (): Promise<Client> => {
    const { oneShotCLI } = await import("./daemon-one-shot-cli.js");
    return {
      oneShotCLI: (...args) => connection === undefined ? oneShotCLI(...args) : oneShotCLI(...args, {
        ensureDaemonReady: connection.ensureDaemonReady,
        createConnectedTuiClient: connection.createConnectedTuiClient,
      }),
      bootTUIEntry: async (...args) => (await import("./agenc-main.js")).bootTUIEntry(...args),
      resumeTUIEntry: async (...args) => (await import("./agenc-main.js")).resumeTUIEntry(...args),
      continueTUIEntry: async (...args) => (await import("./agenc-main.js")).continueTUIEntry(...args),
    };
  };

  // Invocation-local and handled immediately: an import rejection must neither
  // escape while readiness is pending nor replace an autostart failure.
  let loading: Promise<ClientLoad> | undefined;
  const preload = (): void => {
    loading ??= Promise.resolve().then(async () => {
      const stopPublishing = beginProgressiveAgenCCompileCachePublication();
      try { return await (loadClient ?? defaultLoad)(); }
      finally { stopPublishing(); }
    }).then(
      (client): ClientLoad => {
        // The early child can still be loading shared modules. Publish this
        // completed import without waiting for the CLI's eventual exit.
        flushAgenCCompileCache();
        return { ok: true, client };
      },
      (error: unknown): ClientLoad => ({ ok: false, error }),
    );
  };
  const client = async (): Promise<Client> => {
    preload();
    const result = await loading!;
    if (!result.ok) throw result.error;
    return result.client;
  };
  try { return await runDefaultCliRoute(process.argv, {
    onReadinessWaitStarted: preload,
    onAdmissionWaitStarted: preload,
    prepareProvisionalDaemon,
    ...(loadClient === undefined && process.platform === "linux" ? {
      requestPrintDaemonIdentity: async (target) => (await scope()).requestDaemonInstanceIdentity(target),
    } satisfies Pick<DefaultCliRouteAdapters, "requestPrintDaemonIdentity"> : {}),
    bootTUIEntry: async (...args) => (await client()).bootTUIEntry(...args),
    resumeTUIEntry: async (...args) => (await client()).resumeTUIEntry(...args),
    continueTUIEntry: async (...args) => (await client()).continueTUIEntry(...args),
    oneShotCLI: async (...args) => (await client()).oneShotCLI(...args),
  }); } finally {
    // Autostart/import/config/parse refusal can leave an authenticated but unused
    // connection. Join any allocation and close it on every exit.
    if (loadingConnection !== undefined) await loadingConnection.then(value => value.close(), () => {});
  }
}

export function runPrintCliEntry(): Promise<void> {
  return runCliProcessMain(async () => {
    const { tryPrepareProvisionalDaemon } = await import("../app-server/daemon-provisional-start.js");
    return printMain(undefined, () => tryPrepareProvisionalDaemon());
  });
}
