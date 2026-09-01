import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyPluginSource,
  pluginInstallSourceNeedsRedaction,
  pluginSourceNeedsRedaction,
  redactPluginInstallSource,
  redactPluginSource,
} from "../../src/plugins/resolution.js";

interface MarkdownFence {
  readonly language: string;
  readonly body: string;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const PLUGIN_REFERENCE = resolve(
  REPOSITORY_ROOT,
  "docs/reference/skills-plugins.md",
);

describe("plugin source documentation contract", () => {
  test("keeps local and npm examples in their matching shell fences", async () => {
    const markdown = await readFile(PLUGIN_REFERENCE, "utf8");
    const installSources = markdownSection(markdown, "Install sources");
    const fences = parseMarkdownFences(installSources);

    const bashSources = installSourcesFromFence(fences, "bash");
    const powershellSources = installSourcesFromFence(fences, "powershell");

    expect(bashSources).toEqual([
      "./my-plugin",
      "@scope/published-plugin",
    ]);
    expect(powershellSources).toEqual([
      String.raw`.\@scope\local-plugin`,
    ]);

    await expect(
      classifyPluginSource(bashSources[0]!, REPOSITORY_ROOT),
    ).resolves.toBe("local");
    await expect(
      classifyPluginSource(powershellSources[0]!, REPOSITORY_ROOT),
    ).resolves.toBe("local");
    await expect(
      classifyPluginSource(bashSources[1]!, REPOSITORY_ROOT),
    ).resolves.toBe("npm");
  });
  test("locks native archive fetch error-redaction examples", async () => {
    const section = markdownSection(
      await readFile(PLUGIN_REFERENCE, "utf8"),
      "Native archive fetch error redaction",
    );

    expect(section).toContain("redactPluginResolutionError");
    expect(section).toContain("ERR_INVALID_URL.input");
    expect(section).toContain("Unparseable");
    expect(section).not.toContain("sourceRedacted");
    expect(section).not.toContain("50 MiB");

    const parseable =
      "https://opaque-token@agenc.tech/plugins/private.tgz?access_token=secretvalue";
    const unparseable =
      "https://opaque-token@agenc.tech:notaport/plugins/private.tgz?access_token=secretvalue";
    const parseableRedacted =
      "https://redacted@agenc.tech/plugins/private.tgz?redacted=1";
    const unparseableRedacted =
      "https://redacted@agenc.tech:notaport/plugins/private.tgz?redacted=1";

    expect(section).toContain(parseable);
    expect(section).toContain(unparseable);
    expect(redactPluginSource(parseable)).toBe(parseableRedacted);
    expect(redactPluginSource(unparseable)).toBe(unparseableRedacted);
    expect(section).toContain(parseableRedacted);
    expect(section).toContain(unparseableRedacted);
  });

  test("records archive-fetch limits and query-string update replay", async () => {
    const markdown = await readFile(PLUGIN_REFERENCE, "utf8");
    const section = markdownSection(
      markdown,
      "Remote archive fetch and recorded sources",
    );
    const fences = parseMarkdownFences(section);
    const bashSources = installSourcesFromFence(fences, "bash");

    expect(section).toContain("plugin archive redirects must stay on");
    expect(section).toContain(
      "has no recorded source; rerun with --source <source>",
    );
    expect(section).toContain("sourceRedacted");
    expect(section).toContain("50 MiB");
    expect(section).toMatch(/at most 5 hops/u);
    expect(section).toContain("120 s");

    expect(bashSources).toEqual([
      "'https://github.com/acme/tool.mcpb?download=1'",
    ]);
    expect(section).toContain(
      "agenc plugin update tool --source 'https://github.com/acme/tool.mcpb?download=1'",
    );

    const queryUrl = "https://github.com/acme/tool.mcpb?download=1";
    const cleanUrl = "https://github.com/acme/tool.mcpb";
    await expect(
      classifyPluginSource(queryUrl, REPOSITORY_ROOT),
    ).resolves.toBe("mcpb");
    await expect(
      classifyPluginSource(cleanUrl, REPOSITORY_ROOT),
    ).resolves.toBe("mcpb");
    expect(pluginSourceNeedsRedaction(queryUrl)).toBe(true);
    expect(pluginSourceNeedsRedaction(cleanUrl)).toBe(false);
    expect(pluginSourceNeedsRedaction("https://EXAMPLE.com:443")).toBe(false);
    const sshUsernameUrl = "ssh://git@github.com/acme/tool.git";
    const sshPasswordUrl = "ssh://git:secret@github.com/acme/tool.git";
    const malformedSshUsernameUrl =
      "ssh://git@github.com:notaport/acme/tool.git";
    const malformedSshPasswordUrl =
      "ssh://git:secret@github.com:notaport/acme/tool.git";
    expect(pluginSourceNeedsRedaction(sshUsernameUrl)).toBe(false);
    expect(redactPluginSource(sshUsernameUrl)).toBe(sshUsernameUrl);
    expect(pluginSourceNeedsRedaction(malformedSshUsernameUrl)).toBe(false);
    expect(redactPluginSource(malformedSshUsernameUrl))
      .toBe(malformedSshUsernameUrl);
    expect(pluginInstallSourceNeedsRedaction({
      type: "git",
      url: sshUsernameUrl,
    })).toBe(false);
    expect(pluginInstallSourceNeedsRedaction({
      type: "git",
      url: sshPasswordUrl,
    })).toBe(true);
    expect(redactPluginInstallSource({
      type: "git",
      url: sshPasswordUrl,
    })).toEqual({
      type: "git",
      url: sshUsernameUrl,
    });
    expect(pluginSourceNeedsRedaction(malformedSshPasswordUrl)).toBe(true);
    expect(redactPluginSource(malformedSshPasswordUrl)).toBe(
      malformedSshUsernameUrl,
    );
    expect(
      pluginSourceNeedsRedaction("https://opaque-token@agenc.tech/plugin.tgz"),
    ).toBe(true);
    const secretPath =
      "https://agenc.tech/plugins/sk-proj-abcdefghijklmnopqrstuvwxyz123456/tool.tgz";
    const secretFragment =
      "https://agenc.tech/plugins/tool.tgz#sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const opaqueFragment =
      "https://agenc.tech/plugins/tool.tgz#opaque-credential-material";
    expect(pluginSourceNeedsRedaction(secretPath)).toBe(true);
    expect(pluginSourceNeedsRedaction(secretFragment)).toBe(true);
    expect(redactPluginSource(secretPath)).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(redactPluginSource(secretFragment)).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(redactPluginSource(opaqueFragment)).toBe(
      "https://agenc.tech/plugins/tool.tgz#redacted",
    );
  });

  test("locks the update-success redaction example against redactPluginInstallSource", async () => {
    const markdown = await readFile(PLUGIN_REFERENCE, "utf8");
    const section = markdownSection(markdown, "Update success source redaction");

    expect(section).toContain("updatePluginOp");
    expect(section).toContain("formatPluginUpdateSource");
    expect(section).toContain("redactPluginInstallSource");
    expect(section).not.toContain("sourceRedacted");
    expect(section).not.toContain("50 MiB");
    expect(section).not.toContain("redactPluginResolutionError");

    const rawSource = /--source '([^']+)'/u.exec(section)?.[1];
    const printedFence = parseMarkdownFences(section).find((fence) => {
      return fence.language === "text" && fence.body.includes("redacted@");
    });
    const printedSource = /from (https:\/\/redacted@[^:\s]+):/u
      .exec(printedFence?.body ?? "")?.[1];
    expect(rawSource).toBe(
      "https://opaque-token@agenc.tech/plugins/private.tgz?access_token=secretvalue",
    );
    expect(printedSource).toBe(
      "https://redacted@agenc.tech/plugins/private.tgz?redacted=1",
    );
    expect(redactPluginInstallSource(rawSource!)).toBe(printedSource);
    expect(printedSource).not.toContain("opaque-token");
    expect(printedSource).not.toContain("secretvalue");
  });
});

function markdownSection(markdown: string, title: string): string {
  const headings = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gmu)];
  const headingIndex = headings.findIndex((match) => match[2] === title);
  if (headingIndex < 0) throw new Error(`missing Markdown section: ${title}`);

  const heading = headings[headingIndex]!;
  const headingLevel = heading[1]!.length;
  const sectionStart = heading.index! + heading[0].length;
  const nextHeading = headings
    .slice(headingIndex + 1)
    .find((match) => match[1]!.length <= headingLevel);
  return markdown.slice(sectionStart, nextHeading?.index ?? markdown.length);
}

function parseMarkdownFences(markdown: string): readonly MarkdownFence[] {
  const fences: MarkdownFence[] = [];
  let open: {
    readonly marker: string;
    readonly language: string;
    readonly lines: string[];
  } | undefined;

  for (const line of markdown.split(/\r?\n/u)) {
    if (open === undefined) {
      const opening = /^(?<marker>`{3,}|~{3,})(?<language>[A-Za-z0-9_-]*)[ \t]*$/u
        .exec(line);
      if (opening?.groups === undefined) continue;
      open = {
        marker: opening.groups.marker!,
        language: opening.groups.language ?? "",
        lines: [],
      };
      continue;
    }

    const closing = new RegExp(
      `^${open.marker[0]}{${open.marker.length},}[ \\t]*$`,
      "u",
    );
    if (closing.test(line)) {
      fences.push({
        language: open.language,
        body: open.lines.join("\n"),
      });
      open = undefined;
      continue;
    }
    open.lines.push(line);
  }

  if (open !== undefined) throw new Error("unclosed Markdown code fence");
  return fences;
}

function installSourcesFromFence(
  fences: readonly MarkdownFence[],
  language: string,
): readonly string[] {
  return fences
    .filter((fence) => fence.language === language)
    .flatMap((fence) => fence.body.split("\n"))
    .flatMap((line) => {
      const command = /^agenc plugin install ([^\s]+)[ \t]*$/u.exec(line);
      return command === null ? [] : [command[1]!];
    });
}
