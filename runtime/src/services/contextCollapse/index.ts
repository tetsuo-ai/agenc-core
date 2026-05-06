/**
 * Disabled context-collapse service surface.
 *
 * AgenC callers can probe this module even when the collapse engine is not
 * part of the runtime build.
 */

export type AgenCContextCollapseState = null;

export function isContextCollapseEnabled(): boolean {
  return false;
}

export function getContextCollapseState(): AgenCContextCollapseState {
  return null;
}
