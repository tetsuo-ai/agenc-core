import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { classifyPluginSource } from "../../src/plugins/resolution.js";

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
