import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __resetProjectTrustForTesting,
  isProjectTrustedSync,
  readTrustedProjects,
  resolveProjectTrustRootSync,
  trustProject,
  trustProjectSync,
  trustedProjectsPath,
} from "./project-trust.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "agenc-project-trust-"));
}

function deadPid(): number {
  return 2_147_483_647;
}

describe("project trust store", () => {
  let home = "";
  let repo = "";

  beforeEach(() => {
    home = mkTmp();
    repo = mkTmp();
    mkdirSync(join(repo, ".git"));
    __resetProjectTrustForTesting();
  });

  afterEach(() => {
    __resetProjectTrustForTesting();
    for (const dir of [home, repo]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing trust file means untrusted", async () => {
    expect(await readTrustedProjects({ agencHome: home })).toEqual({
      version: 1,
      trustedProjects: [],
    });
    expect(
      isProjectTrustedSync({
        agencHome: home,
        cwd: repo,
      }),
    ).toBe(false);
  });

  test("trust is keyed to the project root and covers descendants", async () => {
    const nested = join(repo, "src", "feature");
    mkdirSync(nested, { recursive: true });

    const accepted = await trustProject({
      agencHome: home,
      cwd: nested,
      now: () => new Date("2026-05-04T00:00:00.000Z"),
    });

    expect(accepted.projectRoot).toBe(resolveProjectTrustRootSync({ cwd: repo }));
    expect(
      isProjectTrustedSync({
        agencHome: home,
        cwd: nested,
      }),
    ).toBe(true);
    const file = JSON.parse(
      await readFile(trustedProjectsPath({ agencHome: home }), "utf8"),
    );
    expect(file.trustedProjects).toEqual([
      {
        path: resolveProjectTrustRootSync({ cwd: repo }),
        trustedAt: "2026-05-04T00:00:00.000Z",
      },
    ]);
  });

  test("trusting a child without a marker does not trust its parent", async () => {
    const parent = mkTmp();
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    try {
      await trustProject({ agencHome: home, cwd: child });
      expect(isProjectTrustedSync({ agencHome: home, cwd: child })).toBe(true);
      expect(isProjectTrustedSync({ agencHome: home, cwd: parent })).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("trusting a parent does not trust a nested project root", async () => {
    const parent = mkTmp();
    const childRepo = join(parent, "child-repo");
    mkdirSync(join(childRepo, ".git"), { recursive: true });
    try {
      await trustProject({ agencHome: home, projectRoot: parent });
      expect(isProjectTrustedSync({ agencHome: home, cwd: parent })).toBe(true);
      expect(isProjectTrustedSync({ agencHome: home, cwd: childRepo })).toBe(
        false,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("malformed trust file is replaced on accept", async () => {
    writeFileSync(trustedProjectsPath({ agencHome: home }), "{not json");
    await trustProject({ agencHome: home, cwd: repo });
    expect(
      (await readTrustedProjects({ agencHome: home })).trustedProjects,
    ).toHaveLength(1);
  });

  test("stale async trust locks from dead processes are recovered", async () => {
    const path = trustedProjectsPath({ agencHome: home });
    const lockPath = `${path}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid(),
        acquiredAt: "2026-05-04T00:00:00.000Z",
      }) + "\n",
    );

    await trustProject({ agencHome: home, cwd: repo });

    expect(existsSync(lockPath)).toBe(false);
    expect(isProjectTrustedSync({ agencHome: home, cwd: repo })).toBe(true);
  });

  test("stale sync trust locks from dead processes are recovered", () => {
    const path = trustedProjectsPath({ agencHome: home });
    const lockPath = `${path}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid(),
        acquiredAt: "2026-05-04T00:00:00.000Z",
      }) + "\n",
    );

    trustProjectSync({ agencHome: home, cwd: repo });

    expect(existsSync(lockPath)).toBe(false);
    expect(isProjectTrustedSync({ agencHome: home, cwd: repo })).toBe(true);
  });

  test("HOME workspace trust is persisted like any other project", async () => {
    const env = { HOME: repo } as NodeJS.ProcessEnv;
    const childRepo = join(repo, "child-repo");
    mkdirSync(join(childRepo, ".git"), { recursive: true });
    const result = await trustProject({
      agencHome: home,
      env,
      projectRoot: repo,
    });
    expect(result.persisted).toBe(true);
    expect(isProjectTrustedSync({ agencHome: home, env, projectRoot: repo })).toBe(
      true,
    );
    expect((await readTrustedProjects({ agencHome: home })).trustedProjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: resolveProjectTrustRootSync({ cwd: repo }),
        }),
      ]),
    );
    expect(isProjectTrustedSync({ agencHome: home, env, cwd: childRepo })).toBe(
      false,
    );
  });

  test("concurrent accepts preserve distinct trusted project roots", async () => {
    const repoA = mkTmp();
    const repoB = mkTmp();
    mkdirSync(join(repoA, ".git"));
    mkdirSync(join(repoB, ".git"));
    try {
      await Promise.all([
        trustProject({
          agencHome: home,
          cwd: repoA,
          now: () => new Date("2026-05-04T00:00:00.000Z"),
        }),
        trustProject({
          agencHome: home,
          cwd: repoB,
          now: () => new Date("2026-05-04T00:00:01.000Z"),
        }),
      ]);

      await expect(readTrustedProjects({ agencHome: home })).resolves.toEqual({
        version: 1,
        trustedProjects: [
          {
            path: resolveProjectTrustRootSync({ cwd: repoA }),
            trustedAt: "2026-05-04T00:00:00.000Z",
          },
          {
            path: resolveProjectTrustRootSync({ cwd: repoB }),
            trustedAt: "2026-05-04T00:00:01.000Z",
          },
        ].sort((a, b) => a.path.localeCompare(b.path)),
      });
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});
