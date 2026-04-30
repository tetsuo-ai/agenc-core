export async function enableUpstreamConfigGate() {
  const module = await import("../upstream/utils/config.js");
  module.enableConfigs();
}

export async function loadContextCollapseModule() {
  const module = await import("../upstream/services/contextCollapse/index.js");
  return {
    applyCollapsesIfNeeded: module.applyCollapsesIfNeeded,
    recoverFromOverflow: module.recoverFromOverflow,
  };
}

export async function loadAutoCompactModule() {
  const module = await import("../upstream/services/compact/autoCompact.js");
  return {
    autoCompactIfNeeded: module.autoCompactIfNeeded,
  };
}

export async function loadCompactModule() {
  const module = await import("../upstream/services/compact/compact.js");
  return {
    buildPostCompactMessages: module.buildPostCompactMessages,
  };
}

export async function loadManualCompactCommand() {
  const module = await import("../upstream/commands/compact/compact.js");
  return {
    call: module.call,
  };
}

export async function loadContextNonInteractiveCommand() {
  const module = await import("../upstream/commands/context/context-noninteractive.js");
  return {
    call: module.call,
  };
}
