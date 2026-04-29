/**
 * Lifecycle hook registry.
 *
 * Programmatic registration surface — the gut runtime wires hooks at
 * boot (or in tests) by calling `register*Hook(...)`. There is no
 * settings.json scanner or plugin loader; that scope belongs upstream.
 *
 * Two layers:
 *  - `LifecycleHookRegistry` — instantiable container, used in tests.
 *  - module-level singleton + `registerPreCompactHook` etc. — the
 *    default registry the dispatcher reads from in production.
 *
 * @module
 */
import type {
  LifecycleHookEvent,
  PostCompactHook,
  PreCompactHook,
  SessionStartHook,
} from "./types.js";

export class LifecycleHookRegistry {
  private preCompact: PreCompactHook[] = [];
  private postCompact: PostCompactHook[] = [];
  private sessionStart: SessionStartHook[] = [];

  addPreCompact(hook: PreCompactHook): void {
    this.preCompact.push(hook);
  }

  addPostCompact(hook: PostCompactHook): void {
    this.postCompact.push(hook);
  }

  addSessionStart(hook: SessionStartHook): void {
    this.sessionStart.push(hook);
  }

  getPreCompact(): ReadonlyArray<PreCompactHook> {
    return this.preCompact;
  }

  getPostCompact(): ReadonlyArray<PostCompactHook> {
    return this.postCompact;
  }

  getSessionStart(): ReadonlyArray<SessionStartHook> {
    return this.sessionStart;
  }

  /** Drop every hook for `event`, or all events when omitted. */
  clear(event?: LifecycleHookEvent): void {
    if (event === undefined) {
      this.preCompact = [];
      this.postCompact = [];
      this.sessionStart = [];
      return;
    }
    switch (event) {
      case "PreCompact":
        this.preCompact = [];
        return;
      case "PostCompact":
        this.postCompact = [];
        return;
      case "SessionStart":
        this.sessionStart = [];
        return;
    }
  }
}

let defaultRegistry: LifecycleHookRegistry = new LifecycleHookRegistry();

export function getLifecycleHookRegistry(): LifecycleHookRegistry {
  return defaultRegistry;
}

/** Test-only escape hatch. Production code should not swap the registry. */
export function setLifecycleHookRegistry(
  registry: LifecycleHookRegistry,
): void {
  defaultRegistry = registry;
}

export function resetLifecycleHookRegistry(): void {
  defaultRegistry = new LifecycleHookRegistry();
}

export function registerPreCompactHook(hook: PreCompactHook): () => void {
  defaultRegistry.addPreCompact(hook);
  return () => {
    // Targeted unregister: rebuild without this hook so re-registering
    // the same fn during a test cleanup does not leak.
    const remaining = defaultRegistry
      .getPreCompact()
      .filter((h) => h !== hook);
    defaultRegistry.clear("PreCompact");
    for (const h of remaining) defaultRegistry.addPreCompact(h);
  };
}

export function registerPostCompactHook(hook: PostCompactHook): () => void {
  defaultRegistry.addPostCompact(hook);
  return () => {
    const remaining = defaultRegistry
      .getPostCompact()
      .filter((h) => h !== hook);
    defaultRegistry.clear("PostCompact");
    for (const h of remaining) defaultRegistry.addPostCompact(h);
  };
}

export function registerSessionStartHook(hook: SessionStartHook): () => void {
  defaultRegistry.addSessionStart(hook);
  return () => {
    const remaining = defaultRegistry
      .getSessionStart()
      .filter((h) => h !== hook);
    defaultRegistry.clear("SessionStart");
    for (const h of remaining) defaultRegistry.addSessionStart(h);
  };
}
