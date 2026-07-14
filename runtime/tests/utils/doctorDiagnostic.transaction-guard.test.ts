import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildTransactionGuardWarning,
  getTransactionGuardDoctorStatus,
  probeTransactionGuardEndpoint,
  type DiagnosticInfo,
  type TransactionGuardDoctorStatus,
} from "../../src/utils/doctorDiagnostic.js";
import { formatDiagnosticText } from "../../src/bin/doctor-cli.js";

// MACRO is a build-time esbuild define (tsup); it is not defined under
// vitest. Stand it in for the suite, mirroring the established pattern.
let priorMacro: unknown;
beforeAll(() => {
  priorMacro = (globalThis as { MACRO?: unknown }).MACRO;
  (globalThis as { MACRO?: unknown }).MACRO = {
    VERSION: "test",
    PACKAGE_URL: "@tetsuo-ai/agenc",
  };
});
afterAll(() => {
  (globalThis as { MACRO?: unknown }).MACRO = priorMacro;
});

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

async function startReachableEndpoint(): Promise<string> {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("Ollama is running");
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

/** A 127.0.0.1 URL with no listener behind it (grab a port, release it). */
async function unreachableEndpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

function diagnosticFixture(
  transactionGuard: TransactionGuardDoctorStatus,
): DiagnosticInfo {
  return {
    installationType: "development",
    version: "test",
    installationPath: "/tmp/agenc",
    invokedBinary: "/tmp/agenc/bin",
    configInstallMethod: "not set",
    autoUpdates: "enabled",
    hasUpdatePermissions: null,
    multipleInstallations: [],
    warnings: [],
    ripgrepStatus: { working: true, mode: "system", systemPath: "/usr/bin/rg" },
    transactionGuard,
  };
}

describe("getTransactionGuardDoctorStatus", () => {
  it("reports an enabled guard with a reachable endpoint", async () => {
    const endpoint = await startReachableEndpoint();
    const status = await getTransactionGuardDoctorStatus({
      config: { enabled: true, model: "guard-model", endpoint },
      env: {},
    });
    expect(status).toEqual({
      enabled: true,
      source: "config",
      model: "guard-model",
      endpoint,
      failMode: "closed",
      endpointReachable: true,
    });
    expect(buildTransactionGuardWarning(status)).toBeNull();
  });

  it("reports an enabled guard with an unreachable endpoint and warns", async () => {
    const endpoint = await unreachableEndpoint();
    const status = await getTransactionGuardDoctorStatus({
      config: { enabled: true, endpoint },
      env: {},
    });
    expect(status.enabled).toBe(true);
    expect(status.endpointReachable).toBe(false);
    const warning = buildTransactionGuardWarning(status);
    expect(warning).not.toBeNull();
    expect(warning?.issue).toContain(endpoint);
    expect(warning?.issue).toContain("blocked");
    expect(warning?.fix).toContain("ollama serve");
  });

  it("does not probe (and does not warn) when the guard is disabled", async () => {
    const status = await getTransactionGuardDoctorStatus({
      config: null,
      env: {},
      probe: () => {
        throw new Error("probe must not run for a disabled guard");
      },
    });
    expect(status).toEqual({
      enabled: false,
      source: "default",
      model: "gemma4:e4b",
      endpoint: "http://127.0.0.1:11434",
      failMode: "closed",
      endpointReachable: null,
    });
    expect(buildTransactionGuardWarning(status)).toBeNull();
  });

  it("reports env as the enablement source and fail-open in the warning", async () => {
    const endpoint = await unreachableEndpoint();
    const status = await getTransactionGuardDoctorStatus({
      config: null,
      env: {
        AGENC_TRANSACTION_GUARD: "slm",
        AGENC_TRANSACTION_GUARD_OLLAMA_URL: endpoint,
        AGENC_TRANSACTION_GUARD_FAIL_MODE: "open",
      },
    });
    expect(status.source).toBe("env");
    expect(status.failMode).toBe("open");
    expect(status.endpointReachable).toBe(false);
    const warning = buildTransactionGuardWarning(status);
    expect(warning?.issue).toContain("WITHOUT the SLM guard");
  });

  it("never throws when the injected probe rejects", async () => {
    const status = await getTransactionGuardDoctorStatus({
      config: { enabled: true },
      env: {},
      probe: () => Promise.reject(new Error("boom")),
    });
    expect(status.endpointReachable).toBe(false);
  });
});

describe("probeTransactionGuardEndpoint", () => {
  it("is true for any responding server and false for a closed port", async () => {
    const up = await startReachableEndpoint();
    const down = await unreachableEndpoint();
    await expect(probeTransactionGuardEndpoint(up)).resolves.toBe(true);
    await expect(probeTransactionGuardEndpoint(down)).resolves.toBe(false);
  });

  it("returns false (never throws) on a malformed endpoint", async () => {
    await expect(
      probeTransactionGuardEndpoint("not-a-url"),
    ).resolves.toBe(false);
    await expect(
      probeTransactionGuardEndpoint("data:text/plain,not-an-http-endpoint"),
    ).resolves.toBe(false);
  });
});

describe("doctor output includes the transaction guard section", () => {
  it("shows an enabled guard with a reachable endpoint", async () => {
    const endpoint = await startReachableEndpoint();
    const status = await getTransactionGuardDoctorStatus({
      config: { enabled: true, model: "guard-model", endpoint },
      env: {},
    });
    const text = formatDiagnosticText(diagnosticFixture(status));
    expect(text).toContain(
      "Transaction guard:  enabled (source: config, fail-closed)",
    );
    expect(text).toContain("model:    guard-model");
    expect(text).toContain(`endpoint: ${endpoint} (reachable)`);
  });

  it("shows an enabled guard with an unreachable endpoint", async () => {
    const endpoint = await unreachableEndpoint();
    const status = await getTransactionGuardDoctorStatus({
      config: { enabled: true, endpoint },
      env: {},
    });
    const text = formatDiagnosticText(diagnosticFixture(status));
    expect(text).toContain(`endpoint: ${endpoint} (UNREACHABLE)`);
  });

  it("shows a disabled guard as a single status line", async () => {
    const status = await getTransactionGuardDoctorStatus({
      config: null,
      env: {},
    });
    const text = formatDiagnosticText(diagnosticFixture(status));
    expect(text).toContain(
      "Transaction guard:  disabled (source: default, fail-closed)",
    );
    expect(text).not.toContain("endpoint:");
  });
});
