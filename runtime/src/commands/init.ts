/**
 * `/init` — create `<cwd>/AGENC.md` from the AgenC init template.
 *
 * Mirrors codex runtime TUI `/init` behaviour with AgenC naming: writes a
 * contributor-guide scaffold to `AGENC.md` at the current project root. If the file
 * already exists we skip to avoid overwriting user content.
 *
 * Template source resolution order:
 *   1. If `AGENC_INIT_TEMPLATE_PATH` env is set and readable, use it.
 *      (lets operators ship a customized template).
 *   2. Otherwise the inline default below.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/**
 * AgenC-neutralized contributor-guide scaffold. Kept inline so the
 * command works regardless of deployment layout. Matches the structure
 * of codex runtime's `prompt_for_init_command.md` (contributor guide outline)
 * but strips runtime-specific phrasing.
 */
export const INIT_TARGET_FILENAME = "AGENC.md";

export const INIT_TEMPLATE = `Generate a file named AGENC.md that serves as a contributor guide for this repository.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project's Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.
`;

/** Resolve the template body. See module doc for ordering. */
export function resolveInitTemplate(): string {
  const overridePaths = [
    process.env.AGENC_INIT_TEMPLATE_PATH,
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
  for (const override of overridePaths) {
    try {
      return readFileSync(override, "utf8");
    } catch {
      /* fall through */
    }
  }
  return INIT_TEMPLATE;
}

export const initCommand: SlashCommand = {
  name: "init",
  description: "Scaffold an AGENC.md contributor guide in the current directory",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const target = join(ctx.cwd, INIT_TARGET_FILENAME);
      if (existsSync(target)) {
        return {
          kind: "text",
          text: "AGENC.md already exists — skipping /init to avoid overwriting.",
        };
      }
      const body = resolveInitTemplate();
      await writeFile(target, body, "utf8");
      return { kind: "text", text: `Created ${target}` };
    }),
};

export default initCommand;
