/** Exploratory guarded entry. No foreground dependency evaluates before ADMIT. */
import {
  createAgenCDaemonStartupGuardReceiver, takeAgenCDaemonStartupGuardToken,
} from "../app-server/daemon-startup-guard.js";
import {
  AGENC_DAEMON_PROVISIONAL_ENV, createAgenCProvisionalAdmissionReceiver,
  type AgenCProvisionalChannel,
} from "../app-server/daemon-provisional-admission.js";

export async function runProvisionalDaemonChildEntry(): Promise<void> {
  const token = takeAgenCDaemonStartupGuardToken(process.env);
  delete process.env[AGENC_DAEMON_PROVISIONAL_ENV];
  if (token === undefined || typeof process.send !== "function") throw new Error("provisional daemon requires private IPC");
  const channel: AgenCProvisionalChannel = {
    isConnected: () => process.connected === true,
    addMessageListener: (fn) => { process.on("message", fn); },
    removeMessageListener: (fn) => { process.off("message", fn); },
    addCloseListener: (fn) => { process.on("disconnect", fn); },
    removeCloseListener: (fn) => { process.off("disconnect", fn); },
    send: (message) => new Promise<void>((resolve, reject) => {
      if (!process.connected || !process.send) { reject(new Error("provisional IPC closed")); return; }
      process.send(message as never, (error: Error | null) => error === null ? resolve() : reject(error));
    }),
    close: () => { if (process.connected) process.disconnect?.(); },
    unref: () => { process.channel?.unref(); },
  };
  // Install both endpoints before any control/runtime import. A late receiver
  // observes current connection state, not just a possibly missed event.
  const admission = createAgenCProvisionalAdmissionReceiver(token, channel, 45_000);
  const guard = createAgenCDaemonStartupGuardReceiver(token, channel);
  void guard.requested.then(() => admission.abort());
  const { runCliProcessMain } = await import("./cli-process-main.js");
  await runCliProcessMain(async () => {
    const { prepareCliRuntime } = await import("./cli-runtime.js");
    const ingress = prepareCliRuntime();
    if (ingress !== null) return ingress;
    const control = await import("../app-server/daemon-control.js");
    const host = { ...control.createNodeDaemonCliHost(), startupGuardReceiver: guard };
    const release = await control.acquireAgenCDaemonLifecycleLock(host, undefined, 1_000);
    let released = false;
    const releaseOnce = async (): Promise<void> => {
      if (released) return;
      await release();
      released = true;
    };
    let handedOff = false;
    try {
      const decision = await admission.decision;
      if (decision.kind !== "admitted" || guard.wasRequested()) {
        await control.removeAgenCDaemonPid(control.resolveAgenCDaemonPidPath(host.env, host.userHome), host.pid);
        await releaseOnce();
        await guard.acknowledgeAfterCleanup(true).catch(() => {});
        return 1;
      }
      await channel.send({ type: "agenc.daemon.provisional.admitted", version: 1, token });
      handedOff = true;
      // The wrapper dynamically imports foreground only here. It receives
      // this very lock, with its existing final publication/cleanup barrier.
      return await control.runAgenCDaemonCli({ kind: "command", action: "run" }, {
        host, enterDaemonHome: true, releaseProvisionalLifecycleLock: releaseOnce,
      });
    } finally {
      await releaseOnce();
      if (!handedOff) admission.close();
    }
  });
}
