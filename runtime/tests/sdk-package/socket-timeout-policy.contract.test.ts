import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgencSocketTransport,
  connect,
} from "../../../packages/agenc-sdk/src/socket";
import {
  AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV,
  MAX_DAEMON_REQUEST_TIMEOUT_MS,
  resolveAgenCDaemonRequestTimeoutMs,
} from "../../src/app-server/daemon-request-policy.js";

const SDK_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

let root: string | null = null;
let server: Server | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (root !== null) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

describe.skipIf(process.platform === "win32")(
  "SDK daemon request timeout policy parity",
  () => {
    it("keeps the SDK mirror aligned with the runtime grammar and timer bound", async () => {
      root = await mkdtemp(join(tmpdir(), "agenc-sdk-timeout-policy-"));
      const socketPath = join(root, "daemon.sock");
      const cookiePath = join(root, "daemon.cookie");
      await writeFile(cookiePath, "test-cookie\n", { mode: 0o600 });
      server = createServer();
      server.listen(socketPath);
      await new Promise<void>((resolve) => server!.once("listening", resolve));

      const transport = {
        request: vi.fn(async (request: { readonly id: string | number }) => ({
          jsonrpc: "2.0" as const,
          id: request.id,
          result: {
            type: "initialized" as const,
            protocolVersion: "1.9.0",
            protocol: { version: "1.9.0" },
            capabilities: {},
          },
        })),
        close: vi.fn(async () => {}),
      } as unknown as AgencSocketTransport;
      const connectTransport = vi
        .spyOn(AgencSocketTransport, "connect")
        .mockResolvedValue(transport);

      const cases: ReadonlyArray<{
        readonly label: string;
        readonly raw: string | undefined;
      }> = [
        { label: "missing", raw: undefined },
        { label: "empty", raw: "" },
        { label: "blank whitespace", raw: " \t\n" },
        { label: "trimmed integer", raw: " 42 " },
        { label: "zero", raw: "0" },
        { label: "leading zeros", raw: "01" },
        { label: "plus sign", raw: "+1" },
        { label: "negative sign", raw: "-1" },
        { label: "fraction", raw: "1.5" },
        { label: "exponent", raw: "1e3" },
        {
          label: "maximum",
          raw: String(MAX_DAEMON_REQUEST_TIMEOUT_MS),
        },
        {
          label: "timer overflow",
          raw: String(MAX_DAEMON_REQUEST_TIMEOUT_MS + 1),
        },
        { label: "numeric overflow", raw: "9".repeat(400) },
      ];

      for (const testCase of cases) {
        const env =
          testCase.raw === undefined
            ? {}
            : { [AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV]: testCase.raw };
        let runtimeValue = SDK_DEFAULT_REQUEST_TIMEOUT_MS;
        try {
          runtimeValue = resolveAgenCDaemonRequestTimeoutMs(
            env,
            SDK_DEFAULT_REQUEST_TIMEOUT_MS,
          );
        } catch {
          // The SDK keeps its existing invalid-env fallback behavior while
          // matching the runtime authority's accepted grammar and bound.
        }

        connectTransport.mockClear();
        const client = await connect({
          env,
          socketPath,
          cookiePath,
          autostart: false,
        });
        expect(connectTransport).toHaveBeenCalledTimes(2);
        const sdkOptions = connectTransport.mock.calls.at(-1)?.[0];
        expect(sdkOptions?.requestTimeoutMs, testCase.label).toBe(runtimeValue);
        await client.close();
      }
    });
  },
);
