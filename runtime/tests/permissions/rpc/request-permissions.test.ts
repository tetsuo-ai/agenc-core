import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RequestPermissionsRpc,
  intersectRequestPermissionProfiles,
  normalizeRequestPermissionsArgs,
  normalizeRequestPermissionsResponse,
  requestPermissionProfileIsEmpty,
  requestPermissionsEventPermissionLabels,
  type RequestPermissionProfile,
} from "./request-permissions.js";

const cwd = path.resolve("/tmp/agenc-pe13");
const inputPath = path.join(cwd, "input.txt");
const outputPath = path.join(cwd, "out", "result.txt");

describe("request-permissions RPC profiles", () => {
  it("rejects unknown request namespaces while response grants ignore them", () => {
    expect(() =>
      normalizeRequestPermissionsArgs(
        {
          permissions: {
            network: { enabled: true },
            calendar: { enabled: true },
          },
        },
        { cwd },
      ),
    ).toThrow(/unknown field: calendar/);

    const response = normalizeRequestPermissionsResponse(
      { network: { enabled: true } },
      {
        permissions: {
          network: { enabled: true },
          calendar: { enabled: true },
        },
      },
      { cwd },
    );

    expect(response).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
      strictAutoReview: false,
    });
  });

  it("normalizes legacy read/write roots into canonical entries and labels events", () => {
    const args = normalizeRequestPermissionsArgs(
      {
        reason: "Need scoped file and network access",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["input.txt"],
            write: [outputPath],
          },
        },
      },
      { cwd },
    );

    expect(args).toEqual({
      reason: "Need scoped file and network access",
      permissions: {
        network: { enabled: true },
        fileSystem: {
          entries: [
            {
              path: { type: "path", path: inputPath },
              access: "read",
            },
            {
              path: { type: "path", path: outputPath },
              access: "write",
            },
          ],
        },
      },
    });
    expect(requestPermissionsEventPermissionLabels(args.permissions)).toEqual([
      "network",
      "file_system",
    ]);
  });

  it("rejects empty requested profiles and non-deny glob grants", () => {
    expect(() =>
      normalizeRequestPermissionsArgs({ permissions: {} }, { cwd }),
    ).toThrow(/requires at least one permission/);

    expect(() =>
      normalizeRequestPermissionsArgs(
        {
          permissions: {
            fileSystem: {
              entries: [
                {
                  path: { type: "glob_pattern", pattern: "**/*.ts" },
                  access: "read",
                },
              ],
            },
          },
        },
        { cwd },
      ),
    ).toThrow(/glob file system permissions only support deny-read entries/);
  });

  it("defaults response scope and strict auto review", () => {
    const response = normalizeRequestPermissionsResponse(
      { network: { enabled: true } },
      { permissions: { network: { enabled: true } } },
      { cwd },
    );

    expect(response).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
      strictAutoReview: false,
    });
  });

  it("rejects session-scoped strict auto review with an empty turn response", () => {
    const response = normalizeRequestPermissionsResponse(
      { network: { enabled: true } },
      {
        scope: "session",
        strictAutoReview: true,
        permissions: { network: { enabled: true } },
      },
      { cwd },
    );

    expect(response).toEqual({
      permissions: {},
      scope: "turn",
      strictAutoReview: false,
    });
  });

  it("preserves turn-scoped strict auto review on valid grants", () => {
    const response = normalizeRequestPermissionsResponse(
      { network: { enabled: true } },
      {
        strict_auto_review: true,
        permissions: { network: { enabled: true } },
      },
      { cwd },
    );

    expect(response).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
      strictAutoReview: true,
    });
  });

  it("intersects network grants only when requested and granted enabled=true", () => {
    expect(
      intersectRequestPermissionProfiles(
        { network: { enabled: true } },
        { network: { enabled: true } },
      ),
    ).toEqual({ network: { enabled: true } });
    expect(
      requestPermissionProfileIsEmpty(
        intersectRequestPermissionProfiles(
          { network: { enabled: true } },
          { network: { enabled: false } },
        ),
      ),
    ).toBe(true);
  });

  it("accepts an explicit child grant for a requested project-root scope", () => {
    const requested: RequestPermissionProfile = {
      fileSystem: {
        entries: [
          {
            path: {
              type: "special",
              value: { kind: "project_roots" },
            },
            access: "write",
          },
        ],
      },
    };
    const response = normalizeRequestPermissionsResponse(
      requested,
      {
        permissions: {
          fileSystem: {
            write: [outputPath],
          },
        },
      },
      { cwd },
    );

    expect(response.permissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: { type: "path", path: outputPath },
            access: "write",
          },
        ],
      },
    });
  });

  it("preserves exact unresolved special-path grants", () => {
    expect(
      intersectRequestPermissionProfiles(
        {
          fileSystem: {
            entries: [
              {
                path: { type: "special", value: { kind: "minimal" } },
                access: "read",
              },
            ],
          },
        },
        {
          fileSystem: {
            entries: [
              {
                path: { type: "special", value: { kind: "minimal" } },
                access: "read",
              },
            ],
          },
        },
      ),
    ).toEqual({
      fileSystem: {
        entries: [
          {
            path: { type: "special", value: { kind: "minimal" } },
            access: "read",
          },
        ],
      },
    });

    expect(
      intersectRequestPermissionProfiles(
        {
          fileSystem: {
            entries: [
              {
                path: {
                  type: "special",
                  value: { kind: "unknown", path: "future_token", subpath: "a" },
                },
                access: "write",
              },
            ],
          },
        },
        {
          fileSystem: {
            entries: [
              {
                path: {
                  type: "special",
                  value: { kind: "unknown", path: "future_token", subpath: "a" },
                },
                access: "read",
              },
            ],
          },
        },
      ),
    ).toEqual({
      fileSystem: {
        entries: [
          {
            path: {
              type: "special",
              value: { kind: "unknown", path: "future_token", subpath: "a" },
            },
            access: "read",
          },
        ],
      },
    });
  });

  it("drops broader file-system grants than the requested concrete path", () => {
    const response = normalizeRequestPermissionsResponse(
      {
        fileSystem: {
          entries: [
            {
              path: { type: "path", path: outputPath },
              access: "write",
            },
          ],
        },
      },
      {
        permissions: {
          fileSystem: {
            entries: [
              {
                path: {
                  type: "special",
                  value: { kind: "project_roots", subpath: null },
                },
                access: "write",
              },
            ],
          },
        },
      },
      { cwd },
    );

    expect(response.permissions).toEqual({});
  });

  it("retains path deny entries that constrain accepted grants", () => {
    const secretPath = path.join(cwd, ".env");
    const response = normalizeRequestPermissionsResponse(
      {
        fileSystem: {
          entries: [
            {
              path: { type: "path", path: cwd },
              access: "read",
            },
            {
              path: { type: "path", path: secretPath },
              access: "none",
            },
          ],
        },
      },
      {
        permissions: {
          fileSystem: {
            read: [cwd],
          },
        },
      },
      { cwd },
    );

    expect(response.permissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: { type: "path", path: cwd },
            access: "read",
          },
          {
            path: { type: "path", path: secretPath },
            access: "none",
          },
        ],
      },
    });
  });

  it("drops concrete grants blocked by requested exact deny paths", () => {
    const secretPath = path.join(cwd, ".env");
    const response = normalizeRequestPermissionsResponse(
      {
        fileSystem: {
          entries: [
            {
              path: { type: "path", path: cwd },
              access: "read",
            },
            {
              path: { type: "path", path: secretPath },
              access: "none",
            },
          ],
        },
      },
      {
        permissions: {
          fileSystem: {
            read: [secretPath],
          },
        },
      },
      { cwd },
    );

    expect(response.permissions).toEqual({});
  });

  it("retains constraining deny globs and merges bounded scan depth", () => {
    const response = normalizeRequestPermissionsResponse(
      {
        fileSystem: {
          globScanMaxDepth: 2,
          entries: [
            {
              path: { type: "path", path: cwd },
              access: "read",
            },
            {
              path: { type: "glob_pattern", pattern: "**/.env" },
              access: "none",
            },
          ],
        },
      },
      {
        permissions: {
          fileSystem: {
            globScanMaxDepth: 5,
            entries: [
              {
                path: { type: "path", path: cwd },
                access: "read",
              },
              {
                path: { type: "glob_pattern", pattern: "**/.secret" },
                access: "none",
              },
            ],
          },
        },
      },
      { cwd },
    );

    expect(response.permissions).toEqual({
      fileSystem: {
        globScanMaxDepth: 5,
        entries: [
          {
            path: { type: "path", path: cwd },
            access: "read",
          },
          {
            path: {
              type: "glob_pattern",
              pattern: path.resolve(cwd, "**/.env"),
            },
            access: "none",
          },
          {
            path: {
              type: "glob_pattern",
              pattern: path.resolve(cwd, "**/.secret"),
            },
            access: "none",
          },
        ],
      },
    });
  });

  it("drops concrete grants blocked by requested deny globs", () => {
    const secretPath = path.join(cwd, ".env");
    const response = normalizeRequestPermissionsResponse(
      {
        fileSystem: {
          entries: [
            {
              path: { type: "path", path: cwd },
              access: "read",
            },
            {
              path: { type: "glob_pattern", pattern: "**/.env" },
              access: "none",
            },
          ],
        },
      },
      {
        permissions: {
          fileSystem: {
            read: [secretPath],
          },
        },
      },
      { cwd },
    );

    expect(response.permissions).toEqual({});
  });

  it("fails closed for malformed deny globs without throwing", () => {
    const targetPath = path.join(cwd, "z");
    const outsidePrefixPath = path.join(cwd, "outside.txt");
    expect(() =>
      intersectRequestPermissionProfiles(
        {
          fileSystem: {
            entries: [
              {
                path: { type: "path", path: cwd },
                access: "read",
              },
              {
                path: { type: "glob_pattern", pattern: "[z-a]" },
                access: "none",
              },
            ],
          },
        },
        {
          fileSystem: {
            entries: [
              {
                path: { type: "path", path: targetPath },
                access: "read",
              },
            ],
          },
        },
        cwd,
      ),
    ).not.toThrow();
    expect(
      intersectRequestPermissionProfiles(
        {
          fileSystem: {
            entries: [
              {
                path: { type: "path", path: cwd },
                access: "read",
              },
              {
                path: { type: "glob_pattern", pattern: "[z-a]" },
                access: "none",
              },
            ],
          },
        },
        {
          fileSystem: {
            entries: [
              {
                path: { type: "path", path: targetPath },
                access: "read",
              },
            ],
          },
        },
        cwd,
      ),
    ).toEqual({});

    expect(
      normalizeRequestPermissionsResponse(
        {
          fileSystem: {
            entries: [
              {
                path: { type: "path", path: cwd },
                access: "read",
              },
              {
                path: { type: "glob_pattern", pattern: "[z-a]" },
                access: "none",
              },
            ],
          },
        },
        {
          permissions: {
            fileSystem: {
              read: [targetPath],
            },
          },
        },
        { cwd },
      ).permissions,
    ).toEqual({});

    expect(
      intersectRequestPermissionProfiles(
        {
          fileSystem: {
            entries: [
              {
                path: { type: "path", path: cwd },
                access: "read",
              },
              {
                path: { type: "glob_pattern", pattern: "safe/[z-a]" },
                access: "none",
              },
            ],
          },
        },
        {
          fileSystem: {
            entries: [
              {
                path: { type: "path", path: outsidePrefixPath },
                access: "read",
              },
            ],
          },
        },
        cwd,
      ),
    ).toEqual({});
  });

  it("resolves root, tmpdir, and slash_tmp special path grants", () => {
    const originalTmpdir = process.env["TMPDIR"];
    const tmpdir = path.join(cwd, "tmpdir");
    process.env["TMPDIR"] = tmpdir;
    try {
      expect(
        normalizeRequestPermissionsResponse(
          {
            fileSystem: {
              entries: [
                {
                  path: { type: "special", value: { kind: "root" } },
                  access: "read",
                },
              ],
            },
          },
          { permissions: { fileSystem: { read: [inputPath] } } },
          { cwd },
        ).permissions,
      ).toEqual({
        fileSystem: {
          entries: [
            {
              path: { type: "path", path: inputPath },
              access: "read",
            },
          ],
        },
      });

      const tmpdirChild = path.join(tmpdir, "child.txt");
      expect(
        normalizeRequestPermissionsResponse(
          {
            fileSystem: {
              entries: [
                {
                  path: { type: "special", value: { kind: "tmpdir" } },
                  access: "read",
                },
              ],
            },
          },
          { permissions: { fileSystem: { read: [tmpdirChild] } } },
          { cwd },
        ).permissions,
      ).toEqual({
        fileSystem: {
          entries: [
            {
              path: { type: "path", path: tmpdirChild },
              access: "read",
            },
          ],
        },
      });

      if (process.platform !== "win32") {
        const slashTmpChild = "/tmp/agenc-pe13-special.txt";
        expect(
          normalizeRequestPermissionsResponse(
            {
              fileSystem: {
                entries: [
                  {
                    path: { type: "special", value: { kind: "slash_tmp" } },
                    access: "read",
                  },
                ],
              },
            },
            { permissions: { fileSystem: { read: [slashTmpChild] } } },
            { cwd },
          ).permissions,
        ).toEqual({
          fileSystem: {
            entries: [
              {
                path: { type: "path", path: slashTmpChild },
                access: "read",
              },
            ],
          },
        });
      }
    } finally {
      if (originalTmpdir === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = originalTmpdir;
      }
    }
  });

  it("does not accept project-root grants when cwd is unavailable", () => {
    const response = normalizeRequestPermissionsResponse(
      {
        fileSystem: {
          entries: [
            {
              path: {
                type: "special",
                value: { kind: "project_roots" },
              },
              access: "write",
            },
          ],
        },
      },
      {
        permissions: {
          fileSystem: {
            write: [outputPath],
          },
        },
      },
    );

    expect(response.permissions).toEqual({});
  });

  it("tracks pending structured requests and resolves normalized responses", async () => {
    const rpc = new RequestPermissionsRpc();
    const pending = rpc.request({
      callId: "call-1",
      turnId: "turn-1",
      args: {
        permissions: {
          network: { enabled: true },
        },
      },
      cwd,
    });

    expect(rpc.pendingCount).toBe(1);
    expect(pending.event).toEqual({
      callId: "call-1",
      turnId: "turn-1",
      permissions: { network: { enabled: true } },
      cwd,
    });
    expect(
      rpc.respond("call-1", {
        permissions: { network: { enabled: true } },
        scope: "session",
      }),
    ).toBe(true);
    await expect(pending.response).resolves.toEqual({
      permissions: { network: { enabled: true } },
      scope: "session",
      strictAutoReview: false,
    });
    expect(rpc.pendingCount).toBe(0);
    expect(rpc.respond("call-1", { permissions: {} })).toBe(false);
  });

  it("resolves replaced, cancelled, and aborted requests with null", async () => {
    const rpc = new RequestPermissionsRpc();
    const first = rpc.request({
      callId: "call-1",
      args: { permissions: { network: { enabled: true } } },
      cwd,
    });
    const second = rpc.request({
      callId: "call-1",
      args: { permissions: { network: { enabled: true } } },
      cwd,
    });
    await expect(first.response).resolves.toBeNull();
    expect(rpc.pendingCount).toBe(1);
    expect(rpc.cancel("call-1")).toBe(true);
    await expect(second.response).resolves.toBeNull();

    const controller = new AbortController();
    const aborted = rpc.request({
      callId: "call-2",
      args: { permissions: { network: { enabled: true } } },
      cwd,
      signal: controller.signal,
    });
    controller.abort("done");
    await expect(aborted.response).resolves.toBeNull();
    expect(rpc.pendingCount).toBe(0);

    const pendingA = rpc.request({
      callId: "call-a",
      args: { permissions: { network: { enabled: true } } },
      cwd,
    });
    const pendingB = rpc.request({
      callId: "call-b",
      args: { permissions: { network: { enabled: true } } },
      cwd,
    });
    expect(rpc.abortAll()).toBe(2);
    await expect(pendingA.response).resolves.toBeNull();
    await expect(pendingB.response).resolves.toBeNull();

    const replacedByAlreadyAborted = rpc.request({
      callId: "call-c",
      args: { permissions: { network: { enabled: true } } },
      cwd,
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort("already done");
    const replacement = rpc.request({
      callId: "call-c",
      args: { permissions: { network: { enabled: true } } },
      cwd,
      signal: alreadyAborted.signal,
    });
    await expect(replacedByAlreadyAborted.response).resolves.toBeNull();
    await expect(replacement.response).resolves.toBeNull();
    expect(rpc.pendingCount).toBe(0);
  });
});
