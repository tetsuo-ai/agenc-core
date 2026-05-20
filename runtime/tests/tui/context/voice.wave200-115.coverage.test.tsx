import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import Text from "../ink/components/Text.js";
import { createRoot } from "../ink/root.js";
import {
  VoiceProvider,
  useGetVoiceState,
  useSetVoiceState,
  useVoiceState,
  type VoiceState,
} from "./voice.js";

vi.mock("../../utils/debug.js", () => ({
  logForDebugging: () => {},
}));
vi.mock("../../bootstrap/state.js", () => ({
  flushInteractionTime: () => {},
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}));
vi.mock("../../utils/earlyInput.js", () => ({
  stopCapturingEarlyInput: () => {},
}));
vi.mock("../../utils/envUtils.js", () => ({
  isEnvTruthy: () => false,
}));
vi.mock("../../utils/fullscreen.js", () => ({
  isMouseClicksDisabled: () => true,
}));
vi.mock("../../utils/log.js", () => ({
  logError: () => {},
}));

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type Snapshot = VoiceState & {
  getterStable: boolean | null;
  setterStable: boolean | null;
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
  (stdout as unknown as { columns: number }).columns = 120;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  return { stdout, stdin };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for voice context state");
}

const selectVoiceState = (state: VoiceState) => state.voiceState;
const selectVoiceError = (state: VoiceState) => state.voiceError;
const selectVoiceInterimTranscript = (state: VoiceState) =>
  state.voiceInterimTranscript;
const selectVoiceAudioLevels = (state: VoiceState) => state.voiceAudioLevels;
const selectVoiceWarmingUp = (state: VoiceState) => state.voiceWarmingUp;

function VoiceProbe({
  immediateReads,
  snapshots,
}: {
  immediateReads: VoiceState[];
  snapshots: Snapshot[];
}): React.ReactNode {
  const voiceState = useVoiceState(selectVoiceState);
  const voiceError = useVoiceState(selectVoiceError);
  const voiceInterimTranscript = useVoiceState(selectVoiceInterimTranscript);
  const voiceAudioLevels = useVoiceState(selectVoiceAudioLevels);
  const voiceWarmingUp = useVoiceState(selectVoiceWarmingUp);
  const setVoiceState = useSetVoiceState();
  const getVoiceState = useGetVoiceState();
  const previousSetter = React.useRef<typeof setVoiceState | null>(null);
  const previousGetter = React.useRef<typeof getVoiceState | null>(null);
  const didUpdate = React.useRef(false);

  React.useEffect(() => {
    snapshots.push({
      voiceState,
      voiceError,
      voiceInterimTranscript,
      voiceAudioLevels,
      voiceWarmingUp,
      setterStable:
        previousSetter.current === null
          ? null
          : previousSetter.current === setVoiceState,
      getterStable:
        previousGetter.current === null
          ? null
          : previousGetter.current === getVoiceState,
    });
    previousSetter.current = setVoiceState;
    previousGetter.current = getVoiceState;
  }, [
    getVoiceState,
    setVoiceState,
    snapshots,
    voiceAudioLevels,
    voiceError,
    voiceInterimTranscript,
    voiceState,
    voiceWarmingUp,
  ]);

  React.useEffect(() => {
    if (didUpdate.current) return;
    didUpdate.current = true;
    setVoiceState((previous) => ({
      ...previous,
      voiceState: "recording",
      voiceError: "microphone unavailable",
      voiceInterimTranscript: "hello agenc",
      voiceAudioLevels: [0.2, 0.5, 0.9],
      voiceWarmingUp: true,
    }));
    immediateReads.push(getVoiceState());
  }, [getVoiceState, immediateReads, setVoiceState]);

  return <Text>{voiceState}</Text>;
}

function OutsideProviderProbe(): React.ReactNode {
  useVoiceState(selectVoiceState);
  return <Text>outside</Text>;
}

describe("VoiceProvider", () => {
  test("publishes default state, supports synchronous updates, and rejects missing provider usage", async () => {
    const snapshots: Snapshot[] = [];
    const immediateReads: VoiceState[] = [];
    const child = (
      <VoiceProbe immediateReads={immediateReads} snapshots={snapshots} />
    );
    const { stdout, stdin } = createTestStreams();
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    });

    try {
      root.render(<VoiceProvider>{child}</VoiceProvider>);
      await waitForCondition(() =>
        snapshots.some((snapshot) => snapshot.voiceState === "recording"),
      );
      root.render(<VoiceProvider>{child}</VoiceProvider>);
      await waitForCondition(() =>
        snapshots.some((snapshot) => snapshot.setterStable === true),
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }

    expect(snapshots[0]).toEqual({
      voiceState: "idle",
      voiceError: null,
      voiceInterimTranscript: "",
      voiceAudioLevels: [],
      voiceWarmingUp: false,
      setterStable: null,
      getterStable: null,
    });
    expect(immediateReads[0]).toEqual({
      voiceState: "recording",
      voiceError: "microphone unavailable",
      voiceInterimTranscript: "hello agenc",
      voiceAudioLevels: [0.2, 0.5, 0.9],
      voiceWarmingUp: true,
    });
    expect(snapshots).toContainEqual({
      voiceState: "recording",
      voiceError: "microphone unavailable",
      voiceInterimTranscript: "hello agenc",
      voiceAudioLevels: [0.2, 0.5, 0.9],
      voiceWarmingUp: true,
      setterStable: true,
      getterStable: true,
    });

    const outside = createTestStreams();
    const stderr = new PassThrough();
    let stderrOutput = "";
    stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
    const outsideRoot = await createRoot({
      stdout: outside.stdout as unknown as NodeJS.WriteStream,
      stdin: outside.stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    try {
      outsideRoot.render(<OutsideProviderProbe />);
      await waitForCondition(() =>
        stderrOutput.includes(
          "useVoiceState must be used within a VoiceProvider",
        ),
      );
    } finally {
      outsideRoot.unmount();
      outside.stdin.end();
      outside.stdout.end();
      stderr.end();
    }

    expect(stderrOutput).toContain(
      "useVoiceState must be used within a VoiceProvider",
    );
  });
});
