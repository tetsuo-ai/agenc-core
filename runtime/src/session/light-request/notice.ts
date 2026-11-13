import type { Session } from "../session.js";
import { resolveLightRequest } from "./settings.js";

const announced = new WeakMap<Session, string>();

/** Visible in both the TUI and headless events, once per effective setting. */
export function announceLightRequest(session: Session): void {
  const lean = resolveLightRequest(session, session.services.provider.name);
  const signature = JSON.stringify(lean ?? null);
  if (announced.get(session) === signature) return;
  announced.set(session, signature);
  if (lean === undefined) return;
  const details = [
    "Lean Light request is active.",
    ...(lean.core_tools_only ? ["The initial tool set is shell, read, write and patch; explicitly loaded tools stay available."] : []),
    ...(!lean.tool_search ? ["Tool search is off. Use light_request=full or light_request_options.tool_search=true for skill, web, agent and MCP discovery."] : []),
    ...(!lean.process_tools ? ["Process controls are off; commands stop after at most 29 seconds."] : []),
    ...(lean.edit_mode === "shell" ? ["Files are written with shell commands; Write and apply_patch are not listed."] : []),
    ...(lean.edit_mode === "check" ? ["Write and apply_patch take a required check command that runs after the edit."] : []),
    ...(lean.low_effort ? ["Unchosen reasoning effort defaults to low."] : []),
  ];
  session.emit({ id: session.nextInternalSubId(), msg: { type: "warning", payload: {
    cause: "light_request", message: details.join(" "),
  } } });
}
