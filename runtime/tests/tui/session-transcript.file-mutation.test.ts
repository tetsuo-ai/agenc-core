import { describe, expect, it } from "vitest";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";
import { normalizeMessages } from "../../src/utils/messages.js";
const event = (id: string, type: string, payload: Record<string, unknown>) => ({ id, type, payload });
const project = (events: any[], _mode: string) => adaptTranscriptEvents(events);
describe.each(["replay"])("Write result metadata through %s", mode => {
  it("retains completed Write mutation metadata for the rendered summary", () => {
    const ui = { kind: "file_mutation", filePath: "calc.py", operation: "write", additions: 15, removals: 2 };
    const transcript = project([
      event("tool", "tool_call_started", { callId: "write", toolName: "Write", args: { file_path: "calc.py", content: "new" } }),
      event("result", "tool_call_completed", { callId: "write", result: "The file calc.py has been updated successfully.", metadata: { ui } }),
    ], mode);
    expect(transcript.messages.find((row: any) => row.type === "user")?.fileMutation).toEqual(ui);
    const normalized = normalizeMessages(transcript.messages as any);
    expect(normalized.find((row: any) => row.type === "user")?.fileMutation).toEqual(ui);
  });

});
