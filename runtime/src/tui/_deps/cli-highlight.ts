/**
 * AgenC adapter for AgenC's `utils/cliHighlight.ts`.
 *
 * The TUI uses `getCliHighlightPromise` to optionally light up code blocks
 * in markdown rendering. Returning `null` means the markdown pipeline falls
 * back to plain text, matching the upstream optional-dependency contract.
 */

import { extname } from "node:path";

export type CliHighlight = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  highlight: (code: string, opts?: any) => string;
  supportsLanguage: (language: string) => boolean;
};

let cliHighlightPromise: Promise<CliHighlight | null> | undefined;
let loadedGetLanguage:
  | ((languageName: string) => { readonly name?: string } | undefined)
  | undefined;

async function loadCliHighlight(): Promise<CliHighlight | null> {
  const previousForceColor = process.env.FORCE_COLOR;
  if (previousForceColor === undefined || previousForceColor.length === 0) {
    process.env.FORCE_COLOR = "1";
  }
  try {
    // Dynamic import keeps cli-highlight optional at runtime; if it isn't
    // installed, we silently fall back to plain rendering.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("cli-highlight").catch(() => null);
    if (!mod) return null;
    const highlightJs = (await import("highlight.js").catch(() => null)) as
      | { readonly getLanguage?: typeof loadedGetLanguage }
      | null;
    loadedGetLanguage = highlightJs?.getLanguage;
    return {
      highlight: mod.highlight,
      supportsLanguage: mod.supportsLanguage,
    };
  } catch {
    return null;
  } finally {
    if (previousForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = previousForceColor;
    }
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight();
  return cliHighlightPromise;
}

export async function getLanguageName(filePath: string): Promise<string> {
  await getCliHighlightPromise();
  const ext = extname(filePath).slice(1);
  if (ext.length === 0) return "unknown";
  return loadedGetLanguage?.(ext)?.name ?? "unknown";
}
