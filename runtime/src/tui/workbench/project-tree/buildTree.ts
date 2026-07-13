import path from "node:path";

import { arrayToTree } from "performant-array-to-tree";

import type { GitStatusByPath } from "./gitStatus.js";
import type { ProjectTreeRow } from "../types.js";

type NodeKind = "root" | "directory" | "file";

type TreeNode = {
  readonly id: string;
  readonly parentId: string | null;
  readonly path: string;
  readonly label: string;
  readonly kind: NodeKind;
  readonly children: TreeNode[];
};

type TreeItem = Omit<TreeNode, "children"> & {
  children?: TreeItem[];
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

const ROOT_ID = "__agenc_workspace_root__";

// The expensive part of a tree build — createProjectTree (a full Map build via
// arrayToTree) + sortTree (O(N log N)) — depends only on (cwd, paths). The
// cursor, expand/collapse, active/attached/search/in-flight flags are applied
// cheaply in appendRows. ProjectTreeStore#emit rebuilt the whole tree on every
// keystroke (move/page/toggle) and twice on cursor normalization; memoize the
// sorted structure so pure selection changes reuse it.
//
// Keyed on the `paths` array by identity (the store reassigns #paths wholesale
// on a file-list change, and never mutates it in place, so a stable reference
// means an unchanged file list). A WeakMap bounds memory automatically — a
// replaced paths array is GC'd with its cached tree — and keeps sessions
// isolated since each session's paths array is a distinct key.
const sortedRootCache = new WeakMap<
  readonly string[],
  { readonly cwd: string; readonly root: TreeNode | null }
>();

/** Test-only: counts full structure (Map build + sort) rebuilds. */
let structureBuildCountForTest = 0;
export function getStructureBuildCountForTest(): number {
  return structureBuildCountForTest;
}
export function resetStructureBuildCountForTest(): void {
  structureBuildCountForTest = 0;
}

function getSortedProjectRoot(options: BuildProjectTreeOptions): TreeNode | null {
  const cached = sortedRootCache.get(options.paths);
  if (cached !== undefined && cached.cwd === options.cwd) {
    return cached.root;
  }
  structureBuildCountForTest += 1;
  const root = createProjectTree(options);
  if (root) sortTree(root);
  sortedRootCache.set(options.paths, { cwd: options.cwd, root });
  return root;
}

export function buildProjectTreeRows(options: BuildProjectTreeOptions): ProjectTreeRow[] {
  const root = getSortedProjectRoot(options);

  if (!root) return emptyRows(options);

  const rows: ProjectTreeRow[] = [];
  appendRows(root, 0, true, [], rows, options);
  if (rows.length === 1 && options.paths.length === 0) {
    rows.push(...emptyRows(options));
  }
  return rows;
}

function createProjectTree(options: BuildProjectTreeOptions): TreeNode | null {
  const items = new Map<string, Omit<TreeNode, "children">>();
  items.set(ROOT_ID, {
    id: ROOT_ID,
    parentId: null,
    path: "",
    label: path.basename(options.cwd) || "workspace",
    kind: "root",
  });

  for (const rawPath of options.paths) {
    addPathItems(items, normalizeRelativePath(rawPath));
  }

  const tree = arrayToTree([...items.values()], {
    dataField: null,
    throwIfOrphans: true,
  }) as TreeItem[];
  return normalizeTreeItem(tree.find((item) => item.id === ROOT_ID) ?? null);
}

function appendRows(
  node: TreeNode,
  depth: number,
  isLast: boolean,
  ancestorLast: readonly boolean[],
  rows: ProjectTreeRow[],
  options: BuildProjectTreeOptions,
): void {
  const expanded = node.kind === "root" || (node.kind === "directory" && options.expandedPaths.has(node.path));
  rows.push(rowForNode(node, depth, expanded, isLast, ancestorLast, options));

  if (!expanded) return;

  const nextAncestorLast = node.kind === "root" ? ancestorLast : [...ancestorLast, isLast];
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]!;
    appendRows(child, depth + 1, index === node.children.length - 1, nextAncestorLast, rows, options);
  }
}

function rowForNode(
  node: TreeNode,
  depth: number,
  expanded: boolean,
  isLast: boolean,
  ancestorLast: readonly boolean[],
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
    hasChildren: node.children.length > 0,
    isLast,
    ancestorLast,
    selected,
    focused: selected && options.focused === true,
    active: options.activePath === node.path,
    attached: options.attachedPaths?.has(node.path) ?? false,
    searchHit: options.searchHitPaths?.has(node.path) ?? false,
    inFlight: options.inFlightPaths?.has(node.path) ?? false,
    gitState: options.gitStatus?.get(node.path),
  };
}

function addPathItems(items: Map<string, Omit<TreeNode, "children">>, relPath: string): void {
  if (!relPath || relPath.startsWith("../")) return;
  const directoryPath = relPath.endsWith("/");
  const parts = relPath.split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const label = parts[index]!;
    const childPath = parts.slice(0, index + 1).join("/");
    const parentPath = index === 0 ? ROOT_ID : parts.slice(0, index).join("/");
    const kind = index === parts.length - 1 && !directoryPath ? "file" : "directory";
    const existing = items.get(childPath);
    if (existing) {
      if (existing.kind === "file" && kind === "directory") {
        items.set(childPath, { ...existing, kind: "directory" });
      }
      continue;
    }
    items.set(childPath, {
      id: childPath,
      parentId: parentPath,
      path: childPath,
      label,
      kind,
    });
  }
}

function normalizeTreeItem(item: TreeItem | null): TreeNode | null {
  if (!item) return null;
  return {
    id: item.id,
    parentId: item.parentId,
    path: item.path,
    label: item.label,
    kind: item.kind,
    children: (item.children ?? []).map((child) => normalizeTreeItem(child)).filter((child): child is TreeNode => Boolean(child)),
  };
}

function sortTree(node: TreeNode): void {
  node.children.sort(compareNodes);
  for (const child of node.children) sortTree(child);
}

function compareNodes(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) {
    if (left.kind === "directory") return -1;
    if (right.kind === "directory") return 1;
  }
  return left.label.localeCompare(right.label);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, "/").split(path.sep).join("/");
}

function emptyRows(options: BuildProjectTreeOptions): ProjectTreeRow[] {
  return [{
    id: "loading-empty",
    // An empty workspace on cold start is a NORMAL state, not a fault: use the
    // neutral "empty" kind so its marker is a space rather than the "!" the tree
    // reserves for genuine errors (which would make a fresh project look broken).
    // The label is kept short so it fits the narrow tree column (~17-22 cols,
    // truncate-end) without chopping mid-word — the inviting "describe a task to
    // get started" guidance already lives on the cold-start welcome card and the
    // composer placeholder, so nothing is lost by keeping the tree label terse.
    path: "",
    label: options.gitStatus ? "No files yet" : "Loading files",
    kind: options.gitStatus ? "empty" : "loading",
    depth: 1,
    expanded: false,
    hasChildren: false,
    isLast: true,
    ancestorLast: [],
    selected: false,
    focused: false,
    active: false,
    attached: false,
    searchHit: false,
    inFlight: false,
  }];
}
