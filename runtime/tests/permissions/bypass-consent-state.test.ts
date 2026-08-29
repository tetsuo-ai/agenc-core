import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";
import { RuntimeStateRepository } from "../../src/config/runtime-state-repository.js";
import {
  authorizeBypassPermissionsConsent,
  bindBypassPermissionsConsent,
  canonicalizeBypassPermissionsCwd,
  loadBypassPermissionsConsent,
  recordBypassPermissionsConsent,
} from "../../src/permissions/bypass-consent-state.js";
import type { ToolPermissionContext } from "../../src/permissions/types.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-bypass-consent-"));
  roots.push(root);
  return root;
}

function persistedIdentity(canonicalCwd: string) {
  const identity = lstatSync(canonicalCwd, { bigint: true });
  return {
    version: 1,
    canonicalCwd,
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("bypass permission consent state", () => {
  it("returns immutable consent contexts without retaining caller aliases", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const canonicalCwd = canonicalizeBypassPermissionsCwd(workspace);
    const accepted = [canonicalCwd];
    const rules = ["Read(src/**)"];
    const directory = { path: workspace, source: "session" as const };
    const directories = new Map([[workspace, directory]]);
    const input: ToolPermissionContext = {
      mode: "default",
      additionalWorkingDirectories: directories,
      alwaysAllowRules: { session: rules },
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
      bypassPermissionsAcceptedIn: accepted,
    };

    const bound = bindBypassPermissionsConsent(input, canonicalCwd);
    const authorized = authorizeBypassPermissionsConsent(bound, canonicalCwd);
    accepted.push(canonicalizeBypassPermissionsCwd(root));
    rules.push("Write(**)");
    directory.path = root;
    directories.clear();

    expect(bound).not.toBe(input);
    expect(bound.bypassPermissionsAcceptedIn).toEqual([canonicalCwd]);
    expect(bound.alwaysAllowRules.session).toEqual(["Read(src/**)"]);
    expect(bound.additionalWorkingDirectories.get(workspace)).toEqual({
      path: workspace,
      source: "session",
    });
    expect(authorized.isBypassPermissionsModeAvailable).toBe(true);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(authorized)).toBe(true);
    expect(() => {
      (authorized.bypassPermissionsAcceptedIn as string[]).push(root);
    }).toThrow(TypeError);
    const exposed =
      authorized.additionalWorkingDirectories as unknown as Map<
        string,
        unknown
      >;
    expect(() => exposed.set(root, {})).toThrow(TypeError);
    expect(() => exposed.delete(workspace)).toThrow(TypeError);
    expect(() => exposed.clear()).toThrow(TypeError);
    expect(() =>
      Map.prototype.set.call(
        authorized.additionalWorkingDirectories,
        root,
        {},
      ),
    ).toThrow(TypeError);
  });

  it("persists the first consent when a fresh home has no state file", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "fresh-home"),
      HOME: root,
    });
    mkdirSync(workspace);

    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    expect(recordBypassPermissionsConsent(repository, workspace)).toBe(
      workspace,
    );
    expect(loadBypassPermissionsConsent(repository, workspace)).toEqual([
      workspace,
    ]);
    expect(JSON.parse(readFileSync(home.statePath, "utf8"))).toMatchObject({
      state_version: 1,
      state: {
        global: {
          permissions: {
            bypassPermissionsAcceptedByCwd: {
              [workspace]: persistedIdentity(workspace),
            },
          },
        },
      },
    });
    repository.close();
  });

  it("rejects retired consent state without rewriting it", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    mkdirSync(workspace);
    mkdirSync(home.path, { recursive: true });
    writeFileSync(
      home.statePath,
      `${JSON.stringify({
        state_version: 1,
        state: {
          global: {
            settings: {
              bypassPermissionsModeAcceptedIn: [workspace],
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    expect(() => loadBypassPermissionsConsent(repository, workspace)).toThrow(
      /unsupported or retired state.*settings/u,
    );
    expect(JSON.parse(readFileSync(home.statePath, "utf8"))).toMatchObject({
      state: {
        global: {
          settings: {
            bypassPermissionsModeAcceptedIn: [workspace],
          },
        },
      },
    });
    repository.close();
  });

  it("stores a symlink spelling under the exact canonical cwd key", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    mkdirSync(workspace);
    symlinkSync(workspace, alias, "dir");

    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    expect(recordBypassPermissionsConsent(repository, alias)).toBe(workspace);
    expect(loadBypassPermissionsConsent(repository, workspace)).toEqual([
      workspace,
    ]);
    expect(
      repository.getNamespace("permissions"),
    ).toEqual({
      bypassPermissionsAcceptedByCwd: {
        [workspace]: persistedIdentity(workspace),
      },
    });
    repository.close();
  });

  it("rejects consent after the canonical workspace is deleted and recreated", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    mkdirSync(workspace);
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    recordBypassPermissionsConsent(repository, workspace);
    const before = persistedIdentity(workspace);

    rmSync(workspace, { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      mkdirSync(join(root, `inode-spacer-${index}`));
    }
    mkdirSync(workspace);
    expect(persistedIdentity(workspace).ino).not.toBe(before.ino);
    expect(() =>
      loadBypassPermissionsConsent(repository, workspace, { reload: true })
    ).toThrow(/no longer matches.*workspace identity/u);
    repository.close();
  });

  it("does not transfer consent when a symlink spelling is retargeted", () => {
    const root = temporaryRoot();
    const first = join(root, "first-workspace");
    const second = join(root, "second-workspace");
    const alias = join(root, "workspace-alias");
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias, "dir");
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    recordBypassPermissionsConsent(repository, alias);

    rmSync(alias);
    symlinkSync(second, alias, "dir");
    expect(loadBypassPermissionsConsent(repository, alias, { reload: true }))
      .toEqual([]);
    expect(loadBypassPermissionsConsent(repository, first)).toEqual([first]);
    repository.close();
  });

  it("does not accept a retired symlink spelling as canonical consent", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    mkdirSync(workspace);
    symlinkSync(workspace, alias, "dir");
    mkdirSync(home.path, { recursive: true });
    writeFileSync(
      home.statePath,
      `${JSON.stringify({
        state_version: 1,
        state: {
          global: {
            settings: {
              bypassPermissionsModeAcceptedIn: [alias],
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    expect(() => loadBypassPermissionsConsent(repository, workspace)).toThrow(
      /unsupported or retired state.*settings/u,
    );
    repository.close();
  });
});
