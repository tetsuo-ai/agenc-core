import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import {
  dismissLedgerVerification,
  getLedgerVerificationSnapshot,
  LEDGER_VERIFICATION_TIMEOUT_MS,
  LEDGER_VERIFIED_AUTO_DISMISS_MS,
  markLedgerVerificationFailed,
  subscribeLedgerVerification,
  type LedgerVerificationPhase,
} from "../../services/Ledger/ledgerVerification.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { Box, Text, useInput } from "../ink.js";
import { TerminalWriteContext } from "../ink/useTerminalNotification.js";
import {
  kittyLogoPlaceholderRows,
  supportsKittyGraphics,
} from "./v2/primitives.js";
import {
  LEDGER_NANO_BRAILLE_LINES,
  LEDGER_NANO_RASTER_HEIGHT,
  LEDGER_NANO_RASTER_HALF_WIDTH,
  LEDGER_NANO_LEFT_RGBA_ZLIB_BASE64,
  LEDGER_NANO_RIGHT_RGBA_ZLIB_BASE64,
  LEDGER_NANO_VERIFIED_BRAILLE_LINES,
  LEDGER_NANO_VERIFIED_LEFT_RGBA_ZLIB_BASE64,
  LEDGER_NANO_VERIFIED_RIGHT_RGBA_ZLIB_BASE64,
} from "./ledgerNanoGraphics.generated.js";

const POPUP_WIDTH = 66;
const POPUP_ESTIMATED_HEIGHT = 19;
const KITTY_IMAGE_PART_COLUMNS = 16;
const KITTY_IMAGE_ROWS = 8;
const KITTY_PENDING_IMAGE_IDS = [0xfffffb, 0xfffffa] as const;
const KITTY_VERIFIED_IMAGE_IDS = [0xfffff9, 0xfffff8] as const;
const KITTY_PENDING_IMAGE_PAYLOADS = [
  LEDGER_NANO_LEFT_RGBA_ZLIB_BASE64,
  LEDGER_NANO_RIGHT_RGBA_ZLIB_BASE64,
] as const;
const KITTY_VERIFIED_IMAGE_PAYLOADS = [
  LEDGER_NANO_VERIFIED_LEFT_RGBA_ZLIB_BASE64,
  LEDGER_NANO_VERIFIED_RIGHT_RGBA_ZLIB_BASE64,
] as const;
const ACTIVE_FRAMES = ["◇", "◈", "◆", "◈"] as const;

function kittyImageUploadCommand(
  imageId: number,
  payload: string,
): string {
  return [
    "\x1b_G",
    "a=T,q=2,o=z,f=32,C=1,U=1,",
    `s=${LEDGER_NANO_RASTER_HALF_WIDTH},v=${LEDGER_NANO_RASTER_HEIGHT},`,
    `c=${KITTY_IMAGE_PART_COLUMNS},r=${KITTY_IMAGE_ROWS},i=${imageId};`,
    payload,
    "\x1b\\",
  ].join("");
}

function kittyImageColor(imageId: number): `#${string}` {
  return `#${imageId.toString(16).padStart(6, "0")}`;
}

function KittyLedgerNano({
  verified,
  writeRaw,
}: {
  readonly verified: boolean;
  readonly writeRaw: (data: string) => void;
}): React.ReactNode {
  const terminalSize = useTerminalSize();
  const imageIds = verified
    ? KITTY_VERIFIED_IMAGE_IDS
    : KITTY_PENDING_IMAGE_IDS;
  const payloads = verified
    ? KITTY_VERIFIED_IMAGE_PAYLOADS
    : KITTY_PENDING_IMAGE_PAYLOADS;
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    writeRaw(kittyImageUploadCommand(imageIds[0], payloads[0]));
    writeRaw(kittyImageUploadCommand(imageIds[1], payloads[1]));
    setReady(true);
    return () => {
      writeRaw(`\x1b_Ga=d,d=I,i=${imageIds[0]},q=2;\x1b\\`);
      writeRaw(`\x1b_Ga=d,d=I,i=${imageIds[1]},q=2;\x1b\\`);
    };
  }, [
    imageIds,
    payloads,
    terminalSize.columns,
    terminalSize.rows,
    writeRaw,
  ]);

  if (!ready) return null;
  return (
    <Box
      flexDirection="column"
      width={KITTY_IMAGE_PART_COLUMNS * 2}
      height={KITTY_IMAGE_ROWS}
      flexShrink={0}
    >
      {kittyLogoPlaceholderRows(
        KITTY_IMAGE_PART_COLUMNS,
        KITTY_IMAGE_ROWS,
      ).map((line, index) => (
        <Box key={index} flexDirection="row">
          <Text color={kittyImageColor(imageIds[0])}>{line}</Text>
          <Text color={kittyImageColor(imageIds[1])}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

function LedgerNanoGraphic({
  verified,
}: {
  readonly verified: boolean;
}): React.ReactNode {
  const writeRaw = React.useContext(TerminalWriteContext);
  if (writeRaw && supportsKittyGraphics()) {
    return (
      <KittyLedgerNano
        key={verified ? "verified" : "pending"}
        verified={verified}
        writeRaw={writeRaw}
      />
    );
  }

  const lines = verified
    ? LEDGER_NANO_VERIFIED_BRAILLE_LINES
    : LEDGER_NANO_BRAILLE_LINES;
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color="#ffffff">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function stateCopy(phase: LedgerVerificationPhase): {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
} {
  switch (phase) {
    case "waiting":
      return {
        eyebrow: "DEVICE REQUIRED",
        title: "CONNECT & UNLOCK YOUR LEDGER",
        body: "Keep the device connected. AgenC will continue as soon as wallet-cli can read it.",
      };
    case "verifying":
      return {
        eyebrow: "SECURE DEVICE CHECK",
        title: "VERIFYING AUTHENTICITY",
        body: "Keep your Ledger unlocked while its secure element completes the genuine check.",
      };
    case "verified":
      return {
        eyebrow: "GENUINE CHECK COMPLETE",
        title: "LEDGER VERIFIED",
        body: "The connected device passed Ledger's official authenticity check.",
      };
    case "failed":
      return {
        eyebrow: "CHECK INCOMPLETE",
        title: "LEDGER NOT VERIFIED",
        body: "AgenC could not complete the official genuine check.",
      };
    case "idle":
      return {
        eyebrow: "",
        title: "",
        body: "",
      };
  }
}

export function LedgerVerificationOverlay(): React.ReactNode {
  const snapshot = useSyncExternalStore(
    subscribeLedgerVerification,
    getLedgerVerificationSnapshot,
    getLedgerVerificationSnapshot,
  );
  const visible = snapshot.phase !== "idle";
  useRegisterOverlay("ledger-verification", visible);
  const terminalSize = useTerminalSize();
  const [frame, setFrame] = useState(0);

  useInput((input, key, event) => {
    if (!visible) return;
    if (key.escape || input === "x" || input === "X") {
      event.stopImmediatePropagation();
      dismissLedgerVerification(snapshot.requestId);
    }
  });

  useEffect(() => {
    if (!visible) return;
    if (snapshot.phase === "verified") {
      const timer = setTimeout(
        () => dismissLedgerVerification(snapshot.requestId),
        LEDGER_VERIFIED_AUTO_DISMISS_MS,
      );
      return () => clearTimeout(timer);
    }
    if (snapshot.phase === "waiting" || snapshot.phase === "verifying") {
      const elapsed = Math.max(
        0,
        Date.now() - (snapshot.startedAt ?? Date.now()),
      );
      const timer = setTimeout(
        () =>
          markLedgerVerificationFailed(
            snapshot.requestId,
            "Timed out waiting for the Ledger genuine check. Unlock the device and try again.",
          ),
        Math.max(0, LEDGER_VERIFICATION_TIMEOUT_MS - elapsed),
      );
      return () => clearTimeout(timer);
    }
  }, [
    snapshot.phase,
    snapshot.requestId,
    snapshot.startedAt,
    visible,
  ]);

  useEffect(() => {
    if (snapshot.phase !== "waiting" && snapshot.phase !== "verifying") {
      setFrame(0);
      return;
    }
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % ACTIVE_FRAMES.length);
    }, 180);
    return () => clearInterval(timer);
  }, [snapshot.phase]);

  if (!visible) return null;

  const width = Math.max(42, Math.min(POPUP_WIDTH, terminalSize.columns - 4));
  const left = Math.max(0, Math.floor((terminalSize.columns - width) / 2));
  const top = Math.max(
    1,
    Math.floor((terminalSize.rows - POPUP_ESTIMATED_HEIGHT) / 2),
  );
  const verified = snapshot.phase === "verified";
  const active =
    snapshot.phase === "waiting" || snapshot.phase === "verifying";
  const copy = stateCopy(snapshot.phase);

  return (
    <Box
      position="absolute"
      left={left}
      top={top}
      width={width}
      flexDirection="column"
      borderStyle="single"
      borderColor="#ffffff"
      backgroundColor="#000000"
      opaque
    >
      <Box
        flexDirection="row"
        paddingX={1}
        borderBottom
        borderBottomColor="#333333"
        backgroundColor="#000000"
      >
        <Text color="#ffffff" bold>
          LEDGER AUTHENTICITY
        </Text>
        <Box flexGrow={1} />
        <Box
          paddingLeft={1}
          onClick={(event) => {
            event.stopImmediatePropagation();
            dismissLedgerVerification(snapshot.requestId);
          }}
        >
          <Text color="#ffffff">[×]</Text>
        </Box>
      </Box>

      <Box
        flexDirection="column"
        alignItems="center"
        paddingX={2}
        paddingY={1}
        backgroundColor="#000000"
      >
        <LedgerNanoGraphic verified={verified} />
        <Box marginTop={1}>
          <Text color={verified ? "success" : snapshot.phase === "failed" ? "error" : "#777777"}>
            {active ? ACTIVE_FRAMES[frame] : verified ? "✓" : "!"}
            {"  "}
            {copy.eyebrow}
          </Text>
        </Box>
        <Text color={verified ? "#22c55e" : "#ffffff"} bold>
          {copy.title}
        </Text>
        <Box marginTop={1} justifyContent="center">
          <Text color="#b8b8b8" wrap="wrap">
            {copy.body}
          </Text>
        </Box>
        {snapshot.model ? (
          <Text color="#777777">{`device · ${snapshot.model}`}</Text>
        ) : null}
        {snapshot.phase === "failed" && snapshot.detail ? (
          <Box marginTop={1}>
            <Text color="#ffffff" wrap="wrap">
              {snapshot.detail}
            </Text>
          </Box>
        ) : null}
      </Box>

      <Box
        flexDirection="row"
        paddingX={1}
        borderTop
        borderTopColor="#333333"
        backgroundColor="#000000"
      >
        <Text color="#777777">esc</Text>
        <Text color="#444444"> · </Text>
        <Text color="#777777">close</Text>
        <Box flexGrow={1} />
        {verified ? (
          <Text color="#777777">closing automatically…</Text>
        ) : (
          <Text color="#777777">official wallet-cli genuine-check</Text>
        )}
      </Box>
    </Box>
  );
}
