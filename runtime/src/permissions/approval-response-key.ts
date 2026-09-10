import { randomUUID } from "node:crypto";
import { consumeExitPlanModeApproval } from "../planning/exit-plan-approval.js";
import { dropAskUserQuestionResponse } from "../tools/ask-user-question/tool.js";

const responseKeys = new WeakMap<object, Map<string, string>>();

export function bindApprovalResponseKey(session: object, callId: string): string {
  let keys = responseKeys.get(session);
  if (keys === undefined) {
    keys = new Map();
    responseKeys.set(session, keys);
  }
  const existing = keys.get(callId);
  if (existing !== undefined) return existing;
  const key = `approval-response:${randomUUID()}`;
  keys.set(callId, key);
  return key;
}

export function approvalResponseKey(session: object, callId: string): string {
  return responseKeys.get(session)?.get(callId) ?? callId;
}

export function clearApprovalResponseKey(session: object, callId: string): void {
  const keys = responseKeys.get(session);
  if (keys === undefined) return;
  const key = keys?.get(callId);
  if (key === undefined) return;
  consumeExitPlanModeApproval({ __callId: key });
  dropAskUserQuestionResponse(key);
  keys.delete(callId);
  if (keys.size === 0) responseKeys.delete(session);
}
