export async function loadContextCollapseModule() {
  const module = await import("./compact-runtime.js");
  return {
    applyCollapsesIfNeeded: module.applyCollapsesIfNeeded,
    recoverFromOverflow: module.recoverFromOverflow,
  };
}

export async function loadAutoCompactModule() {
  const module = await import("../../services/compact/autoCompact.js");
  return {
    autoCompactIfNeeded: module.autoCompactIfNeeded,
  };
}

export async function loadCompactModule() {
  const module = await import("../../services/compact/compact.js");
  return {
    buildPostCompactMessages: module.buildPostCompactMessages,
  };
}

export async function loadMicroCompactModule() {
  const module = await import("../../services/compact/microCompact.js");
  return {
    microcompactMessages: module.microcompactMessages,
    resetMicrocompactState: module.resetMicrocompactState,
  };
}

export async function loadToolResultStorageModule() {
  const module = await import("./compact-runtime.js");
  return {
    applyToolResultBudget: module.applyToolResultBudget,
  };
}

export async function loadMessageUtilityModule() {
  const module = await import("../../services/compact/compact.js");
  return {
    createSyntheticUserCaveatMessage: module.createSyntheticUserCaveatMessage,
    createUserMessage: module.createUserMessage,
    formatCommandInputTags: module.formatCommandInputTags,
  };
}

export async function loadManualCompactCommand() {
  const module = await import("../../services/compact/compact.js");
  return {
    call: module.manualCompactCall,
  };
}

export async function loadContextNonInteractiveCommand() {
  const module = await import("./compact-runtime.js");
  return {
    call: module.contextUsageCall,
  };
}
