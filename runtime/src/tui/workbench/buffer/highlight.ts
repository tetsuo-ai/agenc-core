import { basename, extname } from "node:path";

import type { BufferVisibleLine } from "./BufferStore.js";

type CodeToANSI = (code: string, lang: string, theme: string) => Promise<string>;

const BUFFER_SHIKI_THEME = "dark-plus";
const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ["bash", "bash"],
  ["c", "c"],
  ["cc", "cpp"],
  ["cjs", "js"],
  ["cpp", "cpp"],
  ["cs", "csharp"],
  ["css", "css"],
  ["cxx", "cpp"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["fish", "fish"],
  ["go", "go"],
  ["h", "c"],
  ["hpp", "cpp"],
  ["html", "html"],
  ["java", "java"],
  ["js", "js"],
  ["json", "json"],
  ["jsonc", "jsonc"],
  ["jsx", "jsx"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["less", "less"],
  ["lua", "lua"],
  ["md", "md"],
  ["mdx", "mdx"],
  ["mjs", "js"],
  ["nix", "nix"],
  ["php", "php"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["sass", "sass"],
  ["scala", "scala"],
  ["scss", "scss"],
  ["sh", "bash"],
  ["sol", "solidity"],
  ["sql", "sql"],
  ["swift", "swift"],
  ["toml", "toml"],
  ["ts", "ts"],
  ["tsx", "tsx"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["zsh", "bash"],
]);

const LANGUAGE_BY_BASENAME = new Map<string, string>([
  ["dockerfile", "docker"],
  ["gemfile", "ruby"],
  ["justfile", "just"],
  ["makefile", "make"],
  ["rakefile", "ruby"],
]);

let codeToANSIPromise: Promise<CodeToANSI | null> | undefined;

export async function highlightBufferVisibleLines(
  filePath: string | null,
  lines: readonly BufferVisibleLine[],
): Promise<ReadonlyMap<number, string>> {
  const language = filePath ? languageForPath(filePath) : null;
  if (!language || lines.length === 0) return new Map();

  const codeToANSI = await getCodeToANSI();
  if (!codeToANSI) return new Map();

  try {
    const code = lines.map((line) => line.text).join("\n");
    const highlighted = await codeToANSI(code, language, BUFFER_SHIKI_THEME);
    const highlightedLines = trimSingleTrailingLineBreak(highlighted).split("\n");
    return new Map(lines.map((line, index) => [line.number, highlightedLines[index] ?? line.text]));
  } catch {
    return new Map();
  }
}

function getCodeToANSI(): Promise<CodeToANSI | null> {
  codeToANSIPromise ??= import("@shikijs/cli")
    .then((module) => module.codeToANSI as CodeToANSI)
    .catch(() => null);
  return codeToANSIPromise;
}

function languageForPath(filePath: string): string | null {
  const base = basename(filePath).toLowerCase();
  const basenameLanguage = LANGUAGE_BY_BASENAME.get(base);
  if (basenameLanguage) return basenameLanguage;

  const extension = extname(filePath).slice(1).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(extension) ?? null;
}

function trimSingleTrailingLineBreak(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}
