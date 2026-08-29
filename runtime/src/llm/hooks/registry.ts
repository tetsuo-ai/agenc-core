/**
 * Lifecycle hook registry.
 *
 * Programmatic registration surface — the gut runtime wires hooks at
 * boot (or in tests) by calling `register*Hook(...)`. There is no
 * config snapshot or plugin loader; that scope belongs upstream.
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
  NotificationHook,
  PostCompactHook,
  PreCompactHook,
  SessionEndHook,
  SessionStartHook,
  SubagentStopHook,
} from "./types.js";

export class LifecycleHookRegistry {
  private preCompact: PreCompactHook[] = [];
  private postCompact: PostCompactHook[] = [];
  private sessionStart: SessionStartHook[] = [];
  private subagentStop: SubagentStopHook[] = [];
  private sessionEnd: SessionEndHook[] = [];
  private notification: NotificationHook[] = [];

  addPreCompact(hook: PreCompactHook): () => void {
    this.preCompact.push(hook);
    return once(() => this.remove("PreCompact", hook));
  }

  addPostCompact(hook: PostCompactHook): () => void {
    this.postCompact.push(hook);
    return once(() => this.remove("PostCompact", hook));
  }

  addSessionStart(hook: SessionStartHook): () => void {
    this.sessionStart.push(hook);
    return once(() => this.remove("SessionStart", hook));
  }

  addSubagentStop(hook: SubagentStopHook): () => void {
    this.subagentStop.push(hook);
    return once(() => this.remove("SubagentStop", hook));
  }

  addSessionEnd(hook: SessionEndHook): () => void {
    this.sessionEnd.push(hook);
    return once(() => this.remove("SessionEnd", hook));
  }

  addNotification(hook: NotificationHook): () => void {
    this.notification.push(hook);
    return once(() => this.remove("Notification", hook));
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

  getSubagentStop(): ReadonlyArray<SubagentStopHook> {
    return this.subagentStop;
  }

  getSessionEnd(): ReadonlyArray<SessionEndHook> {
    return this.sessionEnd;
  }

  getNotification(): ReadonlyArray<NotificationHook> {
    return this.notification;
  }

  remove(event: "PreCompact", hook: PreCompactHook): void;
  remove(event: "PostCompact", hook: PostCompactHook): void;
  remove(event: "SessionStart", hook: SessionStartHook): void;
  remove(event: "SubagentStop", hook: SubagentStopHook): void;
  remove(event: "SessionEnd", hook: SessionEndHook): void;
  remove(event: "Notification", hook: NotificationHook): void;
  remove(
    event: LifecycleHookEvent,
    hook:
      | PreCompactHook
      | PostCompactHook
      | SessionStartHook
      | SubagentStopHook
      | SessionEndHook
      | NotificationHook,
  ): void {
    switch (event) {
      case "PreCompact":
        this.preCompact = withoutHook(this.preCompact, hook);
        return;
      case "PostCompact":
        this.postCompact = withoutHook(this.postCompact, hook);
        return;
      case "SessionStart":
        this.sessionStart = withoutHook(this.sessionStart, hook);
        return;
      case "SubagentStop":
        this.subagentStop = withoutHook(this.subagentStop, hook);
        return;
      case "SessionEnd":
        this.sessionEnd = withoutHook(this.sessionEnd, hook);
        return;
      case "Notification":
        this.notification = withoutHook(this.notification, hook);
        return;
    }
  }

  /** Drop every hook for `event`, or all events when omitted. */
  clear(event?: LifecycleHookEvent): void {
    if (event === undefined) {
      this.preCompact = [];
      this.postCompact = [];
      this.sessionStart = [];
      this.subagentStop = [];
      this.sessionEnd = [];
      this.notification = [];
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
      case "SubagentStop":
        this.subagentStop = [];
        return;
      case "SessionEnd":
        this.sessionEnd = [];
        return;
      case "Notification":
        this.notification = [];
        return;
    }
  }
}

function withoutHook<T>(hooks: readonly T[], hook: unknown): T[] {
  const index = hooks.findIndex((candidate) => candidate === hook);
  if (index === -1) return [...hooks];
  return [...hooks.slice(0, index), ...hooks.slice(index + 1)];
}

function once(action: () => void): () => void {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    action();
  };
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

export function registerSubagentStopHook(hook: SubagentStopHook): () => void {
  defaultRegistry.addSubagentStop(hook);
  return () => {
    const remaining = defaultRegistry
      .getSubagentStop()
      .filter((h) => h !== hook);
    defaultRegistry.clear("SubagentStop");
    for (const h of remaining) defaultRegistry.addSubagentStop(h);
  };
}

export function registerSessionEndHook(hook: SessionEndHook): () => void {
  defaultRegistry.addSessionEnd(hook);
  return () => {
    const remaining = defaultRegistry
      .getSessionEnd()
      .filter((h) => h !== hook);
    defaultRegistry.clear("SessionEnd");
    for (const h of remaining) defaultRegistry.addSessionEnd(h);
  };
}

export function registerNotificationHook(hook: NotificationHook): () => void {
  defaultRegistry.addNotification(hook);
  return () => {
    const remaining = defaultRegistry
      .getNotification()
      .filter((h) => h !== hook);
    defaultRegistry.clear("Notification");
    for (const h of remaining) defaultRegistry.addNotification(h);
  };
}
