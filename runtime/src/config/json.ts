import {
  getNodePath,
  parseTree,
  type Node as JsonSyntaxNode,
} from "jsonc-parser/lib/esm/main.js";

export type JsonRecord = Record<string, unknown>;

/** Return duplicate object-key locations without parsing or exposing values. */
export function duplicateJsonObjectPaths(text: string): readonly string[] {
  const root = parseTree(text, [], {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (root === undefined) return [];
  const duplicates: string[] = [];
  const visit = (node: JsonSyntaxNode): void => {
    if (node.type === "object") {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        if (property.type !== "property") continue;
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        const key = typeof keyNode?.value === "string"
          ? keyNode.value
          : undefined;
        if (key !== undefined) {
          const path = [...getNodePath(node), key]
            .map((segment) => typeof segment === "number"
              ? `[${segment}]`
              : segment)
            .join(".") || "<root>";
          if (seen.has(key)) duplicates.push(path);
          else seen.add(key);
        }
        if (valueNode !== undefined) visit(valueNode);
      }
      return;
    }
    if (node.type === "array") {
      for (const child of node.children ?? []) visit(child);
    }
  };
  visit(root);
  return Object.freeze(duplicates);
}

export function isPlainRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    );
  }
  return value;
}

export function cloneRecord(
  value: Readonly<Record<string, unknown>>,
): JsonRecord {
  return cloneJsonValue(value) as JsonRecord;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}
