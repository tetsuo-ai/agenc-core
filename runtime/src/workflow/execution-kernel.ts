import type {
  Pipeline,
  PipelineExecutionOptions,
  PipelinePlannerStep,
  PipelineResult,
  PipelineStopReasonHint,
} from "./pipeline.js";
import { resolvePipelineCompletionState } from "./completion-state.js";
import type { WorkflowGraphEdge } from "./types.js";
import type {
  ExecutionKernel as ExecutionKernelContract,
  ExecutionKernelDependencyState,
  ExecutionKernelStepState,
  ExecutionKernelPlannerDelegate,
  ExecutionKernelRuntimeNode,
} from "./execution-kernel-types.js";
import { emitStepStateChange } from "./execution-kernel-events.js";
import {
  buildDependencyBlockedError,
  buildDependencyBlockedResult,
} from "./execution-kernel-policy.js";
import type { DeterministicPipelineExecutor } from "../llm/chat-executor-types.js";

interface RunningNode {
  readonly promise: Promise<{
    name: string;
    outcome: Awaited<ReturnType<ExecutionKernelPlannerDelegate["executeNode"]>>;
  }>;
  readonly exclusive: boolean;
  readonly abortController: AbortController;
}

interface BlockedDependencyDetail {
  readonly stepName: string;
  readonly reason: string;
  readonly stopReasonHint: PipelineStopReasonHint;
}

export interface ExecutionKernelConfig {
  readonly deterministicExecutor: DeterministicPipelineExecutor;
  readonly plannerDelegate: ExecutionKernelPlannerDelegate;
}

export class CanonicalExecutionKernel implements ExecutionKernelContract {
  private readonly deterministicExecutor: DeterministicPipelineExecutor;
  private readonly plannerDelegate: ExecutionKernelPlannerDelegate;

  constructor(config: ExecutionKernelConfig) {
    this.deterministicExecutor = config.deterministicExecutor;
    this.plannerDelegate = config.plannerDelegate;
  }

  async execute(
    pipeline: Pipeline,
    startFrom = 0,
    options?: PipelineExecutionOptions,
  ): Promise<PipelineResult> {
    const plannerSteps = pipeline.plannerSteps;
    if (!plannerSteps || plannerSteps.length === 0) {
      return this.deterministicExecutor.execute(pipeline, startFrom, options);
    }

    if (startFrom > 0) {
      return {
        status: "failed",
        completionState: "blocked",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error:
          "Execution kernel does not support DAG resume offsets yet (startFrom > 0)",
        stopReasonHint: "validation_error",
      };
    }

    const validationError = this.plannerDelegate.validatePipeline?.(pipeline);
    if (validationError) {
      return {
        status: "failed",
        completionState: "blocked",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error: validationError,
        stopReasonHint: "validation_error",
      };
    }

    const materialized = this.materializeDag(plannerSteps, pipeline.edges ?? []);
    if (materialized.error) {
      return {
        status: "failed",
        completionState: "blocked",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error: materialized.error,
        stopReasonHint: "validation_error",
      };
    }

    const nodes = materialized.nodes;
    const executionOrder = materialized.order;
    const stepByName = new Map(nodes.map((node) => [node.step.name, node]));
    const pending = new Set(executionOrder);
    const satisfied = new Set<string>();
    const unsatisfied = new Map<string, ExecutionKernelDependencyState>();
    const blockedStepNames: string[] = [];
    const mutableResults: Record<string, string> = { ...pipeline.context.results };
    const running = new Map<string, RunningNode>();
    const nodeState = new Map<string, ExecutionKernelStepState>();
    const totalSteps = plannerSteps.length;
    let completedSteps = 0;
    const maxParallel = Math.max(
      1,
      this.plannerDelegate.resolveMaxParallelism?.(pipeline) ?? 1,
    );

    for (const nodeName of executionOrder) {
      const node = stepByName.get(nodeName);
      if (!node) continue;
      const traceTool = this.plannerDelegate.resolveTraceToolName?.(node.step);
      const traceArgs = this.plannerDelegate.buildTraceArgs?.(node.step);
      emitStepStateChange({
        options,
        pipelineId: pipeline.id,
        stepName: node.step.name,
        stepIndex: node.orderIndex,
        state: "queued",
        ...(traceTool ? { tool: traceTool } : {}),
        ...(traceArgs ? { args: traceArgs } : {}),
      });
      nodeState.set(node.step.name, "queued");
    }

    while (pending.size > 0 || running.size > 0) {
      let scheduledAny = false;
      const exclusiveRunning = Array.from(running.values()).some((handle) => handle.exclusive);

      for (const nodeName of executionOrder) {
        if (!pending.has(nodeName)) continue;
        if (running.size >= maxParallel) break;
        const node = stepByName.get(nodeName);
        if (!node) continue;

        const blockedDependencies = this.collectBlockedDependencies(node, unsatisfied);
        if (blockedDependencies.length > 0) {
          pending.delete(nodeName);
          blockedStepNames.push(node.step.name);
          const stopReasonHint =
            blockedDependencies[0]?.stopReasonHint ?? "validation_error";
          const error = buildDependencyBlockedError(node.step.name, blockedDependencies);
          mutableResults[node.step.name] = buildDependencyBlockedResult(
            node.step.name,
            blockedDependencies,
            error,
            stopReasonHint,
          );
          this.plannerDelegate.onStepDependencyBlocked?.({
            step: node.step,
            pipeline,
            blockedDependencies,
            error,
          });
          unsatisfied.set(node.step.name, {
            satisfied: false,
            reason: error,
            stopReasonHint,
          });
          emitStepStateChange({
            options,
            pipelineId: pipeline.id,
            stepName: node.step.name,
            stepIndex: node.orderIndex,
            previousState: nodeState.get(node.step.name),
            state: "blocked_on_dependency",
            reason: error,
            blockingDependencies: blockedDependencies.map((dependency) => dependency.stepName),
            ...(this.plannerDelegate.resolveTraceToolName?.(node.step)
              ? { tool: this.plannerDelegate.resolveTraceToolName?.(node.step) }
              : {}),
            ...(this.plannerDelegate.buildTraceArgs?.(node.step)
              ? { args: this.plannerDelegate.buildTraceArgs?.(node.step) }
              : {}),
          });
          nodeState.set(node.step.name, "blocked_on_dependency");
          continue;
        }

        if (!this.dependenciesSatisfied(node, satisfied)) continue;

        const exclusiveNode = this.plannerDelegate.isExclusiveNode(node.step);
        if (exclusiveRunning) break;
        if (exclusiveNode && running.size > 0) continue;

        emitStepStateChange({
          options,
          pipelineId: pipeline.id,
          stepName: node.step.name,
          stepIndex: node.orderIndex,
          previousState: nodeState.get(node.step.name),
          state: "ready",
          ...(this.plannerDelegate.resolveTraceToolName?.(node.step)
            ? { tool: this.plannerDelegate.resolveTraceToolName?.(node.step) }
            : {}),
          ...(this.plannerDelegate.buildTraceArgs?.(node.step)
            ? { args: this.plannerDelegate.buildTraceArgs?.(node.step) }
            : {}),
        });
        nodeState.set(node.step.name, "ready");

        const traceTool = this.plannerDelegate.resolveTraceToolName?.(node.step);
        const traceArgs = this.plannerDelegate.buildTraceArgs?.(node.step);
        const stepStartedAt = Date.now();
        if (traceTool !== undefined) {
          options?.onEvent?.({
            type: "step_started",
            pipelineId: pipeline.id,
            stepName: node.step.name,
            stepIndex: node.orderIndex,
            tool: traceTool,
            args: traceArgs,
          });
        }
        emitStepStateChange({
          options,
          pipelineId: pipeline.id,
          stepName: node.step.name,
          stepIndex: node.orderIndex,
          previousState: nodeState.get(node.step.name),
          state: "running",
          ...(traceTool ? { tool: traceTool } : {}),
          ...(traceArgs ? { args: traceArgs } : {}),
        });
        nodeState.set(node.step.name, "running");

        const nodeAbortController = new AbortController();
        const promise = this.plannerDelegate
          .executeNode(
            node.step,
            pipeline,
            mutableResults,
            options,
            nodeAbortController.signal,
          )
          .then((outcome) => {
            if (traceTool !== undefined) {
              const event: {
                type: "step_finished";
                pipelineId: string;
                stepName: string;
                stepIndex: number;
                tool: string;
                args?: Record<string, unknown>;
                durationMs: number;
                result?: string;
                error?: string;
              } = {
                type: "step_finished",
                pipelineId: pipeline.id,
                stepName: node.step.name,
                stepIndex: node.orderIndex,
                tool: traceTool,
                args: traceArgs,
                durationMs: Math.max(0, Date.now() - stepStartedAt),
              };
              if ("result" in outcome && typeof outcome.result === "string") {
                event.result = outcome.result;
              }
              if (outcome.status === "failed") {
                event.error = outcome.error;
              } else if (outcome.status === "halted" && outcome.error) {
                event.error = outcome.error;
              }
              options?.onEvent?.(event);
            }
            return { name: node.step.name, outcome };
          });

        running.set(node.step.name, {
          promise,
          exclusive: exclusiveNode,
          abortController: nodeAbortController,
        });
        pending.delete(nodeName);
        scheduledAny = true;
        if (exclusiveNode) break;
      }

      if (running.size === 0) {
        if (pending.size === 0) break;
        return {
          status: "failed",
          completionState: resolvePipelineCompletionState({
            status: "failed",
            completedSteps,
          }),
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          error:
            "Planner DAG has no runnable nodes; dependency graph may be invalid",
          stopReasonHint: "validation_error",
        };
      }

      if (!scheduledAny && running.size > 0) {
        // Await an active node below.
      }

      const completion = await Promise.race(
        Array.from(running.values()).map((handle) => handle.promise),
      );
      running.delete(completion.name);

      const node = stepByName.get(completion.name);
      if (!node) {
        return {
          status: "failed",
          completionState: resolvePipelineCompletionState({
            status: "failed",
            completedSteps,
          }),
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          error: `Unknown node "${completion.name}" completed`,
          stopReasonHint: "validation_error",
        };
      }

      if (
        completion.outcome.status === "failed" &&
        completion.outcome.fallback?.satisfied
      ) {
        mutableResults[node.step.name] = completion.outcome.fallback.result;
        const dependencyState = this.plannerDelegate.assessDependencySatisfaction(
          node.step,
          completion.outcome.fallback.result,
        );
        if (dependencyState.satisfied) {
          satisfied.add(node.step.name);
          emitStepStateChange({
            options,
            pipelineId: pipeline.id,
            stepName: node.step.name,
            stepIndex: node.orderIndex,
            previousState: nodeState.get(node.step.name),
            state: "completed",
            reason: completion.outcome.fallback.reason,
            ...(this.plannerDelegate.resolveTraceToolName?.(node.step)
              ? { tool: this.plannerDelegate.resolveTraceToolName?.(node.step) }
              : {}),
            ...(this.plannerDelegate.buildTraceArgs?.(node.step)
              ? { args: this.plannerDelegate.buildTraceArgs?.(node.step) }
              : {}),
          });
          nodeState.set(node.step.name, "completed");
        } else {
          unsatisfied.set(node.step.name, dependencyState);
          emitStepStateChange({
            options,
            pipelineId: pipeline.id,
            stepName: node.step.name,
            stepIndex: node.orderIndex,
            previousState: nodeState.get(node.step.name),
            state: "failed",
            reason:
              dependencyState.reason ??
              completion.outcome.fallback.reason ??
              `Planner step "${node.step.name}" finished without satisfying its contract`,
            ...(this.plannerDelegate.resolveTraceToolName?.(node.step)
              ? { tool: this.plannerDelegate.resolveTraceToolName?.(node.step) }
              : {}),
            ...(this.plannerDelegate.buildTraceArgs?.(node.step)
              ? { args: this.plannerDelegate.buildTraceArgs?.(node.step) }
              : {}),
          });
          nodeState.set(node.step.name, "failed");
        }
        completedSteps++;
        continue;
      }

      if (completion.outcome.status === "completed") {
        mutableResults[node.step.name] = completion.outcome.result;
        const dependencyState = this.plannerDelegate.assessDependencySatisfaction(
          node.step,
          completion.outcome.result,
        );
        if (dependencyState.satisfied) {
          satisfied.add(node.step.name);
          emitStepStateChange({
            options,
            pipelineId: pipeline.id,
            stepName: node.step.name,
            stepIndex: node.orderIndex,
            previousState: nodeState.get(node.step.name),
            state: "completed",
            ...(this.plannerDelegate.resolveTraceToolName?.(node.step)
              ? { tool: this.plannerDelegate.resolveTraceToolName?.(node.step) }
              : {}),
            ...(this.plannerDelegate.buildTraceArgs?.(node.step)
              ? { args: this.plannerDelegate.buildTraceArgs?.(node.step) }
              : {}),
          });
          nodeState.set(node.step.name, "completed");
        } else {
          unsatisfied.set(node.step.name, dependencyState);
          emitStepStateChange({
            options,
            pipelineId: pipeline.id,
            stepName: node.step.name,
            stepIndex: node.orderIndex,
            previousState: nodeState.get(node.step.name),
            state: "failed",
            reason:
              dependencyState.reason ??
              `Planner step "${node.step.name}" finished without satisfying its contract`,
            ...(this.plannerDelegate.resolveTraceToolName?.(node.step)
              ? { tool: this.plannerDelegate.resolveTraceToolName?.(node.step) }
              : {}),
            ...(this.plannerDelegate.buildTraceArgs?.(node.step)
              ? { args: this.plannerDelegate.buildTraceArgs?.(node.step) }
              : {}),
          });
          nodeState.set(node.step.name, "failed");
        }
        completedSteps++;
        continue;
      }

      if (completion.outcome.status === "halted") {
        for (const [, handle] of running) {
          handle.abortController.abort();
        }
        if (running.size > 0) {
          await Promise.allSettled(Array.from(running.values()).map((handle) => handle.promise));
          running.clear();
        }
        emitStepStateChange({
          options,
          pipelineId: pipeline.id,
          stepName: node.step.name,
          stepIndex: node.orderIndex,
          previousState: nodeState.get(node.step.name),
          state: "blocked_on_approval",
          reason:
            completion.outcome.error ??
            `Planner step "${node.step.name}" halted awaiting approval`,
          ...(this.plannerDelegate.resolveTraceToolName?.(node.step)
            ? { tool: this.plannerDelegate.resolveTraceToolName?.(node.step) }
            : {}),
          ...(this.plannerDelegate.buildTraceArgs?.(node.step)
            ? { args: this.plannerDelegate.buildTraceArgs?.(node.step) }
            : {}),
        });
        nodeState.set(node.step.name, "blocked_on_approval");
        return {
          status: "halted",
          completionState: resolvePipelineCompletionState({
            status: "halted",
            completedSteps,
          }),
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          resumeFrom: node.orderIndex,
          error: completion.outcome.error,
          stopReasonHint: completion.outcome.stopReasonHint,
        };
      }

      if (typeof completion.outcome.result === "string") {
        mutableResults[node.step.name] = completion.outcome.result;
      }
      for (const [, handle] of running) {
        handle.abortController.abort();
      }
      if (running.size > 0) {
        await Promise.allSettled(Array.from(running.values()).map((handle) => handle.promise));
        running.clear();
      }
      emitStepStateChange({
        options,
        pipelineId: pipeline.id,
        stepName: node.step.name,
        stepIndex: node.orderIndex,
        previousState: nodeState.get(node.step.name),
        state: "failed",
        reason: completion.outcome.error,
        ...(this.plannerDelegate.resolveTraceToolName?.(node.step)
          ? { tool: this.plannerDelegate.resolveTraceToolName?.(node.step) }
          : {}),
        ...(this.plannerDelegate.buildTraceArgs?.(node.step)
          ? { args: this.plannerDelegate.buildTraceArgs?.(node.step) }
          : {}),
      });
      nodeState.set(node.step.name, "failed");
      return {
        status: "failed",
        completionState: resolvePipelineCompletionState({
          status: "failed",
          completedSteps,
        }),
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps,
        error: completion.outcome.error,
        decomposition: completion.outcome.decomposition,
        stopReasonHint: completion.outcome.stopReasonHint,
      };
    }

    if (blockedStepNames.length > 0) {
      const primaryBlockedStep = blockedStepNames[0];
      const primaryAssessment = primaryBlockedStep
        ? unsatisfied.get(primaryBlockedStep)
        : undefined;
      return {
        status: "failed",
        completionState: resolvePipelineCompletionState({
          status: "failed",
          completedSteps,
        }),
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps,
        error:
          blockedStepNames.length === 1
            ? (primaryAssessment?.reason ??
              `Planner step "${primaryBlockedStep}" was blocked by an unmet dependency`)
            : `Planner DAG blocked ${blockedStepNames.length} step(s) after unmet dependency contracts: ${blockedStepNames.join(", ")}`,
        stopReasonHint: primaryAssessment?.stopReasonHint ?? "validation_error",
      };
    }

    return {
      status: "completed",
      completionState: "completed",
      context: { results: { ...mutableResults } },
      completedSteps,
      totalSteps,
    };
  }

  private dependenciesSatisfied(
    node: ExecutionKernelRuntimeNode,
    satisfied: ReadonlySet<string>,
  ): boolean {
    for (const dependency of node.dependencies) {
      if (!satisfied.has(dependency)) {
        return false;
      }
    }
    return true;
  }

  private collectBlockedDependencies(
    node: ExecutionKernelRuntimeNode,
    unsatisfied: ReadonlyMap<string, ExecutionKernelDependencyState>,
  ): BlockedDependencyDetail[] {
    const blocked: BlockedDependencyDetail[] = [];
    for (const dependency of node.dependencies) {
      const state = unsatisfied.get(dependency);
      if (!state || state.satisfied) continue;
      blocked.push({
        stepName: dependency,
        reason:
          state.reason ??
          `Dependency "${dependency}" finished without satisfying its contract`,
        stopReasonHint: state.stopReasonHint ?? "validation_error",
      });
    }
    return blocked;
  }

  private materializeDag(
    steps: readonly PipelinePlannerStep[],
    edges: readonly WorkflowGraphEdge[],
  ): { nodes: ExecutionKernelRuntimeNode[]; order: string[]; error?: string } {
    const stepByName = new Map<string, PipelinePlannerStep>();
    for (const step of steps) {
      if (stepByName.has(step.name)) {
        return {
          nodes: [],
          order: [],
          error: `Planner DAG has duplicate step name "${step.name}"`,
        };
      }
      stepByName.set(step.name, step);
    }

    const dependencyMap = new Map<string, Set<string>>();
    for (const step of steps) {
      dependencyMap.set(step.name, new Set(step.dependsOn ?? []));
    }
    for (const edge of edges) {
      if (!stepByName.has(edge.from) || !stepByName.has(edge.to)) continue;
      dependencyMap.get(edge.to)?.add(edge.from);
    }

    for (const [stepName, dependencies] of dependencyMap.entries()) {
      for (const dependency of dependencies) {
        if (!stepByName.has(dependency)) {
          return {
            nodes: [],
            order: [],
            error:
              `Planner DAG step "${stepName}" depends on unknown step "${dependency}"`,
          };
        }
      }
    }

    const temporary = new Set<string>();
    const permanent = new Set<string>();
    const order: string[] = [];

    const visit = (stepName: string): boolean => {
      if (permanent.has(stepName)) return true;
      if (temporary.has(stepName)) return false;
      temporary.add(stepName);
      for (const dependency of dependencyMap.get(stepName) ?? []) {
        if (!visit(dependency)) return false;
      }
      temporary.delete(stepName);
      permanent.add(stepName);
      order.push(stepName);
      return true;
    };

    for (const step of steps) {
      if (!visit(step.name)) {
        return {
          nodes: [],
          order: [],
          error: `Planner DAG contains a cycle involving "${step.name}"`,
        };
      }
    }

    const nodes = order.map((stepName, index) => ({
      step: stepByName.get(stepName)!,
      dependencies: dependencyMap.get(stepName) ?? new Set<string>(),
      orderIndex: index,
    }));
    return { nodes, order };
  }
}
