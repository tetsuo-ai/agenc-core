function normalizeFeatureToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function parseFeatureSet(value) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => normalizeFeatureToken(entry))
      .filter(Boolean),
  );
}

function featureEnabled(featureSet, key) {
  return featureSet.has(key) || featureSet.has(`watch.${key}`);
}

function parseBooleanOverride(value) {
  if (value == null) {
    return null;
  }
  const normalized = normalizeFeatureToken(value);
  if (!normalized) {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

export function resolveWatchFeatureFlags({ env = process.env } = {}) {
  const enabled = parseFeatureSet(env.AGENC_WATCH_FEATURES);
  const disabled = parseFeatureSet(env.AGENC_WATCH_DISABLE_FEATURES);
  const explicitStatusline = parseBooleanOverride(env.AGENC_WATCH_ENABLE_STATUSLINE);
  const explicitReviewModes = parseBooleanOverride(env.AGENC_WATCH_ENABLE_REVIEW_MODES);
  const explicitCheckpoints = parseBooleanOverride(env.AGENC_WATCH_ENABLE_CHECKPOINTS);
  const explicitDiffReview = parseBooleanOverride(env.AGENC_WATCH_ENABLE_DIFF_REVIEW);
  const explicitCompactionControls = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_COMPACTION_CONTROLS,
  );
  const explicitPermissionsControls = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_PERMISSIONS_CONTROLS,
  );
  const explicitAttachments = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_ATTACHMENTS,
  );
  const explicitExportBundles = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_EXPORT_BUNDLES,
  );
  const explicitInsights = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_INSIGHTS,
  );
  const explicitThreadSwitcher = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_THREAD_SWITCHER,
  );
  const explicitSessionIndexing = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_SESSION_INDEXING,
  );
  const explicitRerunFromTrace = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_RERUN_FROM_TRACE,
  );
  const explicitRemoteTools = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_REMOTE_TOOLS,
  );
  const explicitExtensibilityHub = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_EXTENSIBILITY_HUB,
  );
  const explicitInputModes = parseBooleanOverride(
    env.AGENC_WATCH_ENABLE_INPUT_MODES,
  );

  let statusline = featureEnabled(enabled, "statusline");
  if (featureEnabled(disabled, "statusline")) {
    statusline = false;
  }
  if (explicitStatusline != null) {
    statusline = explicitStatusline;
  }

  let reviewModes =
    featureEnabled(enabled, "review_modes") ||
    featureEnabled(enabled, "reviewmodes");
  if (
    featureEnabled(disabled, "review_modes") ||
    featureEnabled(disabled, "reviewmodes")
  ) {
    reviewModes = false;
  }
  if (explicitReviewModes != null) {
    reviewModes = explicitReviewModes;
  }

  let checkpoints =
    featureEnabled(enabled, "checkpoints") ||
    featureEnabled(enabled, "checkpointing");
  if (
    featureEnabled(disabled, "checkpoints") ||
    featureEnabled(disabled, "checkpointing")
  ) {
    checkpoints = false;
  }
  if (explicitCheckpoints != null) {
    checkpoints = explicitCheckpoints;
  }

  let diffReview =
    featureEnabled(enabled, "diff_review") ||
    featureEnabled(enabled, "diffreview");
  if (
    featureEnabled(disabled, "diff_review") ||
    featureEnabled(disabled, "diffreview")
  ) {
    diffReview = false;
  }
  if (explicitDiffReview != null) {
    diffReview = explicitDiffReview;
  }

  let compactionControls =
    featureEnabled(enabled, "compaction_controls") ||
    featureEnabled(enabled, "compactioncontrols");
  if (
    featureEnabled(disabled, "compaction_controls") ||
    featureEnabled(disabled, "compactioncontrols")
  ) {
    compactionControls = false;
  }
  if (explicitCompactionControls != null) {
    compactionControls = explicitCompactionControls;
  }

  let permissionsControls =
    featureEnabled(enabled, "permissions_controls") ||
    featureEnabled(enabled, "permissionscontrols");
  if (
    featureEnabled(disabled, "permissions_controls") ||
    featureEnabled(disabled, "permissionscontrols")
  ) {
    permissionsControls = false;
  }
  if (explicitPermissionsControls != null) {
    permissionsControls = explicitPermissionsControls;
  }

  let attachments =
    featureEnabled(enabled, "attachments") ||
    featureEnabled(enabled, "attachment_queue");
  if (
    featureEnabled(disabled, "attachments") ||
    featureEnabled(disabled, "attachment_queue")
  ) {
    attachments = false;
  }
  if (explicitAttachments != null) {
    attachments = explicitAttachments;
  }

  let exportBundles =
    featureEnabled(enabled, "export_bundles") ||
    featureEnabled(enabled, "exportbundles");
  if (
    featureEnabled(disabled, "export_bundles") ||
    featureEnabled(disabled, "exportbundles")
  ) {
    exportBundles = false;
  }
  if (explicitExportBundles != null) {
    exportBundles = explicitExportBundles;
  }

  let insights = featureEnabled(enabled, "insights");
  if (featureEnabled(disabled, "insights")) {
    insights = false;
  }
  if (explicitInsights != null) {
    insights = explicitInsights;
  }

  let threadSwitcher =
    featureEnabled(enabled, "thread_switcher") ||
    featureEnabled(enabled, "threadswitcher");
  if (
    featureEnabled(disabled, "thread_switcher") ||
    featureEnabled(disabled, "threadswitcher")
  ) {
    threadSwitcher = false;
  }
  if (explicitThreadSwitcher != null) {
    threadSwitcher = explicitThreadSwitcher;
  }

  let sessionIndexing =
    featureEnabled(enabled, "session_indexing") ||
    featureEnabled(enabled, "sessionindexing");
  if (
    featureEnabled(disabled, "session_indexing") ||
    featureEnabled(disabled, "sessionindexing")
  ) {
    sessionIndexing = false;
  }
  if (explicitSessionIndexing != null) {
    sessionIndexing = explicitSessionIndexing;
  }

  let rerunFromTrace =
    featureEnabled(enabled, "rerun_from_trace") ||
    featureEnabled(enabled, "rerunfromtrace") ||
    featureEnabled(enabled, "run_recovery") ||
    featureEnabled(enabled, "runrecovery");
  if (
    featureEnabled(disabled, "rerun_from_trace") ||
    featureEnabled(disabled, "rerunfromtrace") ||
    featureEnabled(disabled, "run_recovery") ||
    featureEnabled(disabled, "runrecovery")
  ) {
    rerunFromTrace = false;
  }
  if (explicitRerunFromTrace != null) {
    rerunFromTrace = explicitRerunFromTrace;
  }

  let remoteTools =
    featureEnabled(enabled, "remote_tools") ||
    featureEnabled(enabled, "remotetools");
  if (
    featureEnabled(disabled, "remote_tools") ||
    featureEnabled(disabled, "remotetools")
  ) {
    remoteTools = false;
  }
  if (explicitRemoteTools != null) {
    remoteTools = explicitRemoteTools;
  }

  let extensibilityHub =
    featureEnabled(enabled, "extensibility_hub") ||
    featureEnabled(enabled, "extensibilityhub");
  if (
    featureEnabled(disabled, "extensibility_hub") ||
    featureEnabled(disabled, "extensibilityhub")
  ) {
    extensibilityHub = false;
  }
  if (explicitExtensibilityHub != null) {
    extensibilityHub = explicitExtensibilityHub;
  }

  let inputModes = true;
  if (
    featureEnabled(enabled, "input_modes") ||
    featureEnabled(enabled, "inputmodes")
  ) {
    inputModes = true;
  }
  if (
    featureEnabled(disabled, "input_modes") ||
    featureEnabled(disabled, "inputmodes")
  ) {
    inputModes = false;
  }
  if (explicitInputModes != null) {
    inputModes = explicitInputModes;
  }

  return {
    statusline,
    reviewModes,
    checkpoints,
    diffReview,
    compactionControls,
    permissionsControls,
    attachments,
    exportBundles,
    insights,
    threadSwitcher,
    sessionIndexing,
    rerunFromTrace,
    remoteTools,
    extensibilityHub,
    inputModes,
  };
}
