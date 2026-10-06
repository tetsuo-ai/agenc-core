/**
 * Project trust over the daemon: `project.trustStatus` and `project.trust`
 * resolve a working directory to the project root a session started there
 * would use, so a client never records trust Core does not read.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { isDaemonPriorityMessage } from "../../src/app-server/overload.js";
import { AgenCProjectTrustService } from "../../src/app-server/project-trust.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type JsonObject,
} from "../../src/app-server/protocol/index.js";
import {
  readTrustedProjects,
  resolveProjectTrustStateSync,
  trustedProjectsPath,
} from "../../src/permissions/trust/project-trust.js";
import { RemoteAccessBoundary } from "../../src/remote/access.js";
import { RemoteApprovalProjection } from "../../src/remote/approvals.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A private home and a git repository with a package folder inside it. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-project-trust-")));
  roots.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  const sub = join(repo, "packages", "web");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  const env = { ...process.env, AGENC_HOME: home };
  return { root, home, repo, sub, env };
}

function trustService(
  home: string,
  markers: () => readonly string[] | undefined = () => undefined,
) {
  return new AgenCProjectTrustService({
    agencHome: home,
    projectRootMarkers: markers,
  });
}

function localDispatcher(
  home: string,
  markers?: () => readonly string[] | undefined,
) {
  return new AgenCDaemonJsonRpcDispatcher({
    agentManager: {} as never,
    initializeAuthenticator: (params) => params.authCookie === "cookie",
    projectTrust: trustService(home, markers),
  });
}

const request = (method: string, params: JsonObject = {}): JsonObject => ({
  jsonrpc: JSON_RPC_VERSION,
  id: method,
  method,
  params,
});

async function connect(
  dispatcher: AgenCDaemonJsonRpcDispatcher,
  version: string = AGENC_DAEMON_PROTOCOL_VERSION,
) {
  const connection = dispatcher.createConnection();
  const initialized = (await connection.dispatch(
    request("initialize", { protocol: { version }, authCookie: "cookie" }),
  )) as { result?: { capabilities?: JsonObject } };
  const methods = initialized.result?.capabilities?.[
    AGENC_DAEMON_METHOD_CAPABILITIES_KEY
  ] as Record<string, boolean> | undefined;
  return { connection, methods };
}

describe("project trust keyed by the resolved project root", () => {
  it("leaves a repository subfolder untrusted in Core when only that exact folder is recorded", () => {
    // What AgenC Desktop wrote before it asked Core: the picked folder, as-is.
    const { home, sub, env } = fixture();
    writeFileSync(
      trustedProjectsPath({ agencHome: home }),
      `${JSON.stringify({
        version: 1,
        trustedProjects: [{ path: sub, trustedAt: "2026-09-23T00:00:00.000Z" }],
      })}\n`,
    );
    // A session started there resolves its root to the repository and
    // looks that up exactly, so every tool call still needs approval.
    expect(
      resolveProjectTrustStateSync({ agencHome: home, env, cwd: sub }),
    ).toBe("untrusted");
  });

  it("reports the root a session in that folder would use", async () => {
    const { home, repo, sub } = fixture();
    writeFileSync(
      trustedProjectsPath({ agencHome: home }),
      `${JSON.stringify({
        version: 1,
        trustedProjects: [{ path: sub, trustedAt: "2026-09-23T00:00:00.000Z" }],
      })}\n`,
    );
    const { connection } = await connect(localDispatcher(home));
    await expect(
      connection.dispatch(request("project.trustStatus", { cwd: sub })),
    ).resolves.toMatchObject({
      result: { cwd: sub, projectRoot: repo, trusted: false },
    });
  });

  it("records trust for the resolved root, which a session in the subfolder then reads", async () => {
    const { home, repo, sub, env } = fixture();
    const { connection } = await connect(localDispatcher(home));

    await expect(
      connection.dispatch(request("project.trust", { cwd: sub })),
    ).resolves.toMatchObject({
      result: { cwd: sub, projectRoot: repo, trusted: true, alreadyTrusted: false },
    });

    const recorded = await readTrustedProjects({ agencHome: home });
    expect(recorded.trustedProjects.map((entry) => entry.path)).toEqual([repo]);
    expect(
      resolveProjectTrustStateSync({ agencHome: home, env, cwd: sub }),
    ).toBe("trusted");
    for (const cwd of [sub, repo]) {
      await expect(
        connection.dispatch(request("project.trustStatus", { cwd })),
      ).resolves.toMatchObject({
        result: { cwd, projectRoot: repo, trusted: true },
      });
    }
    await expect(
      connection.dispatch(request("project.trust", { cwd: repo })),
    ).resolves.toMatchObject({
      result: { projectRoot: repo, trusted: true, alreadyTrusted: true },
    });
  });

  it("keeps the other records in the trust file", async () => {
    const { home, repo, sub } = fixture();
    const digest = "a".repeat(64);
    writeFileSync(
      trustedProjectsPath({ agencHome: home }),
      `${JSON.stringify({
        version: 1,
        trustedProjects: [],
        projectMcpServerChoices: [
          { path: repo, approvedServerDigests: { docs: digest } },
        ],
        securityAcknowledgements: {
          "auto-mode-permission-prompt": "2026-09-01T00:00:00.000Z",
        },
      })}\n`,
    );
    const { connection } = await connect(localDispatcher(home));
    await connection.dispatch(request("project.trust", { cwd: sub }));
    const saved = JSON.parse(
      readFileSync(trustedProjectsPath({ agencHome: home }), "utf8"),
    );
    expect(saved.projectMcpServerChoices).toEqual([
      { path: repo, approvedServerDigests: { docs: digest } },
    ]);
    expect(saved.securityAcknowledgements).toEqual({
      "auto-mode-permission-prompt": "2026-09-01T00:00:00.000Z",
    });
  });

  it("uses the configured project_root_markers, read again after a reload", async () => {
    const { root, home } = fixture();
    const mono = join(root, "mono");
    const app = join(mono, "apps", "site");
    mkdirSync(join(app, ".git"), { recursive: true });
    writeFileSync(join(mono, "WORKSPACE"), "");
    let markers: readonly string[] | undefined = ["WORKSPACE"];
    const { connection } = await connect(localDispatcher(home, () => markers));

    await expect(
      connection.dispatch(request("project.trustStatus", { cwd: app })),
    ).resolves.toMatchObject({ result: { projectRoot: mono } });
    markers = undefined;
    await expect(
      connection.dispatch(request("project.trustStatus", { cwd: app })),
    ).resolves.toMatchObject({ result: { projectRoot: app } });
  });

  it("canonicalizes the folder the way a session does before resolving it", async () => {
    const { root, home, repo, sub } = fixture();
    const link = join(root, "web-link");
    symlinkSync(sub, link, "dir");
    const { connection } = await connect(localDispatcher(home));

    await expect(
      connection.dispatch(request("project.trust", { cwd: link })),
    ).resolves.toMatchObject({
      result: { cwd: sub, projectRoot: repo, trusted: true },
    });
    await expect(
      connection.dispatch(
        request("project.trustStatus", { cwd: `${sub}/../web/` }),
      ),
    ).resolves.toMatchObject({
      result: { cwd: sub, projectRoot: repo, trusted: true },
    });
  });

  it("accepts only an absolute path to an existing directory, and writes nothing otherwise", async () => {
    const { root, home, sub } = fixture();
    const file = join(root, "notes.txt");
    writeFileSync(file, "not a folder");
    const { connection } = await connect(localDispatcher(home));

    for (const method of ["project.trustStatus", "project.trust"]) {
      for (const params of [
        {},
        { cwd: "" },
        { cwd: "   " },
        { cwd: "packages/web" },
        { cwd: 42 },
        { cwd: join(root, "missing") },
        { cwd: file },
        { cwd: sub, projectRoot: "/" },
      ] as JsonObject[]) {
        await expect(
          connection.dispatch(request(method, params)),
        ).resolves.toMatchObject({
          error: { code: -32602, data: { code: "INVALID_ARGUMENT" } },
        });
      }
    }
    expect(existsSync(trustedProjectsPath({ agencHome: home }))).toBe(false);
  });
});

describe("project trust client restriction", () => {
  it("is advertised and answered only on an authenticated local connection", async () => {
    const { home, sub } = fixture();
    const { connection, methods } = await connect(localDispatcher(home));
    expect(methods?.["project.trustStatus"]).toBe(true);
    expect(methods?.["project.trust"]).toBe(true);
    await expect(
      connection.dispatch(request("project.trustStatus", { cwd: sub })),
    ).resolves.toHaveProperty("result");
  });

  it("is unavailable without daemon transport authentication", async () => {
    const { home, sub } = fixture();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
      projectTrust: trustService(home),
    });
    const { connection, methods } = await connect(dispatcher);
    expect(methods?.["project.trustStatus"]).toBe(false);
    expect(methods?.["project.trust"]).toBe(false);
    for (const method of ["project.trustStatus", "project.trust"]) {
      await expect(
        connection.dispatch(request(method, { cwd: sub })),
      ).resolves.toMatchObject({ error: { code: -32601 } });
    }
    expect(existsSync(trustedProjectsPath({ agencHome: home }))).toBe(false);
  });

  it("is unavailable to a client that negotiated protocol 1.15", async () => {
    const { home, sub } = fixture();
    const { connection, methods } = await connect(localDispatcher(home), "1.15.0");
    expect(methods?.["project.trustStatus"]).toBe(false);
    expect(methods?.["project.trust"]).toBe(false);
    await expect(
      connection.dispatch(request("project.trust", { cwd: sub })),
    ).resolves.toMatchObject({ error: { code: -32601 } });
    expect(existsSync(trustedProjectsPath({ agencHome: home }))).toBe(false);
  });

  it("is refused to a remote browser or relay connection", async () => {
    const { root, home, repo, sub } = fixture();
    const privateHome = join(root, "private");
    mkdirSync(privateHome);
    const boundary = new RemoteAccessBoundary(
      {
        workspaceId: "workspace",
        workspacePath: repo,
        sessionIds: [],
        role: "control",
        allowFiles: true,
        allowApprovals: true,
      },
      () => true,
      async () => null,
      privateHome,
      { approvals: new RemoteApprovalProjection() },
    );
    const dispatcher = localDispatcher(home);
    const remote = dispatcher.createConnection({ remoteAccess: boundary });
    const initialized = (await remote.dispatch(
      request("initialize", {
        protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
        authCookie: "cookie",
      }),
    )) as { result?: { capabilities?: JsonObject } };
    const methods = initialized.result?.capabilities?.[
      AGENC_DAEMON_METHOD_CAPABILITIES_KEY
    ] as Record<string, boolean> | undefined;
    expect(methods?.["project.trustStatus"]).toBe(false);
    expect(methods?.["project.trust"]).toBe(false);
    for (const method of ["project.trustStatus", "project.trust"]) {
      await expect(
        remote.dispatch(request(method, { cwd: sub })),
      ).resolves.toMatchObject({
        error: { data: { code: "REMOTE_METHOD_DENIED" } },
      });
    }
    expect(existsSync(trustedProjectsPath({ agencHome: home }))).toBe(false);
  });

  it("answers on the priority lane, since a waiting approval can depend on it", () => {
    expect(isDaemonPriorityMessage(request("project.trustStatus"))).toBe(true);
    expect(isDaemonPriorityMessage(request("project.trust"))).toBe(true);
  });
});
