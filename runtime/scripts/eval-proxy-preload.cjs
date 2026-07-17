// Overlay-staged preload for the real-model lane. Injected via
// `NODE_OPTIONS=--require` into the agent CLI AND the daemon it spawns
// (NODE_OPTIONS is inherited by child processes). It installs the undici
// global proxy dispatcher from HTTPS_PROXY so the HEADLESS daemon routes its
// model calls through the egress proxy.
//
// Why this is needed: the runtime installs its proxy dispatcher
// (`configureGlobalAgents`) only on the interactive TUI path, not in the
// daemon/print (`-p`) path, so a headless agent otherwise ignores
// HTTPS_PROXY and attempts a direct connection — which the egress lane's
// blackholed resolver correctly refuses. Fixing that in the runtime would
// let this preload be dropped.
try {
  const undici = require("/agenc-overlay/runtime/node_modules/undici");
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
  if (proxy && typeof undici.EnvHttpProxyAgent === "function") {
    undici.setGlobalDispatcher(
      new undici.EnvHttpProxyAgent({
        httpsProxy: proxy,
        httpProxy: proxy,
        noProxy: process.env.NO_PROXY || process.env.no_proxy,
      }),
    );
  }
} catch (err) {
  // Best-effort: if the dispatcher cannot be installed the agent simply
  // cannot reach the provider and the run fails closed (never leaks).
  process.stderr.write(`eval-proxy-preload: ${err && err.message}\n`);
}
