import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  findModifiedFiles,
  getEnvironmentKind,
} from "../../src/utils/filePersistence/outputsScanner.js"

const tempDirs: string[] = []
const originalEnvironmentKind = process.env.AGENC_ENVIRONMENT_KIND

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenc-outputs-scanner-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  if (originalEnvironmentKind === undefined) {
    delete process.env.AGENC_ENVIRONMENT_KIND
  } else {
    process.env.AGENC_ENVIRONMENT_KIND = originalEnvironmentKind
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe("getEnvironmentKind", () => {
  test("accepts only recognized environment kinds", () => {
    process.env.AGENC_ENVIRONMENT_KIND = "byoc"
    expect(getEnvironmentKind()).toBe("byoc")

    process.env.AGENC_ENVIRONMENT_KIND = "agenc_cloud"
    expect(getEnvironmentKind()).toBe("agenc_cloud")

    process.env.AGENC_ENVIRONMENT_KIND = "local"
    expect(getEnvironmentKind()).toBeNull()
  })
})

describe("findModifiedFiles", () => {
  test("returns nested regular files modified since the turn started", async () => {
    const root = await makeTempDir()
    const nestedDir = join(root, "nested", "deeper")
    const staleFile = join(root, "stale.txt")
    const rootFreshFile = join(root, "fresh.txt")
    const nestedFreshFile = join(nestedDir, "fresh-nested.txt")

    await mkdir(nestedDir, { recursive: true })
    await writeFile(staleFile, "old")
    await writeFile(rootFreshFile, "new")
    await writeFile(nestedFreshFile, "nested")

    const turnStartTime = Date.now() - 5_000
    const staleDate = new Date(turnStartTime - 10_000)
    await utimes(staleFile, staleDate, staleDate)

    const modified = await findModifiedFiles(turnStartTime, root)

    expect(modified.map((file) => relative(root, file)).sort()).toEqual([
      "fresh.txt",
      join("nested", "deeper", "fresh-nested.txt"),
    ])
  })

  test("skips symlinks and tolerates missing output directories", async () => {
    const root = await makeTempDir()
    const target = join(root, "target.txt")
    const link = join(root, "link.txt")

    await writeFile(target, "target")
    await symlink(target, link)

    const modified = await findModifiedFiles(Date.now() - 5_000, root)

    expect(modified.map((file) => relative(root, file))).toEqual(["target.txt"])
    await expect(
      findModifiedFiles(Date.now(), join(root, "missing")),
    ).resolves.toEqual([])
  })
})
