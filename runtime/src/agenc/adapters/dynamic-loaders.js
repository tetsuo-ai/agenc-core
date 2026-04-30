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

export async function loadMicroCompactModule() {
  const module = await import("../upstream/services/compact/microCompact.js");
  return {
    microcompactMessages: module.microcompactMessages,
    resetMicrocompactState: module.resetMicrocompactState,
  };
}

export async function loadToolResultStorageModule() {
  const module = await import("../upstream/utils/toolResultStorage.js");
  return {
    applyToolResultBudget: module.applyToolResultBudget,
  };
}

export async function loadPromptContextModules() {
  const prompts = await import("../upstream/constants/prompts.js");
  const context = await import("../upstream/context.js");
  const systemPrompt = await import("../upstream/utils/systemPrompt.js");
  return {
    getSystemPrompt: prompts.getSystemPrompt,
    getUserContext: context.getUserContext,
    getSystemContext: context.getSystemContext,
    buildEffectiveSystemPrompt: systemPrompt.buildEffectiveSystemPrompt,
  };
}

export async function loadMessageUtilityModule() {
  const module = await import("../upstream/utils/messages.js");
  return {
    createSyntheticUserCaveatMessage: module.createSyntheticUserCaveatMessage,
    createUserMessage: module.createUserMessage,
    formatCommandInputTags: module.formatCommandInputTags,
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
