import { describe, expect, it } from "vitest";

import {
  compileWorkflowGraph,
  MAX_WORKFLOW_CYCLE_WITNESS_STEPS,
  WorkflowGraphValidationError,
} from "../../src/agents/workflow-graph.js";
import {
  MAX_WORKFLOW_EXPANDED_EDGES,
  type WorkflowDagManifestV2,
  type WorkflowStepV2,
} from "../../src/agents/workflow-manifest-schema.js";

const compile = (steps: readonly WorkflowStepV2[]) =>
  compileWorkflowGraph(manifest(steps), {
    maximumExpandedEdges: MAX_WORKFLOW_EXPANDED_EDGES,
  });

describe("compileWorkflowGraph", () => {
  it("produces stable declaration-order Kahn and adjacency lists", () => {
    const graph = compile([
      { id: "root-b", message: "b" },
      { id: "root-a", message: "a" },
      { id: "join", message: "join", after: [{ step: "root-a" }, { step: "root-b" }] },
      { id: "tail", message: "tail", after: [{ step: "join" }] },
    ]);

    expect(graph.topologicalOrder.map((ordinal) => graph.nodes[ordinal]!.step.id)).toEqual([
      "root-b",
      "root-a",
      "join",
      "tail",
    ]);
    expect(graph.nodeById.get("join")?.dependencyOrdinals).toEqual([1, 0]);
    expect(graph.nodeById.get("root-b")?.dependentOrdinals).toEqual([2]);
    expect(graph.operationCounts).toEqual({
      nodeVisits: 4,
      referenceVisits: 3,
      expandedEdgeVisits: 3,
      kahnEdgeVisits: 3,
    });
  });

  it("expands namespaced group references once in member declaration order", () => {
    const graph = compile([
      { id: "left", message: "left", group: "readers" },
      { id: "right", message: "right", group: "readers" },
      { id: "consumer", message: "consume", inputs: { prior: { group: "readers" } } },
    ]);

    expect(graph.nodeById.get("consumer")?.dependencyOrdinals).toEqual([0, 1]);
    expect(graph.groups.get("readers")?.memberOrdinals).toEqual([0, 1]);
  });

  it.each([
    {
      name: "step/group collision",
      steps: [
        { id: "same", message: "one" },
        { id: "other", message: "two", group: "same" },
      ],
      message: /collide/u,
    },
    {
      name: "expanded duplicate edge",
      steps: [
        { id: "source", message: "one", group: "sources" },
        {
          id: "consumer",
          message: "two",
          after: [{ step: "source" }, { group: "sources" }],
        },
      ],
      message: /repeats dependency edge/u,
    },
    {
      name: "self group edge",
      steps: [
        {
          id: "self",
          message: "one",
          group: "members",
          after: [{ group: "members" }],
        },
      ],
      message: /depends on itself/u,
    },
    {
      name: "unknown structured reference",
      steps: [
        { id: "consumer", message: "one", after: [{ step: "missing" }] },
      ],
      message: /unknown step/u,
    },
  ])("rejects $name before scheduling", ({ steps, message }) => {
    expect(() => compile(steps as readonly WorkflowStepV2[])).toThrow(message);
  });

  it("bounds a cycle witness instead of dumping the graph", () => {
    const size = MAX_WORKFLOW_CYCLE_WITNESS_STEPS + 10;
    const steps = Array.from({ length: size }, (_, index): WorkflowStepV2 => ({
      id: `node-${index}`,
      message: "cycle",
      after: [{ step: `node-${(index + size - 1) % size}` }],
    }));

    let caught: unknown;
    try {
      compile(steps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowGraphValidationError);
    expect(String((caught as Error).message).match(/"node-/gu)).toHaveLength(
      MAX_WORKFLOW_CYCLE_WITNESS_STEPS,
    );
    expect((caught as Error).message).toContain("and 10 more step(s)");
  });

  it("visits each node and edge a constant number of times on a dense DAG", () => {
    const size = 128;
    const steps = Array.from({ length: size }, (_, index): WorkflowStepV2 => ({
      id: `node-${index}`,
      message: "dense",
      after: Array.from({ length: index }, (__, dependency) => ({
        step: `node-${dependency}`,
      })),
    }));
    const graph = compile(steps);
    const expectedEdges = (size * (size - 1)) / 2;

    expect(graph.edgeCount).toBe(expectedEdges);
    expect(graph.operationCounts.nodeVisits).toBe(size);
    expect(graph.operationCounts.referenceVisits).toBe(expectedEdges);
    expect(graph.operationCounts.expandedEdgeVisits).toBe(expectedEdges);
    expect(graph.operationCounts.kahnEdgeVisits).toBe(expectedEdges);
  });
});

function manifest(steps: readonly WorkflowStepV2[]): WorkflowDagManifestV2 {
  return {
    format_version: 2,
    kind: "agent_dag",
    steps,
  };
}
