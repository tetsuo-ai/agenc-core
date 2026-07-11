/**
 * Accessibility-tree snapshot → deterministic, ref-annotated text.
 *
 * The model never sees CSS selectors. It sees an indented outline of the
 * accessibility tree where every actionable node is tagged `[ref=eN]`; actions
 * (`click`, `type`, …) address elements by that ref. Refs are stable across
 * re-snapshots of the same document: a {@link RefRegistry} maps each Chromium
 * `backendDOMNodeId` to a ref string and reuses it, so re-snapshotting an
 * unchanged page yields identical refs (the acceptance criterion for TODO 18).
 *
 * @module
 */

/** Subset of the CDP `Accessibility.AXNode` shape we consume. */
export interface AXValue {
  readonly value?: unknown;
}

export interface AXNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AXValue;
  readonly name?: AXValue;
  readonly value?: AXValue;
  readonly backendDOMNodeId?: number;
  readonly childIds?: readonly string[];
}

/**
 * Roles that get a `[ref=…]` tag because the model can act on them. Structural
 * roles (RootWebArea, generic, group…) are shown for context but not tagged.
 */
const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "spinbutton",
  "textarea",
  "MenuItem",
  "SpinButton",
]);

/**
 * Persistent `backendDOMNodeId → ref` map for one document. Reset on
 * navigation so a new page gets fresh refs, kept across re-snapshots so an
 * element's ref is stable.
 */
export class RefRegistry {
  #counter = 0;
  readonly #byBackendId = new Map<number, string>();

  refFor(backendId: number): string {
    const existing = this.#byBackendId.get(backendId);
    if (existing !== undefined) return existing;
    const ref = `e${++this.#counter}`;
    this.#byBackendId.set(backendId, ref);
    return ref;
  }

  reset(): void {
    this.#counter = 0;
    this.#byBackendId.clear();
  }
}

export interface SnapshotResult {
  /** Human/model-readable indented outline. */
  readonly text: string;
  /** ref → backendDOMNodeId for the nodes present in THIS snapshot. */
  readonly refToBackendId: ReadonlyMap<string, number>;
}

function stringValue(value: AXValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = value.value;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return undefined;
}

function isActionable(role: string | undefined): boolean {
  if (role === undefined) return false;
  return ACTIONABLE_ROLES.has(role) || ACTIONABLE_ROLES.has(role.toLowerCase());
}

/**
 * Format an accessibility node list into ref-annotated outline text.
 *
 * @param nodes    CDP `Accessibility.getFullAXTree` node list.
 * @param registry Persistent ref registry for the current document.
 * @param maxChars Hard cap on the returned text (default 20k).
 */
export function formatSnapshot(
  nodes: readonly AXNode[],
  registry: RefRegistry,
  maxChars = 20_000,
): SnapshotResult {
  const byId = new Map<string, AXNode>();
  const childOf = new Set<string>();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
  }
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) {
      childOf.add(childId);
    }
  }
  const roots = nodes.filter((node) => !childOf.has(node.nodeId));

  const refToBackendId = new Map<string, number>();
  const lines: string[] = [];

  const visit = (node: AXNode, depth: number): void => {
    const role = stringValue(node.role);
    const ignored = node.ignored === true;
    const name = stringValue(node.name);
    const renderable = !ignored && role !== undefined && role !== "none";

    let childDepth = depth;
    if (renderable) {
      const indent = "  ".repeat(depth);
      let line = `${indent}- ${role}`;
      if (name !== undefined && name !== "") {
        line += ` "${name.replace(/\s+/g, " ").trim().slice(0, 120)}"`;
      }
      if (node.backendDOMNodeId !== undefined && isActionable(role)) {
        const ref = registry.refFor(node.backendDOMNodeId);
        refToBackendId.set(ref, node.backendDOMNodeId);
        line += ` [ref=${ref}]`;
        const val = stringValue(node.value);
        if (val !== undefined && val !== "") {
          line += ` value="${val.replace(/\s+/g, " ").trim().slice(0, 80)}"`;
        }
      }
      lines.push(line);
      childDepth = depth + 1;
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child !== undefined) visit(child, childDepth);
    }
  };

  for (const root of roots) visit(root, 0);

  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n… (snapshot truncated)`;
  }
  return { text, refToBackendId };
}
