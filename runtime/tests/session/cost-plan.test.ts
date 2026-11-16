import { describe, expect, it } from 'vitest';
import { CostSidecar, computeUsdCostWithResolution, DEFAULT_MODEL_COSTS } from '../../src/session/cost.js';
import { usageToTokenCountEvent } from '../../src/session/event-log.js';
import { parseRolloutLine, serializeRolloutItem } from '../../src/session/rollout-item.js';
import { AdmissionUsageProjection, type UsageReservation } from '../../src/state/admission-usage-snapshot.js';

const usage = { model: 'gpt-6.1-sol', provider: 'openai', inputTokens: 1000, outputTokens: 100,
  cachedInputTokens: 500, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
  webSearchRequests: 0, totalTokens: 1100, turns: 1 };

describe('sign-in and swarm accounting', () => {
  it('prices sign-in as plan while the same API usage retains its price', () => {
    expect(computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS).costUsd).toBeGreaterThan(0);
    expect(computeUsdCostWithResolution({ ...usage, billingMode: 'plan' }, DEFAULT_MODEL_COSTS).costUsd).toBe(0);
    const sidecar = new CostSidecar();
    sidecar.onEvent({ id: '1', msg: { type: 'token_count', payload: {
      model: usage.model, provider: 'openai', promptTokens: 1000, completionTokens: 100, totalTokens: 1100,
      billingMode: 'plan',
    } } });
    expect(sidecar.getTotalCostUsd()).toBe(0);
  });
  it('keeps plan, billed, cache and per-agent model totals distinct across updates', () => {
    const projection = new AdmissionUsageProjection();
    const row: UsageReservation = { reservation_id: 'lead', run_id: 'parent', kind: 'model_turn',
      model: usage.model, provider: 'openai', status: 'reconciled', actual_input_tokens: 1000,
      actual_output_tokens: 100, actual_tokens: 1100, actual_cost_nanos: 10_000_000,
      reserved_cost_nanos: 20_000_000, resolution_reason: null,
      usage_details_json: JSON.stringify({ billingMode: 'plan', cachedInputTokens: 500, apiEquivalentUsd: 0.01 }),
    };
    projection.update('lead', row);
    projection.update('child', { ...row, reservation_id: 'child', run_id: 'child', provider: 'deepseek',
      model: 'deepseek-v4.1-flash', actual_cost_nanos: 2_000_000,
      dispatched_at: '2026-10-24T02:00:00Z',
      usage_details_json: JSON.stringify({ billingMode: 'metered', cachedInputTokens: 900 }),
    });
    const summary = projection.capture('parent', 1).read();
    expect(summary).toMatchObject({ costUsd: 0.002, billedEstimateUsd: 0.001, planCalls: 1,
      apiEquivalentUsd: 0.01, cachedInputTokens: 1400, cacheInputTokens: 2000, includesSubagents: true });
    expect(summary.agentModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'parent', provider: 'openai', model: usage.model, modelCalls: 1, planCalls: 1, costUsd: 0 }),
      expect.objectContaining({ runId: 'child', provider: 'deepseek', billedEstimateUsd: 0.001, modelCalls: 1 }),
    ]));
    projection.update('lead', row);
    expect(projection.capture('parent', 2).read().planCalls).toBe(1);
  });
});

it('does not discount DeepSeek tool fees or an authoritative provider charge twice', () => {
  const projection = new AdmissionUsageProjection();
  const row: UsageReservation = { reservation_id: 'tools', run_id: 'parent', kind: 'model_turn',
    provider: 'deepseek', model: 'deepseek-v4.1-flash', status: 'reconciled', actual_input_tokens: 1000,
    actual_output_tokens: 100, actual_tokens: 1100, actual_cost_nanos: 1_170_000,
    reserved_cost_nanos: 2_000_000, resolution_reason: null, dispatched_at: '2026-10-24T02:00:00Z',
    usage_details_json: JSON.stringify({ billingMode: 'metered', offPeakEligibleCostUsd: 0.00042 }),
  };
  projection.update('tools', row);
  expect(projection.capture('parent', 1).read().billedEstimateUsd).toBeCloseTo(0.00096, 10);
  projection.update('tools', { ...row, usage_details_json: JSON.stringify({ billingMode: 'metered', offPeakEligibleCostUsd: 0 }) });
  expect(projection.capture('parent', 2).read().billedEstimateUsd).toBe(0.00117);
});

it('does not reprice earlier plan calls when the same model switches to an API key', () => {
  const sidecar = new CostSidecar();
  const payload = { model: usage.model, provider: 'openai', promptTokens: 1000,
    completionTokens: 100, totalTokens: 1100, cachedInputTokens: 500 };
  sidecar.onEvent({ id: 'plan', msg: { type: 'token_count', payload: { ...payload, billingMode: 'plan' } } });
  const equivalent = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS).costUsd;
  expect(sidecar.getSessionModelUsage()[0]).toMatchObject({ planCalls: 1, apiEquivalentUsd: equivalent, costUsd: 0 });
  expect(sidecar.getTotalAccountingCostUsd()).toBeCloseTo(equivalent, 12);
  sidecar.onEvent({ id: 'api', msg: { type: 'token_count', payload } });
  expect(sidecar.getTotalCostUsd()).toBeCloseTo(equivalent, 12);
  expect(sidecar.getTotalAccountingCostUsd()).toBeCloseTo(2 * equivalent, 12);
  expect(sidecar.getSessionModelUsage()[0]).toMatchObject({ planCalls: 1, apiEquivalentUsd: equivalent });
  sidecar.reset();
  expect(sidecar.getSessionModelUsage()).toEqual([]);
});

it('excludes missing cache reports from the share and preserves snapshot ownership', () => {
  const projection = new AdmissionUsageProjection();
  const row: UsageReservation = { reservation_id: 'cached', run_id: 'parent', kind: 'model_turn',
    provider: 'openai', model: usage.model, status: 'reconciled', actual_input_tokens: 100,
    actual_output_tokens: 10, actual_tokens: 110, actual_cost_nanos: 10_000,
    reserved_cost_nanos: 20_000, resolution_reason: null,
    usage_details_json: JSON.stringify({ billingMode: 'metered', cachedInputTokens: 90 }),
  };
  projection.update('cached', row);
  const snapshot = projection.capture('parent', 1);
  projection.update('missing', { ...row, reservation_id: 'missing', usage_details_json: JSON.stringify({ billingMode: 'metered' }) });
  const summary = projection.capture('parent', 2).read();
  expect(summary).toMatchObject({ cachedInputTokens: 90, cacheInputTokens: 100, cacheUnreportedCalls: 1, inputTokens: 200 });
  expect(snapshot.read().agentModels?.[0]?.modelCalls).toBe(1);
  expect(summary.agentModels?.[0]?.modelCalls).toBe(2);
});

it('marks unpriced API-equivalents without inventing a subscription charge', () => {
  const sidecar = new CostSidecar();
  sidecar.onEvent({ id: 'unknown', msg: { type: 'token_count', payload: {
    model: 'future-unpriced-model', provider: 'openai', promptTokens: 100, completionTokens: 10,
    totalTokens: 110, billingMode: 'plan',
  } } });
  expect(sidecar.getTotalCostUsd()).toBe(0);
  expect(sidecar.getSessionModelUsage()[0]).toMatchObject({ planCalls: 1, apiEquivalentUsd: 0, apiEquivalentUnknown: true });
});


it('keeps the billing route in replayable token events', () => {
  const msg = usageToTokenCountEvent({ promptTokens: 100, completionTokens: 10, totalTokens: 110, billingMode: 'plan' });
  const item = { type: 'event_msg' as const, payload: { id: 'plan-event', msg } };
  expect(parseRolloutLine(serializeRolloutItem(item).trim())).toMatchObject(item);
});
