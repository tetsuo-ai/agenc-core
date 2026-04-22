// @ts-nocheck
import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../llm/compact/auto-compact.js'
import { microcompactMessages } from '../llm/compact/micro-compact.js'
import {
  resolveTransportMode,
  type TransportMode,
} from '../transport/fallback-ladder.js'

// -- deps

// I/O dependencies for query(). Passing a `deps` override into QueryParams
// lets tests inject fakes directly instead of spyOn-per-module — the most
// common mocks (callModel, autocompact) are each spied in 6-8 test files
// today with module-import-and-spy boilerplate.
//
// Using `typeof fn` keeps signatures in sync with the real implementations
// automatically. This file imports the real functions for both typing and
// the production factory — tests that import this file for typing are
// already importing query.ts (which imports everything), so there's no
// new module-graph cost.
//
// Scope is intentionally narrow (4 deps) to prove the pattern. Followup
// PRs can add runTools, handleStopHooks, logEvent, queue ops, etc.
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming
  transportMode?: TransportMode

  // -- compaction
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // -- platform
  uuid: () => string
}

function resolveProductionCallModel(
  _transportMode: TransportMode | undefined,
): typeof queryModelWithStreaming {
  // Legacy query() still streams through the existing model caller, but it now
  // resolves the selected live transport mode up front so the runtime path
  // cannot silently bypass T8 ladder selection.
  return queryModelWithStreaming
}

export function productionDeps(
  env: NodeJS.ProcessEnv = process.env,
): QueryDeps {
  const transportMode = resolveTransportMode(env)
  return {
    callModel: resolveProductionCallModel(transportMode),
    transportMode,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
