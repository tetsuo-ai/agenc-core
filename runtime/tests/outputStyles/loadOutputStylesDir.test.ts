import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { ConfigStore } from "../../src/config/store.js";
import { getOutputStyleDirStyles } from "../../src/outputStyles/loadOutputStylesDir.js";
import {
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from "../../src/utils/settings/canonicalAuthority.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  resetCanonicalSettingsAuthorityForTesting();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("getOutputStyleDirStyles", () => {
  test("does not reuse custom styles across canonical homes for one cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-output-style-home-"));
    temporaryRoots.push(root);
    const cwd = join(root, "workspace");
    const homeA = join(root, "home-a");
    const homeB = join(root, "home-b");
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      writeStyle(homeA, "Prompt from home A"),
      writeStyle(homeB, "Prompt from home B"),
    ]);
    const authorityA = configStore(homeA, cwd);
    const authorityB = configStore(homeB, cwd);

    const stylesA = await runWithCanonicalSettingsAuthority(authorityA, () =>
      getOutputStyleDirStyles(cwd),
    );
    const stylesB = await runWithCanonicalSettingsAuthority(authorityB, () =>
      getOutputStyleDirStyles(cwd),
    );

    expect(stylesA.find((style) => style.name === "home-specific")?.prompt).toBe(
      "Prompt from home A",
    );
    expect(stylesB.find((style) => style.name === "home-specific")?.prompt).toBe(
      "Prompt from home B",
    );
  });
});

function configStore(home: string, cwd: string): ConfigStore {
  return new ConfigStore({
    home,
    cwd,
    projectRoot: cwd,
    projectTrusted: false,
    env: { AGENC_HOME: home, HOME: home },
  });
}

async function writeStyle(home: string, prompt: string): Promise<void> {
  const directory = join(home, "output-styles");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "home-specific.md"),
    `---\nname: home-specific\ndescription: Home-specific style\n---\n${prompt}\n`,
  );
}
