import type { AgenCRealtimeTuiControls } from "./controller.js";

export type RealtimeComposerCommand =
  | { readonly kind: "toggle" }
  | { readonly kind: "start"; readonly transport: "websocket" | "webrtc" }
  | { readonly kind: "stop" }
  | { readonly kind: "mute"; readonly muted: boolean }
  | { readonly kind: "push_to_talk"; readonly enabled: boolean }
  | { readonly kind: "push_to_talk_held"; readonly held: boolean }
  | { readonly kind: "text"; readonly text: string };

export function parseRealtimeComposerCommand(
  input: string,
): RealtimeComposerCommand | null {
  const trimmed = input.trim();
  if (trimmed !== "/realtime" && !trimmed.startsWith("/realtime ")) {
    return null;
  }
  const rest = trimmed.slice("/realtime".length).trim();
  if (rest.length === 0) return { kind: "toggle" };
  if (rest === "start") {
    return { kind: "start", transport: "websocket" };
  }
  if (rest === "webrtc" || rest === "start webrtc") {
    return { kind: "start", transport: "webrtc" };
  }
  if (rest === "stop") return { kind: "stop" };
  if (rest === "mute") return { kind: "mute", muted: true };
  if (rest === "unmute") return { kind: "mute", muted: false };
  if (rest === "ptt" || rest === "ptt on") {
    return { kind: "push_to_talk", enabled: true };
  }
  if (rest === "ptt off") {
    return { kind: "push_to_talk", enabled: false };
  }
  if (rest === "ptt hold") {
    return { kind: "push_to_talk_held", held: true };
  }
  if (rest === "ptt release") {
    return { kind: "push_to_talk_held", held: false };
  }
  if (rest.startsWith("text ")) {
    const text = rest.slice("text ".length).trim();
    if (text.length > 0) return { kind: "text", text };
  }
  return null;
}

export async function executeRealtimeComposerCommand(
  controls: AgenCRealtimeTuiControls | undefined,
  input: string,
): Promise<boolean> {
  const command = parseRealtimeComposerCommand(input);
  if (command === null) return false;
  if (controls === undefined) return false;
  switch (command.kind) {
    case "toggle":
      if (controls.getState().phase === "inactive") {
        await controls.start({ transport: "websocket" });
      } else {
        await controls.stop();
      }
      return true;
    case "start":
      await controls.start({ transport: command.transport });
      return true;
    case "stop":
      await controls.stop();
      return true;
    case "mute":
      controls.setMuted(command.muted);
      return true;
    case "push_to_talk":
      controls.setPushToTalk(command.enabled);
      return true;
    case "push_to_talk_held":
      controls.setPushToTalkHeld(command.held);
      return true;
    case "text":
      await controls.appendText(command.text);
      return true;
  }
}
