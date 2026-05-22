import path from "node:path";

import type { GitStatusByPath } from "./gitStatus.js";
import type { ProjectTreeRow } from "../types.js";

type NodeKind = "root" | "directory" | "file";

type TreeNode = {
  readonly path: string;
  readonly label: string;
  readonly kind: NodeKind;
  readonly children: Map<string, TreeNode>;
};

export type BuildProjectTreeOptions = {
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly expandedPaths: ReadonlySet<string>;
  readonly cursorPath: string | null;
  readonly activePath: string | null;
  readonly attachedPaths?: ReadonlySet<string>;
  readonly searchHitPaths?: ReadonlySet<string>;
  readonly inFlightPaths?: ReadonlySet<string>;
  readonly gitStatus?: GitStatusByPath;
  readonly focused?: boolean;
};

export function buildProjectTreeRows(options: BuildProjectTreeOptions): ProjectTreeRow[] {
  const root = createNode("", path.basename(options.cwd) || "workspace", "root");
  for (const rawPath of options.paths) {
    addPath(root, normalizeRelativePath(rawPath));
  }

  const rows: ProjectTreeRow[] = [];
  const rootExpanded = true;
  rows.push(rowForNode(root, 0, rootExpanded, options));
  appendChildren(root, 1, rows, options);
  if (rows.length === 1 && options.paths.length === 0) {
    rows.push({
      id: "loading-empty",
      path: "",
      label: options.gitStatus ? "No project files" : "Loading files",
      kind: options.gitStatus ? "error" : "loading",
      depth: 1,
      expanded: false,
      selected: false,
      focused: false,
      active: false,
      attached: false,
      searchHit: false,
      inFlight: false,
    });
  }
  return rows;
}

export function visibleTreePaths(rows: readonly ProjectTreeRow[]): readonly string[] {
  return rows
    .filter((row) => row.kind === "file" || row.kind === "directory")
    .map((row) => row.path);
}

function appendChildren(
  node: TreeNode,
  depth: number,
  rows: ProjectTreeRow[],
  options: BuildProjectTreeOptions,
): void {
  const children = [...node.children.values()].sort(compareNodes);
  for (const child of children) {
    const expanded = child.kind === "directory" && options.expandedPaths.has(child.path);
    rows.push(rowForNode(child, depth, expanded, options));
    if (expanded || child.kind === "root") {
      appendChildren(child, depth + 1, rows, options);
    }
  }
}

function rowForNode(
  node: TreeNode,
  depth: number,
  expanded: boolean,
  options: BuildProjectTreeOptions,
): ProjectTreeRow {
  const selected = options.cursorPath === node.path;
  return {
    id: node.path || "root",
    path: node.path,
    label: node.label,
    kind: node.kind === "root" ? "root" : node.kind,
    depth,
    expanded,
    selected,
    focused: selected && options.focused === true,
    active: options.activePath === node.path,
    attached: options.attachedPaths?.has(node.path) ?? false,
    searchHit: options.searchHitPaths?.has(node.path) ?? false,
    inFlight: options.inFlightPaths?.has(node.path) ?? false,
    gitState: options.gitStatus?.get(node.path),
  };
}

function addPath(root: TreeNode, relPath: string): void {
  if (!relPath || relPath.startsWith("../")) return;
  const directoryPath = relPath.endsWith("/");
  const parts = relPath.split("/").filter(Boolean);
  let node = root;
  for (let index = 0; index < parts.length; index += 1) {
    const label = parts[index]!;
    const childPath = parts.slice(0, index + 1).join("/");
    const kind = index === parts.length - 1 && !directoryPath ? "file" : "directory";
    const existing = node.children.get(label);
    if (existing) {
      node = existing;
      continue;
    }
    const child = createNode(childPath, label, kind);
    node.children.set(label, child);
    node = child;
  }
}

function createNode(pathValue: string, label: string, kind: NodeKind): TreeNode {
  return {
    path: pathValue,
    label,
    kind,
    children: new Map(),
  };
}

function compareNodes(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) {
    if (left.kind === "directory") return -1;
    if (right.kind === "directory") return 1;
  }
  return left.label.localeCompare(right.label);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}
