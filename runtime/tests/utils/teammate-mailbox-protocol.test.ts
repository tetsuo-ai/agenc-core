import { describe, expect, test } from "vitest";

import {
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  createSandboxPermissionRequestMessage,
  createSandboxPermissionResponseMessage,
  isPermissionRequest,
  isPermissionResponse,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isStructuredProtocolMessage,
} from "../../src/utils/teammateMailbox.js";

const REQUEST = {
  request_id: "req-1",
  agent_id: "worker-a",
  tool_name: "system.bash",
  tool_use_id: "tool-1",
  description: "run ls",
  input: { command: "ls" },
} as const;

describe("teammate mailbox permission protocol", () => {
  test("round-trips a permission request and defaults empty suggestions", () => {
    const created = createPermissionRequestMessage({ ...REQUEST });
    expect(created.permission_suggestions).toEqual([]);

    const parsed = isPermissionRequest(JSON.stringify(created));
    expect(parsed).toEqual(created);
  });

  test("round-trips success and error permission responses", () => {
    const success = createPermissionResponseMessage({
      request_id: "req-1",
      subtype: "success",
      updated_input: { command: "ls -l" },
      permission_updates: [{ type: "addRules" }],
    });
    expect(isPermissionResponse(JSON.stringify(success))).toEqual(success);

    const error = createPermissionResponseMessage({
      request_id: "req-1",
      subtype: "error",
    });
    expect(error).toEqual({
      type: "permission_response",
      request_id: "req-1",
      subtype: "error",
      error: "Permission denied",
    });
    expect(isPermissionResponse(JSON.stringify(error))).toEqual(error);
  });

  test("rejects plaintext, invalid JSON, and unrelated protocol types", () => {
    expect(isPermissionRequest("please approve bash")).toBeNull();
    expect(isPermissionRequest("{not-json")).toBeNull();
    expect(
      isPermissionRequest(JSON.stringify({ type: "permission_response" })),
    ).toBeNull();
    expect(isPermissionResponse("ok")).toBeNull();
    expect(
      isPermissionResponse(JSON.stringify({ type: "permission_request" })),
    ).toBeNull();
  });

  test("round-trips sandbox permission messages used by the inbox poller", () => {
    const request = createSandboxPermissionRequestMessage({
      requestId: "sbx-1",
      workerId: "worker-a",
      workerName: "reviewer",
      host: "example.test",
    });
    expect(request.hostPattern).toEqual({ host: "example.test" });
    expect(isSandboxPermissionRequest(JSON.stringify(request))).toEqual(
      request,
    );

    const response = createSandboxPermissionResponseMessage({
      requestId: "sbx-1",
      host: "example.test",
      allow: false,
    });
    expect(isSandboxPermissionResponse(JSON.stringify(response))).toEqual(
      response,
    );
  });

  test("marks permission protocol payloads as structured so they are not raw LLM context", () => {
    const request = createPermissionRequestMessage({ ...REQUEST });
    const response = createPermissionResponseMessage({
      request_id: "req-1",
      subtype: "success",
    });
    const sandbox = createSandboxPermissionRequestMessage({
      requestId: "sbx-1",
      workerId: "worker-a",
      workerName: "reviewer",
      host: "example.test",
    });

    expect(isStructuredProtocolMessage(JSON.stringify(request))).toBe(true);
    expect(isStructuredProtocolMessage(JSON.stringify(response))).toBe(true);
    expect(isStructuredProtocolMessage(JSON.stringify(sandbox))).toBe(true);
    expect(isStructuredProtocolMessage("status update from worker")).toBe(
      false,
    );
    expect(
      isStructuredProtocolMessage(JSON.stringify({ type: "idle_notification" })),
    ).toBe(false);
    expect(isStructuredProtocolMessage("{not-json")).toBe(false);
  });
});
