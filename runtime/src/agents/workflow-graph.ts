/** Stable, bounded compilation of a workflow manifest into scheduler state. */

import type {
  WorkflowDagManifestV2,
  WorkflowRef,
  WorkflowStepV2,
} from "./workflow-manifest-schema.js";

export const MAX_WORKFLOW_CYCLE_WITNESS_STEPS = 16;

export interface WorkflowGraphCompileLimits {
  readonly maximumExpandedEdges: number;
}

export interface WorkflowGraphOperationCounts {
  readonly nodeVisits: number;
  readonly referenceVisits: number;
  readonly expandedEdgeVisits: number;
  readonly kahnEdgeVisits: number;
}

export interface CompiledWorkflowNode {
  readonly ordinal: number;
  readonly step: WorkflowStepV2;
  readonly dependencyOrdinals: readonly number[];
  readonly dependentOrdinals: readonly number[];
}

export interface CompiledWorkflowGroup {
  readonly name: string;
  readonly memberOrdinals: readonly number[];
}

export interface CompiledWorkflowGraph {
  readonly nodes: readonly CompiledWorkflowNode[];
  readonly nodeById: ReadonlyMap<string, CompiledWorkflowNode>;
  readonly groups: ReadonlyMap<string, CompiledWorkflowGroup>;
  readonly topologicalOrder: readonly number[];
  readonly edgeCount: number;
  readonly operationCounts: WorkflowGraphOperationCounts;
}

export class WorkflowGraphValidationError extends Error {
  readonly code = "WORKFLOW_GRAPH_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkflowGraphValidationError";
  }
}

interface MutableWorkflowNode {
  readonly ordinal: number;
  readonly step: WorkflowStepV2;
  readonly dependencies: number[];
  readonly dependents: number[];
}

/**
 * Compile and validate a manifest in O(V + E). Queue and adjacency order both
 * follow declaration order, making the resulting schedule stable.
 */
export function compileWorkflowGraph(
  manifest: WorkflowDagManifestV2,
  limits: WorkflowGraphCompileLimits,
): CompiledWorkflowGraph {
  assertMaximumExpandedEdges(limits.maximumExpandedEdges);
  if (manifest.steps.length === 0) {
    throw graphError("workflow has no steps");
  }

  const mutableNodes: MutableWorkflowNode[] = [];
  const ordinalById = new Map<string, number>();
  const mutableGroupMembers = new Map<string, number[]>();
  let nodeVisits = 0;

  for (let ordinal = 0; ordinal < manifest.steps.length; ordinal += 1) {
    const step = manifest.steps[ordinal]!;
    nodeVisits += 1;
    if (ordinalById.has(step.id)) {
      throw graphError(`duplicate workflow step id ${JSON.stringify(step.id)}`);
    }
    ordinalById.set(step.id, ordinal);
    mutableNodes.push({ ordinal, step, dependencies: [], dependents: [] });
    if (step.group !== undefined) {
      const members = mutableGroupMembers.get(step.group) ?? [];
      members.push(ordinal);
      mutableGroupMembers.set(step.group, members);
    }
  }

  for (const groupName of mutableGroupMembers.keys()) {
    if (ordinalById.has(groupName)) {
      throw graphError(
        `workflow step id and group name collide at ${JSON.stringify(groupName)}`,
      );
    }
  }

  let referenceVisits = 0;
  let expandedEdgeVisits = 0;
  let edgeCount = 0;
  for (const node of mutableNodes) {
    const dependencies = new Set<number>();
    const addReference = (
      reference: WorkflowRef,
      rejectDuplicateEdge: boolean,
    ): void => {
      referenceVisits += 1;
      const expanded = expandReference(
        reference,
        ordinalById,
        mutableGroupMembers,
        node.step.id,
      );
      for (const dependencyOrdinal of expanded) {
        expandedEdgeVisits += 1;
        if (expandedEdgeVisits > limits.maximumExpandedEdges) {
          throw graphError(
            `workflow exceeds ${limits.maximumExpandedEdges} expanded edges`,
          );
        }
        if (dependencyOrdinal === node.ordinal) {
          throw graphError(
            `workflow step ${JSON.stringify(node.step.id)} depends on itself`,
          );
        }
        if (dependencies.has(dependencyOrdinal) && rejectDuplicateEdge) {
          const dependencyId = mutableNodes[dependencyOrdinal]!.step.id;
          throw graphError(
            `workflow step ${JSON.stringify(node.step.id)} repeats ` +
              `dependency edge from ${JSON.stringify(dependencyId)}`,
          );
        }
        if (dependencies.has(dependencyOrdinal)) continue;
        dependencies.add(dependencyOrdinal);
        edgeCount += 1;
        node.dependencies.push(dependencyOrdinal);
        mutableNodes[dependencyOrdinal]!.dependents.push(node.ordinal);
      }
    };
    for (const reference of node.step.after ?? []) {
      addReference(reference, true);
    }
    for (const reference of Object.values(node.step.inputs ?? {})) {
      // Multiple aliases may intentionally bind the same artifact. They count
      // against the expanded-input budget but remain one scheduling edge.
      addReference(reference, false);
    }
  }

  const remaining = mutableNodes.map((node) => node.dependencies.length);
  const ready: number[] = [];
  for (const node of mutableNodes) {
    if (remaining[node.ordinal] === 0) ready.push(node.ordinal);
  }
  const topologicalOrder: number[] = [];
  let kahnEdgeVisits = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const ordinal = ready[cursor]!;
    topologicalOrder.push(ordinal);
    for (const dependentOrdinal of mutableNodes[ordinal]!.dependents) {
      kahnEdgeVisits += 1;
      const next = remaining[dependentOrdinal]! - 1;
      remaining[dependentOrdinal] = next;
      if (next === 0) ready.push(dependentOrdinal);
    }
  }

  if (topologicalOrder.length !== mutableNodes.length) {
    const witness = mutableNodes
      .filter((node) => remaining[node.ordinal]! > 0)
      .slice(0, MAX_WORKFLOW_CYCLE_WITNESS_STEPS)
      .map((node) => node.step.id);
    const omitted =
      mutableNodes.length - topologicalOrder.length - witness.length;
    throw graphError(
      `workflow contains a dependency cycle involving ${witness
        .map((id) => JSON.stringify(id))
        .join(", ")}${omitted > 0 ? ` and ${omitted} more step(s)` : ""}`,
    );
  }

  const nodes = Object.freeze(
    mutableNodes.map((node): CompiledWorkflowNode =>
      Object.freeze({
        ordinal: node.ordinal,
        step: node.step,
        dependencyOrdinals: Object.freeze([...node.dependencies]),
        dependentOrdinals: Object.freeze([...node.dependents]),
      }),
    ),
  );
  const nodeById = new Map(
    nodes.map((node) => [node.step.id, node] as const),
  );
  const groups = new Map<string, CompiledWorkflowGroup>();
  for (const [name, members] of mutableGroupMembers) {
    groups.set(
      name,
      Object.freeze({ name, memberOrdinals: Object.freeze([...members]) }),
    );
  }
  return Object.freeze({
    nodes,
    nodeById,
    groups,
    topologicalOrder: Object.freeze(topologicalOrder),
    edgeCount,
    operationCounts: Object.freeze({
      nodeVisits,
      referenceVisits,
      expandedEdgeVisits,
      kahnEdgeVisits,
    }),
  });
}

function expandReference(
  reference: WorkflowRef,
  ordinalById: ReadonlyMap<string, number>,
  groupMembers: ReadonlyMap<string, readonly number[]>,
  consumerId: string,
): readonly number[] {
  if ("step" in reference) {
    const ordinal = ordinalById.get(reference.step);
    if (ordinal === undefined) {
      throw graphError(
        `workflow step ${JSON.stringify(consumerId)} references ` +
          `unknown step ${JSON.stringify(reference.step)}`,
      );
    }
    return [ordinal];
  }
  const members = groupMembers.get(reference.group);
  if (members === undefined) {
    throw graphError(
      `workflow step ${JSON.stringify(consumerId)} references ` +
        `unknown group ${JSON.stringify(reference.group)}`,
    );
  }
  return members;
}

function assertMaximumExpandedEdges(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maximumExpandedEdges must be a positive safe integer");
  }
}

function graphError(message: string): WorkflowGraphValidationError {
  return new WorkflowGraphValidationError(message);
}
