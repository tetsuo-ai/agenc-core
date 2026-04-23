import { PassThrough } from "node:stream";
import React, { useContext } from "react";
import { afterEach, describe, expect, test } from "vitest";

import Box from "./components/Box.js";
import TerminalFocusContext from "./components/TerminalFocusContext.js";
import Text from "./components/Text.js";
import { useDeclaredCursor } from "./hooks/use-declared-cursor.js";
import instances from "./instances.js";
import { createRoot } from "./root.js";
import {
  getTerminalFocusState,
  resetTerminalFocusState,
  setTerminalFocused,
} from "./terminal-focus-state.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  stdout: PassThrough;
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
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
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
});
