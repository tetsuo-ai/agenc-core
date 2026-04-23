import {
  buildMarkdownDisplayLines,
  buildStreamingMarkdownDisplayLines,
  createMarkdownStreamCollector,
  type BuildMarkdownOptions,
} from "../_deps/markdown.js";
import {
  renderHighlightedCodeLines,
  type HighlightedCodeLine,
} from "./code-highlight.js";

export interface MarkdownDisplayLine {
  readonly text: string;
  readonly plainText: string;
  readonly mode: string;
  readonly language?: string;
  readonly [key: string]: unknown;
}

export interface MarkdownRenderOptions {
  readonly cwd?: string;
  readonly maxPathChars?: number;
  readonly width?: number;
  readonly highlightCode?: boolean;
}

export interface MarkdownDisplayLineStream {
  clear(): void;
  pushDelta(delta: string): void;
  syncToValue(value: string): void;
  commitCompleteLines(): MarkdownDisplayLine[];
  previewPendingLines(): MarkdownDisplayLine[];
  snapshot(): MarkdownDisplayLine[];
  finalizeAndDrain(): MarkdownDisplayLine[];
}

function normalizeDisplayLine(line: unknown): MarkdownDisplayLine {
  const candidate = (line ?? {}) as Record<string, unknown>;
  return {
    ...candidate,
    text: String(candidate.text ?? ""),
    plainText: String(candidate.plainText ?? candidate.text ?? ""),
    mode: String(candidate.mode ?? "plain"),
    language:
      typeof candidate.language === "string" && candidate.language.length > 0
        ? candidate.language
        : undefined,
  };
}

function pushHighlightedBlock(
  output: MarkdownDisplayLine[],
  language: string | undefined,
  rendered: readonly HighlightedCodeLine[] | null,
  original: readonly MarkdownDisplayLine[],
): void {
  if (rendered === null) {
    output.push(...original);
    return;
  }
  for (const line of rendered) {
    output.push({
      text: line.text,
      plainText: line.plainText,
      mode: "code",
      ...(language !== undefined ? { language } : {}),
    });
  }
}

async function maybeHighlightCodeBlocks(
  lines: readonly MarkdownDisplayLine[],
  options: MarkdownRenderOptions,
): Promise<MarkdownDisplayLine[]> {
  if (options.highlightCode === false) {
    return [...lines];
  }

  const output: MarkdownDisplayLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.mode === "code-meta") {
      output.push(line);
      const block: MarkdownDisplayLine[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && lines[cursor]?.mode === "code") {
        block.push(lines[cursor]!);
        cursor += 1;
      }
      if (block.length > 0) {
        const rendered = await renderHighlightedCodeLines({
          code: block.map((entry) => entry.plainText).join("\n"),
          language: line.language ?? block[0]?.language,
          width: options.width,
        });
        pushHighlightedBlock(output, line.language ?? block[0]?.language, rendered, block);
        index = cursor - 1;
      }
      continue;
    }

    if (line.mode === "code") {
      const block: MarkdownDisplayLine[] = [line];
      let cursor = index + 1;
      while (cursor < lines.length && lines[cursor]?.mode === "code") {
        block.push(lines[cursor]!);
        cursor += 1;
      }
      const rendered = await renderHighlightedCodeLines({
        code: block.map((entry) => entry.plainText).join("\n"),
        language: line.language,
        width: options.width,
      });
      pushHighlightedBlock(output, line.language, rendered, block);
      index = cursor - 1;
      continue;
    }

    output.push(line);
  }

  return output;
}

function normalizeLines(lines: readonly unknown[]): MarkdownDisplayLine[] {
  return lines.map(normalizeDisplayLine);
}

function toBuildOptions(options: MarkdownRenderOptions): BuildMarkdownOptions {
  return {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.maxPathChars !== undefined
      ? { maxPathChars: options.maxPathChars }
      : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
  };
}

export function createMarkdownDisplayLineStream(
  options: MarkdownRenderOptions = {},
): MarkdownDisplayLineStream {
  const collector = createMarkdownStreamCollector(toBuildOptions(options));
  return {
    clear() {
      collector.clear();
    },
    pushDelta(delta: string) {
      collector.pushDelta(delta);
    },
    syncToValue(value: string) {
      collector.syncToValue(value);
    },
    commitCompleteLines() {
      return normalizeLines(collector.commitCompleteLines());
    },
    previewPendingLines() {
      return normalizeLines(collector.previewPendingLines());
    },
    snapshot() {
      return normalizeLines(collector.snapshot());
    },
    finalizeAndDrain() {
      return normalizeLines(collector.finalizeAndDrain());
    },
  };
}

export function renderMarkdownDisplayLinesSync(
  value: string,
  options: MarkdownRenderOptions = {},
): MarkdownDisplayLine[] {
  return normalizeLines(
    buildMarkdownDisplayLines(value, toBuildOptions(options)),
  );
}

export async function renderMarkdownDisplayLines(
  value: string,
  options: MarkdownRenderOptions = {},
): Promise<MarkdownDisplayLine[]> {
  const base = renderMarkdownDisplayLinesSync(value, options);
  return maybeHighlightCodeBlocks(base, options);
}

export function renderStreamingMarkdownDisplayLinesSync(
  value: string,
  options: MarkdownRenderOptions = {},
): MarkdownDisplayLine[] {
  return normalizeLines(
    buildStreamingMarkdownDisplayLines(value, toBuildOptions(options)),
  );
}

export async function renderStreamingMarkdownDisplayLines(
  value: string,
  options: MarkdownRenderOptions = {},
): Promise<MarkdownDisplayLine[]> {
  const base = renderStreamingMarkdownDisplayLinesSync(value, options);
  return maybeHighlightCodeBlocks(base, options);
}

export async function renderMarkdownText(
  value: string,
  options: MarkdownRenderOptions = {},
): Promise<string> {
  const rendered = await renderMarkdownDisplayLines(value, options);
  return rendered.map((line) => line.text).join("\n");
}
