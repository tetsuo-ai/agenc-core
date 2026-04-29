import { marked, type Token, type Tokens } from "marked";
import React, {
  startTransition,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MarkdownTable } from "../design-system/MarkdownTable.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import type { MarkdownDisplayLine } from "../render/markdown.js";
import {
  renderMarkdownDisplayLines,
  renderMarkdownDisplayLinesSync,
} from "../render/markdown.js";
import { DisplayLineBlock } from "./DisplayLineBlock.js";

export interface MarkdownBlockProps {
  readonly content: string;
  readonly isComplete?: boolean;
  readonly syntaxHighlightingDisabled?: boolean;
}

const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map<string, Token[]>();
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

function hashContent(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function hasMarkdownSyntax(value: string): boolean {
  return MD_SYNTAX_RE.test(value.length > 500 ? value.slice(0, 500) : value);
}

export function lexMarkdownTokensForParity(content: string): Token[] {
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: "paragraph",
        raw: content,
        text: content,
        tokens: [{ type: "text", raw: content, text: content }],
      } as Token,
    ];
  }

  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) {
    tokenCache.delete(key);
    tokenCache.set(key, hit);
    return hit;
  }

  const tokens = marked.lexer(content);
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value;
    if (first !== undefined) tokenCache.delete(first);
  }
  tokenCache.set(key, tokens);
  return tokens;
}

export function markdownTokenCacheSizeForParity(): number {
  return tokenCache.size;
}

function lineEquals(left: MarkdownDisplayLine, right: MarkdownDisplayLine): boolean {
  return (
    left.mode === right.mode &&
    left.text === right.text &&
    left.plainText === right.plainText &&
    left.language === right.language
  );
}

function linesEqual(
  left: readonly MarkdownDisplayLine[],
  right: readonly MarkdownDisplayLine[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftLine = left[index];
    const rightLine = right[index];
    if (!leftLine || !rightLine || !lineEquals(leftLine, rightLine)) {
      return false;
    }
  }
  return true;
}

function tableTokenToAgenC(token: Tokens.Table) {
  return {
    header: token.header.map((cell) => ({
      text: cell.text,
    })),
    align: token.align,
    rows: token.rows.map((row) =>
      row.map((cell) => ({
        text: cell.text,
      })),
    ),
  };
}

function tokenRaw(token: Token): string {
  return typeof token.raw === "string" ? token.raw : "";
}

function MarkdownTokenBody({
  content,
  width,
  highlightCode,
}: {
  readonly content: string;
  readonly width: number;
  readonly highlightCode: boolean;
}): React.ReactElement {
  const tokens = useMemo(() => lexMarkdownTokensForParity(content), [content]);
  const elements: React.ReactNode[] = [];
  let pending = "";
  const flushPending = (): void => {
    if (!pending.trim()) {
      pending = "";
      return;
    }
    elements.push(
      <DisplayLineBlock
        key={`block-${elements.length}`}
        lines={renderMarkdownDisplayLinesSync(pending.trim(), {
          width,
          highlightCode,
        })}
      />,
    );
    pending = "";
  };

  for (const token of tokens) {
    if (token.type === "table") {
      flushPending();
      elements.push(
        <MarkdownTable
          key={`table-${elements.length}`}
          token={tableTokenToAgenC(token as Tokens.Table)}
          forceWidth={width}
        />,
      );
      continue;
    }
    pending += tokenRaw(token);
  }
  flushPending();

  return <>{elements}</>;
}

export function StreamingMarkdown({
  children,
  width,
  syntaxHighlightingDisabled = false,
}: {
  readonly children: string;
  readonly width: number;
  readonly syntaxHighlightingDisabled?: boolean;
}): React.ReactElement {
  const stablePrefixRef = useRef("");
  if (!children.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = "";
  }

  const boundary = stablePrefixRef.current.length;
  const tokens = marked.lexer(children.substring(boundary));
  let lastContentIndex = tokens.length - 1;
  while (lastContentIndex >= 0 && tokens[lastContentIndex]?.type === "space") {
    lastContentIndex -= 1;
  }

  let advance = 0;
  for (let index = 0; index < lastContentIndex; index += 1) {
    advance += tokens[index]?.raw.length ?? 0;
  }
  if (advance > 0) {
    stablePrefixRef.current = children.substring(0, boundary + advance);
  }

  const stablePrefix = stablePrefixRef.current;
  const unstableSuffix = children.substring(stablePrefix.length);
  return (
    <>
      {stablePrefix ? (
        <MarkdownTokenBody
          content={stablePrefix}
          width={width}
          highlightCode={!syntaxHighlightingDisabled}
        />
      ) : null}
      {unstableSuffix ? (
        <MarkdownTokenBody
          content={unstableSuffix}
          width={width}
          highlightCode={!syntaxHighlightingDisabled}
        />
      ) : null}
    </>
  );
}

export const MarkdownBlock: React.FC<MarkdownBlockProps> = ({
  content,
  isComplete = false,
  syntaxHighlightingDisabled = false,
}) => {
  const terminalSize = useContext(TerminalSizeContext);
  const width = Math.max(24, (terminalSize?.columns ?? 80) - 4);
  const [lines, setLines] = useState<readonly MarkdownDisplayLine[]>(() =>
    isComplete
      ? renderMarkdownDisplayLinesSync(content, {
          width,
          highlightCode: !syntaxHighlightingDisabled,
        })
      : [],
  );

  useEffect(() => {
    if (!isComplete) return;
    setLines(
      renderMarkdownDisplayLinesSync(content, {
        width,
        highlightCode: !syntaxHighlightingDisabled,
      }),
    );
  }, [content, isComplete, syntaxHighlightingDisabled, width]);

  useEffect(() => {
    if (!isComplete) return undefined;
    let cancelled = false;
    const render = async (): Promise<void> => {
      const next = await renderMarkdownDisplayLines(content, {
        width,
        highlightCode: !syntaxHighlightingDisabled,
      });
      if (!cancelled) {
        startTransition(() => {
          setLines((current) => (linesEqual(current, next) ? current : next));
        });
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [content, isComplete, syntaxHighlightingDisabled, width]);

  if (!isComplete) {
    return (
      <StreamingMarkdown
        width={width}
        syntaxHighlightingDisabled={syntaxHighlightingDisabled}
      >
        {content}
      </StreamingMarkdown>
    );
  }

  const hasTable = lexMarkdownTokensForParity(content).some(
    (token) => token.type === "table",
  );
  if (hasTable) {
    return (
      <MarkdownTokenBody
        content={content}
        width={width}
        highlightCode={!syntaxHighlightingDisabled}
      />
    );
  }

  return <DisplayLineBlock lines={lines} />;
};

export default MarkdownBlock;
