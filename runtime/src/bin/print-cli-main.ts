import "../bootstrap/node-env.js";
import { prepareCliRuntime } from "./cli-runtime.js";
import { runCliProcessMain } from "./cli-process-main.js";
import { runDefaultCliRoute, type DefaultCliRouteAdapters } from "./default-cli-route.js";

type Client = Pick<DefaultCliRouteAdapters,
  "bootTUIEntry" | "resumeTUIEntry" | "continueTUIEntry" | "oneShotCLI">;
type ClientLoad = { readonly ok: true; readonly client: Client } |
  { readonly ok: false; readonly error: unknown };

/** The same print route, with client imports overlapping canonical daemon readiness. */
export async function printMain(
  loadClient: () => Promise<Client> = () => import("./agenc-main.js"),
): Promise<number> {
  const ingressExitCode = prepareCliRuntime();
  if (ingressExitCode !== null) return ingressExitCode;

  // Invocation-local and handled immediately: an import rejection must neither
  // escape while readiness is pending nor replace an autostart failure.
  let loading: Promise<ClientLoad> | undefined;
  const preload = (): void => {
    loading ??= Promise.resolve().then(loadClient).then(
      (client): ClientLoad => ({ ok: true, client }),
      (error: unknown): ClientLoad => ({ ok: false, error }),
    );
  };
  const client = async (): Promise<Client> => {
    preload();
    const result = await loading!;
    if (!result.ok) throw result.error;
    return result.client;
  };
  return runDefaultCliRoute(process.argv, {
    onReadinessWaitStarted: preload,
    bootTUIEntry: async (...args) => (await client()).bootTUIEntry(...args),
    resumeTUIEntry: async (...args) => (await client()).resumeTUIEntry(...args),
    continueTUIEntry: async (...args) => (await client()).continueTUIEntry(...args),
    oneShotCLI: async (...args) => (await client()).oneShotCLI(...args),
  });
}

export function runPrintCliEntry(): Promise<void> {
  return runCliProcessMain(printMain);
}
