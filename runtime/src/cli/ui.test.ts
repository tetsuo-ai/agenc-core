import { Writable } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runUiCommand } from "./ui.js";

function captureStream(): { stream: Writable; data: () => string } {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    data: () => data,
  };
}

const tempRoots: string[] = [];

async function createDashboardFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-ui-dashboard-"));
  tempRoots.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><html><body>dashboard</body></html>");
  await writeFile(join(root, "assets", "app.js"), "console.log('ok');");
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const baseDeps = {
  defaultConfigPath: () => "/tmp/.agenc/config.json",
  defaultPidPath: () => "/tmp/.agenc/daemon.pid",
  readPidFile: vi.fn(async () => ({
    pid: 43210,
    port: 4310,
    configPath: "/tmp/.agenc/config.json",
  })),
  isProcessAlive: vi.fn(() => true),
  runStartCommand: vi.fn(async () => 0 as const),
  findDaemonProcessesByIdentity: vi.fn(async () => []),
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
  processPlatform: "linux" as const,
};

describe("agenc ui", () => {
  it("prints the loopback dashboard URL and opens it by default", async () => {
    const dashboardRoot = await createDashboardFixture();
    const stdout = captureStream();
    const stderr = captureStream();
    const openUrl = vi.fn(async () => {});

    const code = await runUiCommand(
      {
        env: {
          AGENC_DASHBOARD_DIST: dashboardRoot,
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
      {
        ...baseDeps,
        loadGatewayConfig: vi.fn(async () => ({
          gateway: { port: 4310, bind: "127.0.0.1" },
          agent: { name: "demo-agent" },
          connection: { rpcUrl: "http://127.0.0.1:8899" },
        })),
        openUrl,
      },
    );

    expect(code).toBe(0);
    expect(stdout.data()).toContain("http://127.0.0.1:4310/ui/");
    expect(stderr.data()).toBe("");
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:4310/ui/", {
      platform: "linux",
      cwd: undefined,
      env: {
        AGENC_DASHBOARD_DIST: dashboardRoot,
      },
    });
  });

  it("uses loopback access for a non-loopback bind when local bypass is enabled", async () => {
    const dashboardRoot = await createDashboardFixture();
    const stdout = captureStream();
    const openUrl = vi.fn(async () => {});

    const code = await runUiCommand(
      {
        env: {
          AGENC_DASHBOARD_DIST: dashboardRoot,
        },
        stdout: stdout.stream,
        open: false,
      },
      {
        ...baseDeps,
        readPidFile: vi.fn(async () => ({
          pid: 43210,
          port: 3222,
          configPath: "/tmp/.agenc/config.json",
        })),
        loadGatewayConfig: vi.fn(async () => ({
          gateway: { port: 3222, bind: "0.0.0.0" },
          agent: { name: "demo-agent" },
          connection: { rpcUrl: "http://127.0.0.1:8899" },
          auth: { secret: "top-secret", localBypass: true },
        })),
        openUrl,
      },
    );

    expect(code).toBe(0);
    expect(stdout.data()).toContain("http://127.0.0.1:3222/ui/");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("fails fast when auth.secret is enabled without localBypass", async () => {
    const dashboardRoot = await createDashboardFixture();
    const stdout = captureStream();
    const stderr = captureStream();
    const openUrl = vi.fn(async () => {});

    await expect(
      runUiCommand(
        {
          env: {
            AGENC_DASHBOARD_DIST: dashboardRoot,
          },
          stdout: stdout.stream,
          stderr: stderr.stream,
        },
        {
          ...baseDeps,
          loadGatewayConfig: vi.fn(async () => ({
            gateway: { port: 4310, bind: "0.0.0.0" },
            agent: { name: "demo-agent" },
            connection: { rpcUrl: "http://127.0.0.1:8899" },
            auth: { secret: "top-secret", localBypass: false },
          })),
          openUrl,
        },
      ),
    ).rejects.toThrow(/auth\.localBypass=true/);

    expect(stdout.data()).toBe("");
    expect(stderr.data()).toBe("");
    expect(openUrl).not.toHaveBeenCalled();
  });
});
