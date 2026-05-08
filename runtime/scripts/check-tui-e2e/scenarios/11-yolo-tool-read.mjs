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
  // Permission overlay fires under --yolo for Read on paths outside cwd
  // (e.g. /etc/hostname). The TUI shows "untrusted policy: approve every
  // call" with a 1/2/3 prompt and blocks waiting for a key — but --yolo
  // is documented to bypass approvals. Bash and Grep on the same paths
  // do NOT prompt under --yolo, suggesting tool-specific policy drift.
  // Filed as GAP-PE-YOLO-LEAK.
  skip: "blocked on --yolo permission-overlay leak for Read; see GAP-PE-YOLO-LEAK",
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
