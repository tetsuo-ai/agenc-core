import setWith from "lodash-es/setWith.js";
import * as React from "react";
import { Box, Text } from "../ink.js";

export type TreeNode = {
  [key: string]: TreeNode | string | undefined;
};

export type ValidationError = {
  readonly file?: string;
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly invalidValue?: unknown;
  readonly suggestion?: string;
  readonly docLink?: string;
};

type Props = {
  readonly errors: readonly ValidationError[];
};

function formatInvalidValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value) ?? '""';
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return String(value);
}

function readableErrorPathSegments(error: ValidationError): string[] {
  if (!error.path) return [""];
  if (error.invalidValue === null || error.invalidValue === undefined) {
    return error.path.split(".").filter(Boolean);
  }

  const pathParts = error.path.split(".");
  if (pathParts.length === 0) return [error.path];

  const nextParts: string[] = [];
  for (let index = 0; index < pathParts.length; index += 1) {
    const part = pathParts[index];
    if (!part) continue;
    const numericPart = Number.parseInt(part, 10);
    nextParts.push(
      !Number.isNaN(numericPart) && index === pathParts.length - 1
        ? formatInvalidValue(error.invalidValue)
        : part,
    );
  }
  return nextParts;
}

export function buildValidationErrorTree(
  errors: readonly ValidationError[],
): TreeNode {
  const tree: TreeNode = {};
  for (const error of errors) {
    setWith(tree, readableErrorPathSegments(error), error.message, Object);
  }
  return tree;
}

function renderValidationErrorTree(tree: TreeNode): string {
  const lines: string[] = [];

  function visit(node: TreeNode, depth: number): void {
    for (const [key, value] of Object.entries(node)) {
      const indent = "  ".repeat(depth);
      if (value && typeof value === "object") {
        lines.push(key.trim() ? `${indent}${key}:` : `${indent}:`);
        visit(value, depth + 1);
      } else if (key.trim()) {
        lines.push(`${indent}${key}: ${String(value)}`);
      } else {
        lines.push(`${indent}${String(value)}`);
      }
    }
  }

  visit(tree, 0);
  return lines.join("\n");
}

function byPath(a: ValidationError, b: ValidationError): number {
  if (!a.path && b.path) return -1;
  if (a.path && !b.path) return 1;
  return (a.path || "").localeCompare(b.path || "");
}

function groupByFile(
  errors: readonly ValidationError[],
): Record<string, ValidationError[]> {
  const grouped: Record<string, ValidationError[]> = {};
  for (const error of errors) {
    const file = error.file || "(file not specified)";
    grouped[file] ??= [];
    grouped[file]!.push(error);
  }
  return grouped;
}

function uniqueSuggestions(
  errors: readonly ValidationError[],
): Array<Pick<ValidationError, "suggestion" | "docLink">> {
  const pairs = new Map<string, Pick<ValidationError, "suggestion" | "docLink">>();
  for (const error of errors) {
    if (!error.suggestion && !error.docLink) continue;
    const key = `${error.suggestion ?? ""}|${error.docLink ?? ""}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        suggestion: error.suggestion,
        docLink: error.docLink,
      });
    }
  }
  return Array.from(pairs.values());
}

export function ValidationErrorsList({ errors }: Props): React.ReactNode {
  if (errors.length === 0) return null;

  const errorsByFile = groupByFile(errors);
  const sortedFiles = Object.keys(errorsByFile).sort();

  return (
    <Box flexDirection="column">
      {sortedFiles.map((file) => {
        const fileErrors = [...(errorsByFile[file] ?? [])].sort(byPath);
        const errorTree = buildValidationErrorTree(fileErrors);
        const suggestionPairs = uniqueSuggestions(fileErrors);
        const treeOutput = renderValidationErrorTree(errorTree);

        return (
          <Box key={file} flexDirection="column">
            <Text>{file}</Text>
            <Box marginLeft={1}>
              <Text dimColor={true}>{treeOutput}</Text>
            </Box>
            {suggestionPairs.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {suggestionPairs.map((pair, index) => (
                  <Box
                    key={`suggestion-pair-${index}`}
                    flexDirection="column"
                    marginBottom={1}
                  >
                    {pair.suggestion && (
                      <Text dimColor={true} wrap="wrap">
                        {pair.suggestion}
                      </Text>
                    )}
                    {pair.docLink && (
                      <Text dimColor={true} wrap="wrap">
                        Learn more: {pair.docLink}
                      </Text>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
