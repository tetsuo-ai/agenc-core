export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

/**
 * Capability metadata is registry/session-owned. Retired provider-specific
 * model environment variables must never create an alternate capability or
 * model authority.
 */
export function get3PModelCapabilityOverride(
  _model: string,
  _capability: ModelCapabilityOverride,
): undefined {
  return undefined
}
