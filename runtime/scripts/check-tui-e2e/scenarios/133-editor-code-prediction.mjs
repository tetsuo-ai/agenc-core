import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_CODE_PREDICTION_LOG_FILENAME,
  MOCK_CODE_PREDICTION_TEXT,
  MOCK_CODE_PREDICTION_TRIGGER,
  MOCK_MODEL,
} from "../../local-openai-compatible-mock.mjs";
import {
  frameText,
  waitForFrameText,
  waitForScreen,
} from "../helpers/workbench-buffer-neovim.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description:
    "First-use prediction consent persists and reloads the daemon, then a tool-free provider call paints and accepts Neovim ghost text.",
  args: ["--yolo"],
  firstUsePredictionConsent: true,
  timeoutMs: 90_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "neovim",
    AGENC_BUFFER_NVIM_USE_INIT: "0",
    AGENC_OAUTH_TOKEN: "test-editor-prediction-token",
    AGENC_TUI_E2E_RECORD_MOCK_PREDICTIONS: "1",
  },
};

export default async function (session) {
  session.cols = 110;
  session.rows = 32;

  const sourcePath = join(session.cwd, "prediction.ts");
  await writeFile(sourcePath, "// hermetic prediction fixture\n", "utf8");

  await session.start();
  await session.waitForPrompt({ timeout: 20_000 });
  session.send("\x1b2");
  await waitForScreen(
    session,
    /No file selected|embedded\s*Neovim|NORMAL\s*:w/iu,
    {
      timeout: 10_000,
      label: "Editor prediction surface",
    },
  );

  let openedPredictionFromExplorer = false;
  if (/No file selected/u.test(frameText(session))) {
    session.send("\x18");
    await sleep(80);
    session.send("h");
    await sleep(100);
    session.send("\x1b[B");
    session.send("\r");
    openedPredictionFromExplorer = true;
  }
  await waitForFrameText(
    session,
    /embedded Neovim[^\n]*normal,\s*ready/iu,
    "Editor prediction provider ready",
    20_000,
  );
  if (
    !openedPredictionFromExplorer ||
    !/hermetic prediction fixture/u.test(frameText(session))
  ) {
    session.send(":");
    await sleep(80);
    await session.type("e prediction.ts", { perCharMs: 12 });
    session.send("\r");
  }
  await waitForScreen(session, /embedded\s*Neovim|NORMAL\s*:w/iu, {
    timeout: 20_000,
    label: "Editor prediction embedded Neovim",
  });
  await waitForFrameText(
    session,
    /hermetic prediction fixture/u,
    "prediction fixture opened in Neovim",
    15_000,
  );

  const agencHome = session.runtimeEnv?.AGENC_HOME;
  if (typeof agencHome !== "string" || agencHome.length === 0) {
    throw new Error("prediction scenario has no private AGENC_HOME");
  }
  const daemonPidPath = join(agencHome, "daemon.pid");
  const daemonPidBeforeConsent = await readFile(daemonPidPath, "utf8");

  // Enter insert mode. The first eligible prediction must stop at the
  // ask-mode consent boundary before any model request is dispatched.
  await session.type("Go", { perCharMs: 40 });
  // Ordinary insert-mode text remains routed to Neovim while the consent card
  // is appearing. Finish the deterministic prefix before the debounce window
  // so enabling prediction produces one request for the settled revision.
  await session.type(`const ${MOCK_CODE_PREDICTION_TRIGGER} = `, {
    perCharMs: 2,
  });
  await waitForFrameText(
    session,
    /Enable editor code predictions\?/u,
    "first-use prediction consent",
    15_000,
  );
  const predictionReceiptPath = join(
    agencHome,
    MOCK_CODE_PREDICTION_LOG_FILENAME,
  );
  await assertFileAbsent(
    predictionReceiptPath,
    "prediction provider request before consent",
  );

  // Consent requires an explicit Alt-modified choice so ordinary insert-mode
  // text can never silently authorize source disclosure.
  session.send("\x1by");
  const configPath = join(agencHome, "config.toml");
  await waitForFile(
    configPath,
    /\[(?:"buffer"|buffer)\.(?:"prediction"|prediction)\][\s\S]*?"?enabled"?\s*=\s*"on"/u,
    "persisted prediction consent",
    15_000,
  );
  await waitForFrameAbsence(
    session,
    /Enable editor code predictions\?/u,
    "dismissed prediction consent",
    15_000,
  );

  // The daemon-global config snapshot must reload in place. A restart would
  // break the active TUI session and does not prove the live reload contract.
  const daemonPidAfterConsent = await readFile(daemonPidPath, "utf8");
  if (daemonPidAfterConsent !== daemonPidBeforeConsent) {
    throw new Error(
      `prediction consent restarted the daemon: before=${daemonPidBeforeConsent.trim()} after=${daemonPidAfterConsent.trim()}`,
    );
  }

  const receipts = await waitForPredictionReceipt(
    predictionReceiptPath,
    15_000,
  );
  const triggered = receipts.find((receipt) => receipt.hasTrigger === true);
  if (
    triggered?.kind !== "code_prediction" ||
    triggered.model !== MOCK_MODEL ||
    triggered.toolCount !== 0 ||
    JSON.stringify(triggered.messageRoles) !==
      JSON.stringify(["system", "user"])
  ) {
    throw new Error(
      `prediction provider request was not isolated: ${JSON.stringify(triggered ?? receipts)}`,
    );
  }
  const ghostPainted = await waitForFramePresence(
    session,
    /PREDICTION_E2E_ACCEPTED/u,
    10_000,
  );

  const rolloutItems = await session.readRolloutItems();
  if (JSON.stringify(rolloutItems).includes(MOCK_CODE_PREDICTION_TEXT)) {
    throw new Error("prediction text leaked into the Agent rollout transcript");
  }

  // Tab accepts the complete staged prediction. Saving after leaving insert
  // mode distinguishes accepted buffer text from a merely painted extmark.
  session.send("\t");
  await sleep(250);
  session.send("\x1b");
  await waitForFrameText(
    session,
    /embedded Neovim[^\n]*normal,\s*ready/iu,
    "normal mode after prediction acceptance",
    10_000,
  );
  session.send(":");
  await sleep(80);
  await session.type("w", { perCharMs: 20 });
  session.send("\r");
  await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
  await waitForFile(
    sourcePath,
    new RegExp(
      `const ${MOCK_CODE_PREDICTION_TRIGGER} = ${escapeRegExp(MOCK_CODE_PREDICTION_TEXT)}`,
      "u",
    ),
    "accepted prediction saved from Neovim",
    15_000,
  );
  if (!ghostPainted) {
    throw new Error(
      "prediction was accepted into Neovim but its ghost text never painted in the PTY frame",
    );
  }
}

async function waitForFile(path, pattern, label, timeoutMs) {
  const startedAt = Date.now();
  let last = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await readFile(path, "utf8");
      if (pattern.test(last)) return last;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(100);
  }
  throw new Error(`${label}: ${path} never matched ${pattern}; last=${last}`);
}

async function assertFileAbsent(path, label) {
  try {
    const contents = await readFile(path, "utf8");
    throw new Error(`${label}: unexpected ${path}: ${contents}`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function waitForFrameAbsence(session, pattern, label, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pattern.test(frameText(session))) return;
    await sleep(100);
  }
  throw new Error(`${label}: frame still matched ${pattern}`);
}

async function waitForFramePresence(session, pattern, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(frameText(session))) return true;
    await sleep(100);
  }
  return false;
}

async function waitForPredictionReceipt(path, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const receipts = (await readFile(path, "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (receipts.some((receipt) => receipt.hasTrigger === true)) {
        return receipts;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(100);
  }
  throw new Error(`prediction mock receipt never appeared: ${path}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
