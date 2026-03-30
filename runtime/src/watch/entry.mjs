import { runWatchApp as defaultRunWatchApp } from "./agenc-watch-app.mjs";

function applyDefaultWatchCliEnvironment(env) {
  if (!env || typeof env !== "object") {
    return;
  }
  if (env.AGENC_WATCH_ENABLE_ATTACHMENTS == null) {
    env.AGENC_WATCH_ENABLE_ATTACHMENTS = "true";
  }
}

export async function runAgencWatchCli({ runWatchApp = defaultRunWatchApp, processLike = process } = {}) {
  try {
    applyDefaultWatchCliEnvironment(processLike?.env ?? process.env);
    const exitCode = await runWatchApp();
    processLike.exit(typeof exitCode === "number" ? exitCode : 0);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    processLike.stderr.write(`${message}\n`);
    processLike.exit(1);
  }
}
