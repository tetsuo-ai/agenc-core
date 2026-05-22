/**
 * Permission overlay accept scenario.
 *
 * Default mode (no --yolo). Submits a prompt that triggers Bash, accepts the
 * approval, then verifies the command actually ran by checking a marker file
 * in an isolated cwd. This avoids coupling the assertion to whether the
 * workbench diff surface or transcript currently owns the visible frame.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const slimCwd = mkdtempSync(path.join(tmpdir(), "agenc-tui-e2e-permission-"));
writeFileSync(path.join(slimCwd, "README.md"), "permission accept cwd\n", "utf8");

const marker = "agenc-permission-accept-marker-3a9c";
const markerFile = "permission-accept-output.txt";
const markerPath = path.join(slimCwd, markerFile);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function waitForMarkerFile({ timeout = 60_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(markerPath)) {
      const text = readFileSync(markerPath, "utf8");
      if (text.includes(marker)) return true;
    }
    await sleep(100);
  }
  return false;
}

async function acceptUntilMarkerFile(session, { timeout = 90_000 } = {}) {
  const started = Date.now();
  let approvals = 0;
  let lastApprovalAt = 0;

  while (Date.now() - started < timeout) {
    if (await waitForMarkerFile({ timeout: 100 })) return;

    const frame = session.text;
    const approvalVisible =
      /enter approve|NEEDS APPROVAL|pending low approval - y approve/i.test(frame);
    const approvalSettled = Date.now() - lastApprovalAt > 1_000;
    if (approvalVisible && approvalSettled && approvals < 6) {
      await session.acceptPermissionOverlay();
      approvals++;
      lastApprovalAt = Date.now();
    }

    await sleep(150);
  }
}

export const meta = {
  description: "Permission overlay (default mode): accept path runs the tool.",
  timeoutMs: 120_000,
  useTempHome: true,
  cwd: slimCwd,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    `Use the Bash tool to run exactly: printf '%s\\n' ${shellQuote(marker)} > ${shellQuote(markerFile)}`,
  );
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await acceptUntilMarkerFile(session, { timeout: 90_000 });
  if (await waitForMarkerFile({ timeout: 100 })) {
    await session.waitForIdle({ timeout: 30_000 });
    return;
  }
  throw new Error(`approved Bash command did not write marker file: ${markerPath}`);
}
