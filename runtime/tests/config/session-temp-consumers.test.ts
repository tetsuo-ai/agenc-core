import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WorkflowHandoffSpool } from "../../src/agents/workflow-handoff-spool.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";
import { loadLocalSkillsSnapshot } from "../../src/skills/local-loader.js";
import { getCurrentBundledSkillExtractionRoot } from "../../src/skills/bundled-root-authority.js";
import { materializeRipgrepIgnoreFiles } from "../../src/tools/system/ripgrep-ignore-snapshot.js";
import { createPrivateTempFile } from "../../src/utils/tempfile.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("session temp consumers", () => {
  test(
    "isolates generated paths, ignore snapshots, and workflow spools across concurrent sessions",
    async () => {
      const rootA = mkdtempSync(join(tmpdir(), "agenc-consumer-temp-a-"));
      const rootB = mkdtempSync(join(tmpdir(), "agenc-consumer-temp-b-"));
      roots.push(rootA, rootB);

      const run = async (root: string) =>
        runWithAgentRuntimeOptions(
          resolveAgentRuntimeOptions({}, { sessionTempRoot: root }),
          async () => {
            await Promise.resolve();
            const generated = createPrivateTempFile({
              prefix: "agenc-session-owned",
              extension: ".tmp",
              content: "session owned",
            });
            const materialized = await materializeRipgrepIgnoreFiles([
              { sourceName: ".gitignore", content: Buffer.from("dist\n") },
            ]);
            const spool = WorkflowHandoffSpool.create({
              maximumBytes: 1_024,
              maximumTokens: 1_024,
            });
            try {
              return {
                generatedPath: generated.path,
                ignorePath: materialized.paths[0],
                liveEntries: readdirSync(root),
              };
            } finally {
              generated.dispose();
              await spool.dispose();
              await materialized.dispose();
            }
          },
        );

      const [a, b] = await Promise.all([run(rootA), run(rootB)]);

      expect(a.generatedPath.startsWith(`${rootA}${sep}`)).toBe(true);
      expect(a.ignorePath?.startsWith(`${rootA}${sep}`)).toBe(true);
      expect(a.liveEntries).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^agenc-rg-ignore-/u),
          expect.stringMatching(/^agenc-workflow-handoff-/u),
        ]),
      );
      expect(b.generatedPath.startsWith(`${rootB}${sep}`)).toBe(true);
      expect(b.ignorePath?.startsWith(`${rootB}${sep}`)).toBe(true);
      expect(b.liveEntries).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^agenc-rg-ignore-/u),
          expect.stringMatching(/^agenc-workflow-handoff-/u),
        ]),
      );
    },
  );

  test("keeps bundled-skill extraction under each captured temp authority", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "agenc-bundled-temp-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "agenc-bundled-temp-b-"));
    roots.push(rootA, rootB);

    const resolveBundledRoot = (root: string) =>
      runWithAgentRuntimeOptions(
        resolveAgentRuntimeOptions({}, { sessionTempRoot: root }),
        async () => {
          const canonicalRoot = getCurrentBundledSkillExtractionRoot();
          const snapshot = await loadLocalSkillsSnapshot({
            agencHome: join(root, "home"),
            workspaceRoot: join(root, "workspace"),
            pluginStorageRoot: join(root, "plugins"),
            env: {},
          });
          const bundled = snapshot.skills.find(
            (skill) => skill.name === "ledger-wallet-cli",
          );
          return { canonicalRoot, bundledRoot: bundled?.root };
        },
      );

    const [a, b] = await Promise.all([
      resolveBundledRoot(rootA),
      resolveBundledRoot(rootB),
    ]);

    expect(a.canonicalRoot.startsWith(`${rootA}${sep}`)).toBe(true);
    expect(b.canonicalRoot.startsWith(`${rootB}${sep}`)).toBe(true);
    expect(a.canonicalRoot).not.toBe(b.canonicalRoot);
    expect(a.bundledRoot).toBe(join(a.canonicalRoot, "ledger-wallet-cli"));
    expect(b.bundledRoot).toBe(join(b.canonicalRoot, "ledger-wallet-cli"));
  });
});
