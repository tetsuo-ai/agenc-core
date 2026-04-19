function insetBlock(lines = [], inset = 2) {
  const prefix = " ".repeat(Math.max(0, Number(inset) || 0));
  return (Array.isArray(lines) ? lines : []).map((line) => `${prefix}${line}`);
}

export function createWatchSplashRenderer(dependencies = {}) {
  const {
    watchState,
    transportState,
    events,
    introDismissKinds,
    currentInputValue,
    launchedAtMs,
    startupSplashMinMs,
    shouldShowWatchSplash,
    nowMs = () => Date.now(),
    toneColor,
    fitAnsi,
    truncate,
    sanitizeInlineText,
    color,
  } = dependencies;

  function shouldShowSplash() {
    // Single-pass, early-return scan for the first non-status event in
    // the intro-dismiss set. Previously this built an intermediate
    // kinds array on every render (O(n) map + filter); the splash
    // renderer fires at 30Hz during streaming so a 500-event history
    // walked the whole list per frame just to answer a boolean.
    let hasNonStatusDismissEvent = false;
    for (let index = 0; index < events.length; index += 1) {
      const kind = events[index]?.kind;
      if (introDismissKinds.has(kind) && kind !== "status") {
        hasNonStatusDismissEvent = true;
        break;
      }
    }
    return shouldShowWatchSplash({
      introDismissed: watchState.introDismissed,
      currentObjective: watchState.currentObjective,
      inputValue: currentInputValue(),
      bootstrapReady: watchState.bootstrapReady,
      launchedAtMs,
      startupSplashMinMs,
      eventKinds: hasNonStatusDismissEvent ? ["__non_status_dismiss"] : [],
      nowMs: nowMs(),
    });
  }

  function statusLabel() {
    if (watchState.bootstrapReady && transportState.connectionState === "live") {
      return "Ready";
    }
    if (transportState.connectionState === "reconnecting") {
      return "Reconnecting";
    }
    return "Connecting";
  }

  function splashDetailText() {
    if (watchState.bootstrapReady) {
      return sanitizeInlineText(
        watchState.transientStatus || "Ready to work in this repository.",
        "Ready to work in this repository.",
      );
    }
    return sanitizeInlineText(
      watchState.transientStatus ||
        (watchState.sessionId
          ? `Restoring session ${String(watchState.sessionId).slice(-8)}.`
          : "Starting agent runtime."),
      "Starting agent runtime.",
    );
  }

  function buildSplashCard(width) {
    const safeWidth = Math.max(42, Number(width) || 0);
    const blockWidth = Math.max(32, Math.min(safeWidth - 2, 72));
    const detailText = truncate(splashDetailText(), Math.max(20, blockWidth - 2));
    const sessionText = watchState.sessionId
      ? `session ${String(watchState.sessionId).slice(-8)}`
      : "fresh session";
    const title = watchState.sessionId || watchState.bootstrapReady
      ? "Welcome back"
      : "Starting agent";
    const block = insetBlock([
      fitAnsi(`${color.ink}${title}${color.reset}`, blockWidth),
      fitAnsi(`${color.softInk}${statusLabel()}${color.reset}`, blockWidth),
      "",
      fitAnsi(`${color.ink}${detailText}${color.reset}`, blockWidth),
      ...(watchState.bootstrapReady
        ? [
            "",
            fitAnsi(`${color.softInk}Try one of these:${color.reset}`, blockWidth),
            fitAnsi(`${color.fog}- explain this repository${color.reset}`, blockWidth),
            fitAnsi(`${color.fog}- fix a failing test${color.reset}`, blockWidth),
            fitAnsi(`${color.fog}- use @path to mention a file${color.reset}`, blockWidth),
            fitAnsi(`${color.fog}- /help for commands${color.reset}`, blockWidth),
          ]
        : [
            fitAnsi(`${color.softInk}Restoring workspace state and session context.${color.reset}`, blockWidth),
          ]),
      "",
      fitAnsi(`${color.softInk}${sessionText}${color.reset}`, blockWidth),
    ], 2);
    if (watchState.bootstrapReady) {
      block.push("");
      block.push(`  ${fitAnsi(`${color.fog}Start typing below.${color.reset}`, Math.max(16, safeWidth - 2))}`);
    }
    return block;
  }

  function renderMinimalSplash(width, height) {
    const block = buildSplashCard(width);
    return block.slice(0, Math.max(1, height));
  }

  function renderIdleState(width) {
    return buildSplashCard(width);
  }

  function renderCompactSplash(width, height) {
    const statusLabel = watchState.bootstrapReady
      ? "Ready"
      : transportState.connectionState === "reconnecting"
        ? "Reconnecting..."
        : "Connecting...";
    const statusTone =
      watchState.bootstrapReady && transportState.connectionState === "live"
        ? "teal"
        : transportState.connectionState === "reconnecting"
          ? "amber"
          : "slate";
    const detailText = watchState.bootstrapReady
      ? sanitizeInlineText(
          watchState.transientStatus || "Session restored. Start typing to continue.",
          "Session restored.",
        )
      : sanitizeInlineText(
          watchState.transientStatus ||
            (watchState.sessionId
              ? `Restoring session ${String(watchState.sessionId).slice(-8)}.`
              : "Starting agent runtime."),
          "Starting agent runtime.",
        );
    const sessionText = watchState.sessionId
      ? `session ${String(watchState.sessionId).slice(-8)}`
      : "";
    const content = [
      `${toneColor(statusTone)}${statusLabel}${color.reset}`,
      `${color.fog}${truncate(detailText, Math.max(16, width - 4))}${color.reset}`,
      sessionText
        ? `${color.softInk}${sessionText}${color.reset}`
        : "",
    ].filter((line) => line.length > 0);
    return insetBlock(content, 2).slice(0, Math.max(1, height));
  }

  function renderSplash(width, height) {
    return renderMinimalSplash(width, height);
  }

  return {
    renderCompactSplash,
    renderIdleState,
    renderSplash,
    shouldShowSplash,
  };
}
