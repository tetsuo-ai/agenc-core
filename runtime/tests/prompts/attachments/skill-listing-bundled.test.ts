/**
 * Bundled skills registered through `registerBundledSkill` live outside the
 * local loader. The Skill tool can load them, so the listing the model sees
 * must name them too, with a local skill of the same name taking precedence.
 */
import { describe, expect, test } from "vitest";

// Bundled skills with `files` resolve their extraction directory
// (MACRO.VERSION) at registration, i.e. at module load of bundledSkills.ts.
// Stub before the producer's dynamic import runs.
(globalThis as Record<string, unknown>).MACRO = {
  VERSION: "99.0.0",
  DISPLAY_VERSION: "0.0.0-test",
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER:
    "report the issue at https://github.com/tetsuo-ai/agenc-core/issues",
  PACKAGE_URL: "@tetsuo-ai/agenc",
  NATIVE_PACKAGE_URL: undefined,
};

import { normalizeSessionToolPolicy } from "../../permissions/session-tool-policy.js";
import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { skillListingProducer } from "./skill-listing.js";

function makeOpts(
  availableSkills: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly loadedFrom?: string;
  }>,
  extra: Partial<GetAttachmentsOptions> = {},
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-skill-listing-bundled-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    agencHome: "/tmp/agenc-skill-listing-bundled-home",
    skillsManager: {
      skillsForConfig: async () => ({ invokedSkills: [], availableSkills }),
    },
    ...extra,
  };
}

async function listingFor(opts: GetAttachmentsOptions): Promise<string> {
  const out = await skillListingProducer(
    opts,
    getAttachmentTrackingState(opts.sessionKey),
  );
  expect(out).toHaveLength(1);
  const attachment = out[0] as { readonly content: string };
  return attachment.content;
}

describe("skillListingProducer with runtime-registered bundled skills", () => {
  test("lists the bundled registry skills next to the loader's skills", async () => {
    const listing = await listingFor(
      makeOpts([
        { name: "repo-docs", description: "Explain the repository docs", loadedFrom: "skills" },
      ]),
    );

    expect(listing).toContain("- repo-docs: Explain the repository docs");
    expect(listing).toMatch(/^- browser-automation: How to drive the Browser tool/mu);
  });

  test("keeps the kit installer out of the default listing", async () => {
    const listing = await listingFor(
      makeOpts([{ name: "repo-docs", description: "Explain the repository docs", loadedFrom: "skills" }]),
    );

    expect(listing).not.toContain("agenc-marketplace-kit-installer");
  });

  test("lists the kit installer once the operator enabled the marketplace", async () => {
    const listing = await listingFor(
      makeOpts([], { config: { protocol: { enabled: true, adapter: "marketplace-cli" } } }),
    );

    expect(listing).toMatch(/^- agenc-marketplace-kit-installer: /mu);
  });

  test("does not list the installer when the marketplace is explicitly off", async () => {
    const listing = await listingFor(makeOpts([], { config: { protocol: { enabled: false } } }));

    expect(listing).not.toContain("agenc-marketplace-kit-installer");
  });

  describe("in a session with a toolPolicy", () => {
    const names = (listing: string): string[] =>
      [...listing.matchAll(/^- ([^:\s]+):/gmu)].map((match) => match[1]!);

    test("names only the bundled skills the policy enables", async () => {
      const listing = await listingFor(
        makeOpts([{ name: "repo-docs", description: "Explain the docs", loadedFrom: "skills" }], {
          toolPolicy: normalizeSessionToolPolicy({
            enabledTools: ["Skill", "Skill:browser-automation"],
          }),
        }),
      );

      expect(names(listing)).toEqual(expect.arrayContaining(["browser-automation", "repo-docs"]));
      expect(listing).not.toContain("agenc-marketplace-kit-installer");
    });

    test("names no bundled skill when the policy enables none", async () => {
      const listing = await listingFor(
        makeOpts([{ name: "repo-docs", description: "Explain the docs", loadedFrom: "skills" }], {
          toolPolicy: normalizeSessionToolPolicy({ enabledTools: ["Skill"] }),
        }),
      );

      expect(names(listing)).toEqual(["repo-docs"]);
    });

    test("never names the kit installer, even with the marketplace enabled", async () => {
      const listing = await listingFor(
        makeOpts([], {
          toolPolicy: normalizeSessionToolPolicy({ enabledTools: ["Skill", "Skill:browser-automation"] }),
          config: { protocol: { enabled: true, adapter: "marketplace-cli" } },
        }),
      );

      expect(listing).not.toContain("agenc-marketplace-kit-installer");
    });

    test("emits no listing at all when the policy leaves out the Skill tool", async () => {
      const opts = makeOpts([{ name: "repo-docs", loadedFrom: "skills" }], {
        toolPolicy: normalizeSessionToolPolicy({ enabledTools: ["FileRead"] }),
      });

      const out = await skillListingProducer(opts, getAttachmentTrackingState(opts.sessionKey));

      expect(out).toEqual([]);
    });
  });

  test("lets a loader skill shadow a bundled skill with the same name", async () => {
    const listing = await listingFor(
      makeOpts([
        { name: "browser-automation", description: "Project-owned browser notes", loadedFrom: "skills" },
      ]),
    );

    expect(listing.match(/^- browser-automation: /gmu)).toHaveLength(1);
    expect(listing).toContain("- browser-automation: Project-owned browser notes");
  });
});
