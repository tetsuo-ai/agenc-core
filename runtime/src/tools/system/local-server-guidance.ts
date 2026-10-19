/** Delivered only after a server-related tool result, never in initial Light summaries. */
export const LOCAL_BINDING_GUIDANCE =
  "The user can instead enable sandbox.network.allowLocalBinding = true; on Linux, start and test the server in the same command (private loopback, unreachable from the host browser).";

export const LOCAL_SERVER_GUIDANCE =
  "Local previews: explain that you will start a server and give its URL. The sandbox blocks local binding by default. " +
  "If permitted, request one launch with sandbox_permissions=\"require_escalated\" and a plain-language justification explaining why the preview needs it. " +
  "detach=true works only outside the sandbox (including an approved escalated launch); otherwise keep the server in the foreground with yield_time_ms. " +
  LOCAL_BINDING_GUIDANCE + " " +
  "Check an escalated server's URL with the same sandbox_permissions, since sandbox loopback may be isolated.";

export const PROCESS_DISCOVERY_GUIDANCE =
  "Linux sandbox commands can have a private PID namespace: ps/pgrep may not see servers outside it. " +
  "Use list_processes for this conversation's managed sessions; its inventory does not survive a daemon restart and excludes detached services. " +
  "Before starting another server, check its known URL with the same sandbox_permissions used to launch it; an empty process list does not prove it stopped.";
