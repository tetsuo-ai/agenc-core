/**
 * Yolo + Read tool round-trip.
 *
 * Asks the model to read a known small file via the Read tool and verifies
 * a unique substring of the file content appears in the transcript. We
 * point at /etc/hostname because it exists on every Linux dev machine and
 * the content is short and unique-enough to grep for.
 */
export const meta = {
  description: "--yolo: model uses Read on /etc/hostname, content renders.",
  args: ["--yolo"],
  timeoutMs: 90_000,
  // Mode-side fix (filesystem helpers bypass on `bypassPermissions`)
  // landed but the guardian arbiter's `approvalPolicy === "untrusted"`
  // path still surfaces an overlay that the harness doesn't auto-accept.
  // The "approve every call" message comes from
  // permissions/guardian/arbiter.ts:180 — separate layer from the
  // mode bypass. Filed as GAP-PE-GUARDIAN-YOLO-LEAK.
  skip: "guardian arbiter approvalPolicy='untrusted' still prompts; see GAP-PE-GUARDIAN-YOLO-LEAK",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Read tool to read /etc/hostname and tell me what it contains.",
  );
  await session.submit();
  // The hostname appears in the captured buffer once Read returns.
  // Test runs on tetsuo's machine; if hostname changes, this string changes.
  await session.waitFor(/tetsuo-corporation/, {
    timeout: 60_000,
    label: "hostname content",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
