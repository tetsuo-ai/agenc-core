import { PassThrough } from "node:stream";
import React, { useContext, useEffect } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { AlternateScreen } from "./components/AlternateScreen.js";
import Box from "./components/Box.js";
import StdinContext from "./components/StdinContext.js";
import TerminalFocusContext from "./components/TerminalFocusContext.js";
import Text from "./components/Text.js";
import { useDeclaredCursor } from "./hooks/use-declared-cursor.js";
import instances from "./instances.js";
import { createRoot } from "./root.js";
import {
  EBP,
  EFE,
  DISABLE_ALTERNATE_SCROLL,
  ENABLE_ALTERNATE_SCROLL,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from "./termio/dec.js";
import {
  getTerminalFocusState,
  resetTerminalFocusState,
  setTerminalFocused,
} from "./terminal-focus-state.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  isRaw?: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (mode: boolean) => {
    stdin.isRaw = mode;
  };
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  stdout: PassThrough;
  stdin: TestStdin;
  unmount: () => void;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 20));

  return {
    stdout,
    stdin,
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

function drain(stream: PassThrough): string {
  let out = "";
  let chunk: Buffer | string | null;
  while ((chunk = stream.read()) !== null) {
    out += chunk.toString();
  }
  return out;
}

function CursorProbe(): React.ReactElement {
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: true,
  });

  return (
    <Box ref={cursorRef}>
      <Text>cursor</Text>
    </Box>
  );
}

function RawModeProbe(): React.ReactElement {
  const stdin = useContext(StdinContext);

  useEffect(() => {
    stdin.setRawMode(true);
    return () => {
      stdin.setRawMode(false);
    };
  }, [stdin]);

  return <Text>raw</Text>;
}

describe("ink lifecycle regressions", () => {
  afterEach(() => {
    resetTerminalFocusState();
  });

  test("clears the declared cursor on unmount using the last committed node", async () => {
    const { stdout, unmount } = await mount(<CursorProbe />);
    const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
      | {
          cursorDeclaration: { node: unknown } | null;
        }
      | undefined;

    expect(instance?.cursorDeclaration?.node).toBeTruthy();

    unmount();

    expect(instance?.cursorDeclaration).toBeNull();
  });

  test("resets stale blurred terminal focus before a fresh mount renders", async () => {
    setTerminalFocused(false);
    expect(getTerminalFocusState()).toBe("blurred");

    const seenStates: string[] = [];

    function FocusProbe(): React.ReactElement {
      const { terminalFocusState } = useContext(TerminalFocusContext);
      seenStates.push(terminalFocusState);
      return <Text>{terminalFocusState}</Text>;
    }

    const { unmount } = await mount(<FocusProbe />);

    expect(seenStates[0]).toBe("unknown");
    expect(seenStates).not.toContain("blurred");
    expect(getTerminalFocusState()).toBe("unknown");

    unmount();
  });

  test("enables and disables alternate scroll with alt-screen lifecycle", async () => {
    const { stdout, unmount } = await mount(
      <AlternateScreen mouseTracking={false}>
        <Text>alt</Text>
      </AlternateScreen>,
    );

    const mountedOutput = drain(stdout);
    expect(mountedOutput).toContain(ENTER_ALT_SCREEN);
    expect(mountedOutput).toContain(ENABLE_ALTERNATE_SCROLL);

    unmount();

    const unmountedOutput = drain(stdout);
    expect(unmountedOutput).toContain(DISABLE_ALTERNATE_SCROLL);
    expect(unmountedOutput).toContain(EXIT_ALT_SCREEN);
  });

  test("reasserts raw/input modes on SIGCONT when raw mode is active", async () => {
    const { stdout, stdin, unmount } = await mount(<RawModeProbe />);
    expect(stdin.isRaw).toBe(true);
    drain(stdout);

    stdin.isRaw = false;
    process.emit("SIGCONT");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const output = drain(stdout);
    expect(stdin.isRaw).toBe(true);
    expect(output).toContain(EBP);
    expect(output).toContain(EFE);

    unmount();
  });
});
