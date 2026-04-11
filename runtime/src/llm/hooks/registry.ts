/**
 * In-memory hook registry (Cut 5.2).
 *
 * Holds the configured `HookDefinition[]` keyed by event so the
 * dispatcher can look up which hooks to fire for a given event in O(1)
 * without scanning the full list every call.
 *
 * @module
 */

import type { HookDefinition, HookEvent } from "./types.js";

export class HookRegistry {
  private readonly hooksByEvent = new Map<HookEvent, HookDefinition[]>();

  constructor(definitions: readonly HookDefinition[] = []) {
    for (const def of definitions) this.add(def);
  }

  add(definition: HookDefinition): void {
    const list = this.hooksByEvent.get(definition.event) ?? [];
    list.push(definition);
    this.hooksByEvent.set(definition.event, list);
  }

  forEvent(event: HookEvent): readonly HookDefinition[] {
    return this.hooksByEvent.get(event) ?? [];
  }

  size(): number {
    let total = 0;
    for (const list of this.hooksByEvent.values()) total += list.length;
    return total;
  }
}
