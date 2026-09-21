import { normalizeModelToolArgs } from "../../src/tools/argument-validation.js";
import { test, expect, vi } from 'vitest';
import { runToolUse } from '../../src/tools/execution.js';
import { ToolRouter } from '../../src/tools/router.js';
import { EventLog } from '../../src/session/event-log.js';
import { resolveAgentRuntimeOptions } from '../../src/session/runtime-options.js';
const schema = { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] };
function fixture() {
  const raw = JSON.stringify({ paths: JSON.stringify(['/blocked/review-fixture']) });
  const eventLog = new EventLog();
  const invocation: any = { session: { eventLog, services: { admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}) } }, turn: { subId: 't' }, tracker: { appendFileDiff() { }, snapshot() { return []; }, clear() { } }, callId: 'c', toolName: { name: 'Probe' }, payload: { kind: 'function', arguments: raw }, source: 'direct' };
  const execute = vi.fn(async () => ({ content: 'executed' }));
  const tool: any = { name: 'Probe', description: 'review mock, no IO', inputSchema: schema, execute };
  return { raw, invocation, execute, tool };
}
test('review: whole-object anyOf admitting string must not normalize that property', () => {
  const s = { anyOf: [schema, { type: 'object', properties: { paths: { type: 'string', minLength: 1000 } }, required: ['paths'] }] };
  const result = normalizeModelToolArgs(s, { paths: '[]' });
  expect(result.valid).toBe(false);
});
test('review: direct runToolUse approval resolver must see executed containers', async () => {
  const { raw, invocation, execute, tool } = fixture();
  let observed: any;
  const result = await runToolUse(raw, { tool, invocation, currentTurnId: 't', approvalResolver: { request: async (ctx: any) => {
        observed = JSON.parse(ctx.invocation.payload.arguments);
        return { kind: Array.isArray(observed.paths) && observed.paths.includes('/blocked/review-fixture') ? 'denied' : 'approved' };
      } } });
  console.log('review direct approval', JSON.stringify({ observed, result, executed: execute.mock.calls.length }));
  expect(execute).not.toHaveBeenCalled();
});
test('review: model dispatch pre-hook payload must agree with args', async () => {
  const { raw, invocation, execute, tool } = fixture();
  let observed: any;
  const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
  const result = await router.dispatchModelToolCall({ id: 'c', name: 'Probe', arguments: raw }, { ...invocation, approvalPolicy: 'never', sandboxMode: 'workspace_write', preHooks: [async ({ invocation: ctx, args }: any) => {
        observed = { payload: JSON.parse(ctx.payload.arguments), args };
        return Array.isArray(observed.payload.paths) && observed.payload.paths.includes('/blocked/review-fixture') ? { kind: 'deny', reason: 'blocked' } : { kind: 'continue' };
      }] });
  console.log('review model hook', JSON.stringify({ observed, result, executed: execute.mock.calls.length }));
  expect(execute).not.toHaveBeenCalled();
});
test('review: model dispatch args-based gate blocks parsed container', async () => {
  const { raw, invocation, execute, tool } = fixture();
  const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
  await router.dispatchModelToolCall({ id: 'c', name: 'Probe', arguments: raw }, { ...invocation, approvalPolicy: 'never', sandboxMode: 'workspace_write', preHooks: [async ({ args }: any) => Array.isArray(args.paths) && args.paths.includes('/blocked/review-fixture') ? { kind: 'deny', reason: 'blocked' } : { kind: 'continue' }] });
  expect(execute).not.toHaveBeenCalled();
});
test('review: streaming concurrency receives the same normalized input as execution', async () => {
  const { StreamingToolExecutor } = await import('../../src/tools/streaming-executor.js');
  const { SHARED_READ } = await import('../../src/tools/concurrency.js');
  const { partitionToolCalls } = await import('../../src/tools/orchestration.js');
  const { raw, tool } = fixture();
  const isConcurrencySafe = vi.fn((args: any) => !Array.isArray(args.paths));
  const tools = [{ ...tool, isConcurrencySafe, concurrencyClass: SHARED_READ }];
  const registry: any = { tools, dispatch: async () => ({ content: 'mock' }), toLLMTools: () => [] };
  const block: any = { type: 'tool_use', id: 'c', name: 'Probe', input: JSON.parse(raw) };
  const batch = partitionToolCalls([block], registry);
  const executor = new StreamingToolExecutor({ registry, runToolUseFn: registry.dispatch });
  executor.addTool(block, { id: 'c', name: 'Probe', arguments: raw });
  console.log('review concurrency', JSON.stringify({ batch: batch[0]?.isConcurrencySafe, observed: isConcurrencySafe.mock.calls }));
  expect(isConcurrencySafe.mock.calls.every(([args]) => Array.isArray(args.paths))).toBe(true);
});
test.each(['anyOf', 'oneOf', 'allOf'])('composed %s object alternatives decline nested repair, including references', (composition) => {
  for (const referenced of [false, true]) {
    for (const alternative of [{ type: 'string', minLength: 1000 }, {}]) {
      const other = { type: 'object', properties: { paths: alternative }, required: ['paths'] };
      const s = { $defs: { array: schema, other }, [composition]: referenced
          ? [{ $ref: '#/$defs/array' }, { $ref: '#/$defs/other' }] : [schema, other] };
      const input = { paths: '[]' };
      // An unconstrained anyOf already accepts the original and must preserve it.
      const result = normalizeModelToolArgs(s, input);
      if ('type' in alternative || composition === 'allOf') {
        expect(result.valid).toBe(false);
      }
      else {
        expect(result.valid).toBe(true);
        expect(result.args).toBe(input);
      }
      expect(input.paths).toBe('[]');
    }
  }
});
test.each([true, false])('streaming predicate classifies normalized input as safe=%s', async (safe) => {
  const { StreamingToolExecutor } = await import('../../src/tools/streaming-executor.js');
  const { SHARED_READ, classify } = await import('../../src/tools/concurrency.js');
  const { raw, tool } = fixture();
  const predicate = vi.fn((args: any) => Array.isArray(args.paths) ? safe : !safe);
  const definition = { ...tool, concurrencyClass: SHARED_READ, isConcurrencySafe: predicate };
  const registry: any = { tools: [definition], dispatch: async () => ({ content: 'mock' }), toLLMTools: () => [] };
  const executor = new StreamingToolExecutor({ registry, runToolUseFn: registry.dispatch });
  const block: any = { type: 'tool_use', id: 'c', name: 'Probe', input: JSON.parse(raw) };
  executor.addTool(block, { id: 'c', name: 'Probe', arguments: raw });
  const tracked = (executor as any).tools[0];
  expect(tracked.isConcurrencySafe).toBe(safe);
  expect(tracked.classification.kind).toBe(safe ? 'shared_read' : 'exclusive');
  expect(classify(definition, normalizeModelToolArgs(schema, JSON.parse(raw)).args!).kind).toBe(tracked.classification.kind);
  // Classification is a gate, so it must never repair a supplied string itself.
  expect(classify(definition, JSON.parse(raw)).kind).toBe('exclusive');
  expect(predicate.mock.calls.every(([args]) => Array.isArray(args.paths))).toBe(true);
  expect(block.input.paths).toBe(JSON.parse(raw).paths);
  predicate.mockClear();
  executor.addTool({ ...block, id: 'bad' }, { id: 'bad', name: 'Probe', arguments: '{"paths":"[broken"}' });
  expect((executor as any).tools[1].isConcurrencySafe).toBe(false);
  expect((executor as any).tools[1].classification.kind).toBe('exclusive');
  expect(predicate).not.toHaveBeenCalled();
});
test('rewritten hook payloads, approval, preflight context and execution agree while provenance stays raw', async () => {
  const { readToolRuntimeContext } = await import('../../src/tools/runtimes/context.js');
  const { raw, invocation, execute, tool } = fixture();
  const seen: any[] = [];
  let runtimeSnapshots = 0;
  tool.preflight = (args: any) => {
    const runtime = readToolRuntimeContext(args);
    if (runtime) {
      runtimeSnapshots++;
      expect(JSON.parse(runtime.rawArgs)).toEqual(args);
      expect(JSON.parse((runtime.invocation.payload as any).arguments)).toEqual(args);
    }
  };
  const hooks: any[] = [
    async ({ invocation: ctx, args }: any) => {
      expect(JSON.parse(ctx.payload.arguments)).toEqual(args);
      return { kind: 'rewrite', args: { paths: ['/rewritten'] } };
    },
    async ({ invocation: ctx, args }: any) => {
      expect(JSON.parse(ctx.payload.arguments)).toEqual(args);
      expect(args.paths).toEqual(['/rewritten']);
      seen.push(args);
      return { kind: 'continue' };
    },
  ];
  const output = await runToolUse(raw, { tool, invocation, currentTurnId: 't', preHooks: hooks, approvalResolver: { request: async (ctx: any) => {
        expect(JSON.parse(ctx.invocation.payload.arguments)).toEqual(seen[0]);
        return { kind: 'approved' };
      } } });
  expect(execute.mock.calls[0]?.[0]).toEqual(seen[0]);
  expect(output.payload).toEqual(invocation.payload);
  expect((invocation.payload as any).arguments).toBe(raw);
  const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
  await router.dispatchModelToolCall({ id: 'c', name: 'Probe', arguments: raw }, { ...invocation, approvalPolicy: 'never', sandboxMode: 'workspace_write', preHooks: hooks });
  expect(execute.mock.calls).toHaveLength(2);
  expect(runtimeSnapshots).toBeGreaterThan(0);
});
test('MCP hooks and resolver see normalized args while result payload remains original', async () => {
  const { raw, invocation, tool, execute } = fixture();
  invocation.payload = { kind: 'mcp', server: 'fixture', tool: 'Probe', rawArguments: raw };
  const inspect = ({ invocation: ctx, args }: any) => {
    expect(JSON.parse(ctx.payload.rawArguments)).toEqual(args);
    expect(args.paths).toEqual(['/blocked/review-fixture']);
  };
  const result = await runToolUse(raw, {
    tool, invocation, currentTurnId: 't',
    preHooks: [async (ctx: any) => { inspect(ctx); return { kind: 'continue' }; }],
    postHooks: [async (ctx: any) => { inspect(ctx); return { kind: 'continue' }; }],
    approvalResolver: { request: async (ctx: any) => {
        expect(JSON.parse(ctx.invocation.payload.rawArguments).paths).toEqual(['/blocked/review-fixture']);
        return { kind: 'approved' };
      } },
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(result.payload).toEqual(invocation.payload);
  expect(invocation.payload.rawArguments).toBe(raw);
});
