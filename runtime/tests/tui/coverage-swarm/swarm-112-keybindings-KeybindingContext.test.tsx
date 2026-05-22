import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import Text from "../ink/components/Text.js";
import { createRoot } from "../ink/root.js";
import type { Key } from "../ink.js";
import {
  KeybindingProvider,
  useKeybindingContext,
  useRegisterKeybindingContext,
} from "../keybindings/KeybindingContext.js";
import { parseBindings } from "../keybindings/parser.js";
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from "../keybindings/types.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type HandlerRegistration = {
  action: string;
  context: KeybindingContextName;
  handler: () => void;
};

function createTestStreams(): {
  stdout: PassThrough;
  stdin: TestStdin;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  stdout.resume();

  return { stdout, stdin };
}

function key(overrides: Partial<Key> = {}): Key {
  return {
    backspace: false,
    ctrl: false,
    delete: false,
    downArrow: false,
    end: false,
    escape: false,
    fn: false,
    home: false,
    leftArrow: false,
    meta: false,
    pageDown: false,
    pageUp: false,
    return: false,
    rightArrow: false,
    shift: false,
    super: false,
    tab: false,
    upArrow: false,
    wheelDown: false,
    wheelUp: false,
    ...overrides,
  } as Key;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
}

type ProviderHarnessProps = {
  activeContexts?: Set<KeybindingContextName>;
  children: React.ReactNode;
  handlerRegistryRef?: React.RefObject<Map<string, Set<HandlerRegistration>> | null>;
  registeredContexts?: KeybindingContextName[];
  unregisteredContexts?: KeybindingContextName[];
};

function ProviderHarness({
  activeContexts = new Set<KeybindingContextName>(),
  children,
  handlerRegistryRef = {
    current: new Map<string, Set<HandlerRegistration>>(),
  },
  registeredContexts = [],
  unregisteredContexts = [],
}: ProviderHarnessProps): React.ReactNode {
  const pendingChordRef = React.useRef<ParsedKeystroke[] | null>(null);
  const [pendingChord, setPendingChordState] = React.useState<
    ParsedKeystroke[] | null
  >(null);
  const bindings = React.useMemo(
    () =>
      parseBindings([
        {
          context: "Chat",
          bindings: {
            enter: "chat:submit",
            "ctrl+x ctrl+k": "chat:killAgents",
          },
        },
      ]),
    [],
  );
  const setPendingChord = React.useCallback(
    (pending: ParsedKeystroke[] | null) => {
      pendingChordRef.current = pending;
      setPendingChordState(pending);
    },
    [],
  );

  return (
    <KeybindingProvider
      activeContexts={activeContexts}
      bindings={bindings}
      handlerRegistryRef={
        handlerRegistryRef as React.RefObject<
          Map<string, Set<HandlerRegistration>>
        >
      }
      pendingChord={pendingChord}
      pendingChordRef={pendingChordRef}
      registerActiveContext={context => {
        registeredContexts.push(context);
        activeContexts.add(context);
      }}
      setPendingChord={setPendingChord}
      unregisterActiveContext={context => {
        unregisteredContexts.push(context);
        activeContexts.delete(context);
      }}
    >
      {children}
    </KeybindingProvider>
  );
}

class HookErrorBoundary extends React.Component<
  { errors: string[]; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    this.props.errors.push(error.message);
  }

  render(): React.ReactNode {
    if (this.state.hasError) return <Text>caught</Text>;
    return this.props.children;
  }
}

function RequiredContextProbe(): React.ReactNode {
  useKeybindingContext();
  return <Text>required</Text>;
}

function NullRegistryProbe({ events }: { events: string[] }): React.ReactNode {
  const ctx = useKeybindingContext();

  React.useEffect(() => {
    const cleanup = ctx.registerHandler({
      action: "chat:submit",
      context: "Chat",
      handler: () => events.push("unexpected-handler"),
    });

    events.push(`invoke:${ctx.invokeAction("chat:submit")}`);
    cleanup();
    events.push("cleanup-ok");

    const resolved = ctx.resolve("x", key({ ctrl: true }), ["Chat"]);
    events.push(`resolve:${resolved.type}`);
    if (resolved.type === "chord_started") {
      ctx.setPendingChord(resolved.pending);
    }
  }, [ctx, events]);

  return <Text>null registry</Text>;
}

function RegistryProbe({
  events,
  registry,
}: {
  events: string[];
  registry: Map<string, Set<HandlerRegistration>>;
}): React.ReactNode {
  const ctx = useKeybindingContext();

  React.useEffect(() => {
    const cleanupActive = ctx.registerHandler({
      action: "chat:submit",
      context: "Chat",
      handler: () => events.push("active-handler"),
    });

    events.push(`empty:${ctx.invokeAction("chat:killAgents")}`);
    events.push(`active:${ctx.invokeAction("chat:submit")}`);
    cleanupActive();
    events.push(`left:${registry.get("chat:submit")?.size ?? 0}`);
    events.push(`inactive:${ctx.invokeAction("chat:submit")}`);
  }, [ctx, events, registry]);

  return <Text>registry</Text>;
}

function RegisterContextProbe({
  isActive,
}: {
  isActive?: boolean;
}): React.ReactNode {
  useRegisterKeybindingContext("Chat", isActive);
  return <Text>registration</Text>;
}

async function withRoot(
  render: (root: Awaited<ReturnType<typeof createRoot>>) => void | Promise<void>,
): Promise<void> {
  const { stdout, stdin } = createTestStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    await render(root);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep(25);
  }
}

describe("KeybindingContext coverage swarm 112", () => {
  test("reports the required hook error outside a provider", async () => {
    const errors: string[] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      await withRoot(root => {
        root.render(
          <HookErrorBoundary errors={errors}>
            <RequiredContextProbe />
          </HookErrorBoundary>,
        );

        return waitForCondition(
          () =>
            errors.includes(
              "useKeybindingContext must be used within KeybindingProvider",
            ),
          "required hook error was not captured",
        );
      });
    } finally {
      consoleError.mockRestore();
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
  });

  test("keeps null handler registry paths as safe no-ops", async () => {
    const events: string[] = [];

    await withRoot(root => {
      root.render(
        <ProviderHarness handlerRegistryRef={{ current: null }}>
          <NullRegistryProbe events={events} />
        </ProviderHarness>,
      );

      return waitForCondition(
        () => events.includes("cleanup-ok"),
        "null registry probe did not run",
      );
    });

    expect(events).toEqual([
      "invoke:false",
      "cleanup-ok",
      "resolve:chord_started",
    ]);
  });

  test("keeps inactive registered handlers while removing only the active handler", async () => {
    const events: string[] = [];
    const inactiveHandler = vi.fn();
    const registry = new Map<string, Set<HandlerRegistration>>([
      ["chat:killAgents", new Set()],
      [
        "chat:submit",
        new Set([
          {
            action: "chat:submit",
            context: "Confirmation",
            handler: inactiveHandler,
          },
        ]),
      ],
    ]);

    await withRoot(root => {
      root.render(
        <ProviderHarness
          activeContexts={new Set(["Chat"])}
          handlerRegistryRef={{ current: registry }}
        >
          <RegistryProbe events={events} registry={registry} />
        </ProviderHarness>,
      );

      return waitForCondition(
        () => events.includes("inactive:false"),
        "registry probe did not finish",
      );
    });

    expect(events).toEqual([
      "empty:false",
      "active-handler",
      "active:true",
      "left:1",
      "inactive:false",
    ]);
    expect(inactiveHandler).not.toHaveBeenCalled();
    expect(registry.get("chat:submit")).toHaveLength(1);
  });

  test("skips context registration when inactive or outside a provider", async () => {
    const registeredContexts: KeybindingContextName[] = [];
    const unregisteredContexts: KeybindingContextName[] = [];

    await withRoot(async root => {
      root.render(<RegisterContextProbe />);
      await sleep(25);
    });

    await withRoot(async root => {
      root.render(
        <ProviderHarness
          registeredContexts={registeredContexts}
          unregisteredContexts={unregisteredContexts}
        >
          <RegisterContextProbe isActive={false} />
        </ProviderHarness>,
      );
      await sleep(25);
    });

    expect(registeredContexts).toEqual([]);
    expect(unregisteredContexts).toEqual([]);
  });
});
