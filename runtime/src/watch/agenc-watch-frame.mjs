import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  marketBrowserKind as marketTaskBrowserKind,
  marketTaskBrowserCountLabel,
  marketTaskBrowserEmptyLabel,
  marketTaskBrowserLoadingLabel,
} from "../marketplace/surfaces.mjs";
import { createWatchSplashRenderer } from "./agenc-watch-splash.mjs";
import { visibleLength, wrapBlock } from "./agenc-watch-text-utils.mjs";
import { buildStreamingMarkdownDisplayLines } from "./agenc-watch-markdown-stream.mjs";

export function createWatchFrameController(dependencies = {}) {
  const {
    fs,
    watchState,
    transportState,
    workspaceRoot,
    events,
    queuedOperatorInputs,
    subagentPlanSteps,
    subagentLiveActivity,
    plannerDagNodes,
    plannerDagEdges,
    workspaceFileIndex,
    watchFeatureFlags = {},
    color,
    enableMouseTracking,
    launchedAtMs,
    startupSplashMinMs,
    introDismissKinds,
    maxInlineChars,
    maxPreviewSourceLines,
    currentSurfaceSummary,
    currentInputValue,
    currentInputPreferences,
    currentSlashSuggestions,
    currentModelSuggestions,
    currentFileTagPalette,
    currentSessionElapsedLabel,
    currentRunElapsedLabel,
    currentDisplayObjective,
    currentPhaseLabel,
    currentSurfaceToolLabel,
    hasActiveSurfaceRun,
    isTerminalRunPhase,
    currentTerminalRunPhase,
    bootstrapPending,
    shouldShowWatchSplash,
    buildWatchLayout,
    buildWatchFooterSummary,
    buildWatchSidebarPolicy,
    buildTranscriptEventSummary,
    buildDetailPaneSummary,
    buildCommandPaletteSummary,
    buildFileTagPaletteSummary,
    computeTranscriptPreviewMaxLines,
    splitTranscriptPreviewForHeadline,
    buildEventDisplayLines,
    wrapEventDisplayLines,
    wrapDisplayLines,
    compactBodyLines,
    createDisplayLine,
    displayLineText,
    displayLinePlainText,
    renderEventBodyLine,
    isDiffRenderableEvent,
    isSourcePreviewEvent,
    isMarkdownRenderableEvent,
    isMutationPreviewEvent,
    isSlashComposerInput,
    composerRenderLine,
    fitAnsi,
    truncate,
    sanitizeInlineText,
    sanitizeDisplayText,
    toneColor,
    stateTone,
    badge,
    chip,
    markerChip,
    row,
    renderPanel,
    joinColumns,
    blankRow,
    paintSurface,
    flexBetween,
    termWidth,
    termHeight,
    formatClockLabel,
    animatedWorkingGlyph,
    compactSessionToken,
    readGitBranchLabel,
    sanitizePlanLabel,
    plannerDagStatusTone,
    plannerDagStatusGlyph,
    plannerDagTypeGlyph,
    planStatusTone,
    planStatusGlyph,
    planStepDisplayName,
    applyViewportScrollDelta,
    preserveManualTranscriptViewport,
    sliceViewportRowsAroundRange,
    sliceViewportRowsFromBottom,
    bottomAlignViewportRows,
    isViewportTranscriptFollowing,
    setTransientStatus,
    pushEvent,
    buildAltScreenEnterSequence,
    buildAltScreenLeaveSequence,
    stdout = process.stdout,
    nowMs = () => Date.now(),
    setTimer = setTimeout,
  } = dependencies;

  const frameState = {
    enteredAltScreen: false,
    selectionModeActive: false,
    renderPending: false,
    lastRenderedFrameLines: [],
    lastRenderedFrameWidth: 0,
    lastRenderedFrameHeight: 0,
    // Interval that force-ticks the renderer while a run is active
    // so spinners, elapsed-time, and "Thinking" verbs refresh even
    // during long silent gaps (a 20s provider call emits no
    // intermediate events; without this the UI looks frozen).
    activeRunTicker: null,
  };

  // Re-render cadence while a run is in-flight. 500 ms is fast
  // enough for smooth spinner animation and once-per-second elapsed
  // time changes, slow enough to keep CPU cost negligible.
  const ACTIVE_RUN_TICK_INTERVAL_MS = 500;

  function ensureActiveRunTicker() {
    const shouldRun =
      watchState?.activeRunStartedAtMs != null ||
      (typeof hasActiveSurfaceRun === "function" && hasActiveSurfaceRun());
    if (shouldRun && !frameState.activeRunTicker) {
      frameState.activeRunTicker = setInterval(() => {
        // Re-check on every tick; if the run ended between ticks, stop.
        const stillActive =
          watchState?.activeRunStartedAtMs != null ||
          (typeof hasActiveSurfaceRun === "function" && hasActiveSurfaceRun());
        if (!stillActive) {
          if (frameState.activeRunTicker) {
            clearInterval(frameState.activeRunTicker);
            frameState.activeRunTicker = null;
          }
          return;
        }
        // Kick a render regardless of whether new events arrived — the
        // whole point of the ticker is to keep animated state fresh
        // during silent provider calls.
        if (!frameState.renderPending) {
          frameState.renderPending = true;
          setTimer(render, 0);
        }
      }, ACTIVE_RUN_TICK_INTERVAL_MS);
      // Don't keep the Node process alive just for animation ticks.
      if (typeof frameState.activeRunTicker?.unref === "function") {
        frameState.activeRunTicker.unref();
      }
    } else if (!shouldRun && frameState.activeRunTicker) {
      clearInterval(frameState.activeRunTicker);
      frameState.activeRunTicker = null;
    }
  }

  // Split an ANSI-colored row into an array of per-cell entries
  // `{sgr, char}` up to `width` columns. `sgr` is the FULL active
  // SGR state at that cell — the accumulated escape sequences since
  // the last reset (`\x1b[0m` / `\x1b[m`). This way a run of
  // identically-colored cells all carry the same sgr string and the
  // compositor can safely emit the state once per change rather
  // than losing the bg color after the first cell. Short rows are
  // padded with blank cells so the compositor can index any column
  // without bounds checks.
  function splitAnsiCells(row, width) {
    const cells = new Array(width);
    let index = 0;
    let activeSgr = "";
    let col = 0;
    while (index < row.length && col < width) {
      if (row[index] === "\x1b") {
        const match = row.slice(index).match(/^\x1b\[[0-9;]*m/);
        if (match) {
          if (match[0] === "\x1b[0m" || match[0] === "\x1b[m") {
            activeSgr = "";
          } else {
            activeSgr += match[0];
          }
          index += match[0].length;
          continue;
        }
      }
      cells[col] = { sgr: activeSgr, char: row[index] };
      index += 1;
      col += 1;
    }
    while (col < width) {
      cells[col] = { sgr: "", char: " " };
      col += 1;
    }
    return cells;
  }

  // Composite a TUI row with a right-side ANSI art strip: the left
  // `width - artCols` columns are preserved exactly (chat area stays
  // clean and readable). Only the rightmost `artCols` columns are
  // composited — TUI cells carrying a visible non-space character
  // stay on top; space cells fall through to the art pixel at that
  // column. Art is pinned to the right edge; when chat content
  // scrolls in the left region the art stays in place visually
  // because it's re-applied on every frame.
  function compositeRowWithArt(tuiRow, artRow, width, artCols) {
    if (artCols <= 0 || artCols > width) return tuiRow;
    const leftCols = Math.max(0, width - artCols);
    const tuiCells = splitAnsiCells(tuiRow, width);
    const artCells = splitAnsiCells(artRow, artCols);
    let output = "";
    let activeSgr = "";
    for (let col = 0; col < width; col += 1) {
      const tuiCell = tuiCells[col] ?? { sgr: "", char: " " };
      if (col < leftCols) {
        if (tuiCell.sgr !== activeSgr) {
          output += "\x1b[0m" + tuiCell.sgr;
          activeSgr = tuiCell.sgr;
        }
        output += tuiCell.char;
        continue;
      }
      const artCol = col - leftCols;
      const artCell = artCells[artCol] ?? { sgr: "", char: " " };
      const source =
        tuiCell.char !== " " && tuiCell.char !== "\u00a0"
          ? tuiCell
          : artCell;
      if (source.sgr !== activeSgr) {
        output += "\x1b[0m" + source.sgr;
        activeSgr = source.sgr;
      }
      output += source.char;
    }
    output += "\x1b[0m";
    return output;
  }

  const splashRenderer = createWatchSplashRenderer({
    watchState,
    transportState,
    events,
    introDismissKinds,
    currentInputValue,
    launchedAtMs,
    startupSplashMinMs,
    shouldShowWatchSplash,
    nowMs,
    toneColor,
    fitAnsi,
    truncate,
    sanitizeInlineText,
    color,
    renderPanel,
    row,
  });
  // Previously this set excluded "agent" because the canonical-reply
  // pin rendered the latest agent message at the top of the activity
  // panel, so the transcript path treated the agent event as already
  // shown. With the pin removed (one chronological scrollable list,
  // Claude Code pattern), the agent event MUST appear in the
  // transcript — otherwise scrolling makes the reply vanish entirely.
  const hiddenTranscriptKinds = new Set(["status"]);
  const transcriptBlockInset = "  ";
  const transcriptBodyInset = "    ";
  // Medium gray so the user-prompt rounded pill stands out clearly against
  // both the terminal default bg AND the brand purple. ANSI 238 (#444444)
  // is distinctly gray (not near-black), pure neutral hue (no blue/purple
  // bleed), and gives strong value contrast for the vivid #af00ff logo.
  // Matches headerPanelBg so the header rectangle and the prompt pill
  // share one surface color.
  const transcriptUserBg = "\x1b[48;5;238m";
  const transcriptQueuedBg = color.panelAltBg;
  // Verbs are all "grok-flavored" — cognitive / deep-understanding actions in
  // the spirit of Heinlein's coined word "grok" (to fully comprehend) and the
  // Grok model family. Used in the active-run footer next to the breathing
  // micro-rings spinner. Hash-seeded per run so each run picks one and holds
  // it for the duration (see currentThinkingVerb).
  const thinkingVerbs = Object.freeze([
    "Grokking",
    "Pondering",
    "Musing",
    "Reasoning",
    "Cogitating",
    "Inferring",
    "Distilling",
    "Contemplating",
    "Deliberating",
    "Ruminating",
    "Mulling",
    "Decoding",
    "Unraveling",
    "Untangling",
    "Synthesizing",
    "Calculating",
    "Hitchhiking",
    "Sleuthing",
    "Theorizing",
    "Brainstorming",
  ]);
  const thinkingTips = Object.freeze([
    "Use /status to inspect the live run without leaving the terminal.",
    "Type @ to pull a workspace file into the prompt.",
    "Use /compact now when the transcript gets noisy.",
    "Open detail mode with ctrl+o to inspect the latest rich event.",
  ]);
  // Compact 4x4 pixel square rendered as a 2x1 braille badge so it matches text height.
  const thinkingPixelGrid = Object.freeze({
    width: 4,
    height: 4,
    cellWidth: 2,
    cellHeight: 4,
  });
  const brailleDotMaskByPixel = Object.freeze([
    Object.freeze([0x01, 0x08]),
    Object.freeze([0x02, 0x10]),
    Object.freeze([0x04, 0x20]),
    Object.freeze([0x40, 0x80]),
  ]);
  const agencHeaderLogoBoxLines = Object.freeze([
    "⣞⠙⠙⢦⡴⠋⠋⣳",
    "⠳⣄⡴⠋⠙⢦⣠⠞",
    "⡴⠋⠳⣄⣠⠞⠙⢦",
    "⢯⣠⣠⠞⠳⣄⣄⡽",
  ]);
  const gitBranchCache = {
    root: "",
    value: "",
    updatedAtMs: 0,
    retryAfterMs: 0,
  };

  function stableFrameHash(value = "") {
    let hash = 0;
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return hash >>> 0;
  }

  function currentThinkingSeed(summary) {
    return [
      String(Number(watchState.activeRunStartedAtMs) || 0),
      sanitizeInlineText(summary?.objective ?? "", ""),
      sanitizeInlineText(summary?.overview?.activeLine ?? "", ""),
      sanitizeInlineText(summary?.overview?.phaseLabel ?? "", ""),
      sanitizeInlineText(summary?.providerLabel ?? "", ""),
    ].join("|");
  }

  function currentThinkingVerb(summary) {
    const seed = currentThinkingSeed(summary);
    return thinkingVerbs[stableFrameHash(seed) % thinkingVerbs.length] ?? "Thinking";
  }

  function currentThinkingTip(summary) {
    const seed = `${currentThinkingSeed(summary)}|tip`;
    return thinkingTips[stableFrameHash(seed) % thinkingTips.length] ?? thinkingTips[0];
  }

  function currentThinkingPrompt(summary) {
    return (
      sanitizeInlineText(summary?.objective ?? "", "") ||
      sanitizeInlineText(summary?.overview?.activeLine ?? "", "") ||
      sanitizeInlineText(summary?.runtimeLabel ?? "", "") ||
      "Working"
    );
  }

  function currentThinkingInlineGlyph() {
    const pulseGlyph = typeof animatedWorkingGlyph === "function"
      ? animatedWorkingGlyph()
      : "◈";
    const frameMap = {
      "·": "·",
      "◇": "◇",
      "◈": "◈",
      "❖": "❖",
    };
    return frameMap[pulseGlyph] ?? "◈";
  }

  function currentThinkingFooterFrameIndex() {
    const pulseGlyph = currentThinkingInlineGlyph();
    switch (pulseGlyph) {
      case "·":
      case "◐":
        return 0;
      case "◇":
      case "◓":
        return 1;
      case "❖":
      case "◒":
        return 2;
      case "◈":
      case "◑":
      default:
        return 3;
    }
  }

  function brailleCharFromMask(mask) {
    return String.fromCodePoint(0x2800 + (mask & 0xff));
  }

  function thinkingPixelIsBorder(x, y) {
    return (
      x === 0 ||
      y === 0 ||
      x === thinkingPixelGrid.width - 1 ||
      y === thinkingPixelGrid.height - 1
    );
  }

  function thinkingPixelMaskForCell(cellX, cellY, frameIndex) {
    let mask = 0;
    const sweepColumn = frameIndex % thinkingPixelGrid.width;
    const sweepRow = (frameIndex + 1) % thinkingPixelGrid.height;
    for (let localY = 0; localY < thinkingPixelGrid.cellHeight; localY += 1) {
      for (let localX = 0; localX < thinkingPixelGrid.cellWidth; localX += 1) {
        const x = cellX * thinkingPixelGrid.cellWidth + localX;
        const y = cellY * thinkingPixelGrid.cellHeight + localY;
        const isBorder = thinkingPixelIsBorder(x, y);
        const isSweepPixel = !isBorder && (
          x === sweepColumn ||
          x === sweepColumn + 1 ||
          y === sweepRow
        );
        const isSparklePixel = !isBorder && ((x + y + frameIndex) % 4 === 0);
        if (isBorder || isSweepPixel || isSparklePixel) {
          mask |= brailleDotMaskByPixel[localY]?.[localX] ?? 0;
        }
      }
    }
    return mask;
  }

  function thinkingPixelToneForCell(cellX, cellY, frameIndex) {
    const rows = thinkingPixelGrid.height / thinkingPixelGrid.cellHeight;
    const sweepCellX = Math.floor((frameIndex % thinkingPixelGrid.width) / thinkingPixelGrid.cellWidth);
    const sweepCellY = Math.floor(((frameIndex + 1) % thinkingPixelGrid.height) / thinkingPixelGrid.cellHeight);
    if (cellX === sweepCellX || (rows > 1 && cellY === sweepCellY)) {
      return frameIndex === 2 ? "yellow" : (frameIndex % 2 === 0 ? "cyan" : "teal");
    }
    const toneCycle = ["ink", "cyan", "teal", "ink"];
    return toneCycle[(cellX + cellY + frameIndex) % toneCycle.length] ?? "ink";
  }

  function currentThinkingPixelLines() {
    // Variant C — AGENC MICRO RINGS (Breathing). 3 chars wide, 6 frames,
    // 1 row tall (footer-safe). The shape inhales from a faint dot triple,
    // blooms into full braille rings, peaks at solid ⣿⣿⣿, and exhales back
    // down — a smooth, on-brand "thinking breath" with linked-ring geometry.
    //
    // Drives off nowMs() directly (not the 4-step glyph index) so all six
    // frames are reachable. Cadence ≈ 6.25 frames/sec (160 ms / frame),
    // matching the spec from the design canvas.
    //
    // Each frame is paired with a brand-purple breathing tone:
    //   0  ⠐⠂⠄  ANSI 92  (#5f00d7)  deep dim    — inhale start
    //   1  ⡆⣶⡄  ANSI 98  (#875fd7)  rising      — fill
    //   2  ⣾⣿⣷  ANSI 129 (#af00ff)  vivid base  — bloom
    //   3  ⣿⣿⣿  ANSI 165 (#d700ff)  peak bright — full breath
    //   4  ⣾⣿⣷  ANSI 129 (#af00ff)  vivid base  — exhale begin
    //   5  ⡆⣶⡄  ANSI 98  (#875fd7)  falling     — settle
    const breathFrames = ["⠐⠂⠄", "⡆⣶⡄", "⣾⣿⣷", "⣿⣿⣿", "⣾⣿⣷", "⡆⣶⡄"];
    const breathTones = [
      "\x1b[38;5;92m",
      "\x1b[38;5;98m",
      "\x1b[38;5;129m",
      "\x1b[38;5;165m",
      "\x1b[38;5;129m",
      "\x1b[38;5;98m",
    ];
    const frameIndex = Math.floor((Number(nowMs()) || 0) / 160) % breathFrames.length;
    const tone = breathTones[frameIndex];
    const glyph = breathFrames[frameIndex];
    return [`${tone}${color.bold}${glyph}${color.reset}`];
  }

  function currentThinkingVerbTone() {
    const frameIndex = currentThinkingFooterFrameIndex();
    return ["cyan", "teal", "yellow", "cyan"][frameIndex] ?? "cyan";
  }

  // "Light scan" effect for the active-run verb. Each character in the verb
  // is painted with a slightly offset palette index, so a bright magenta
  // peak travels across the letters left → right while the rest of the word
  // sits in deeper purples. Combined with bold modulation, this gives a
  // smooth neon shimmer that pairs with the breathing micro-rings spinner
  // without being a static block of color. Bypasses the theme tone system
  // (uses raw 256-color ANSI escapes) so the shimmer survives across all
  // theme presets and matches the spinner palette exactly.
  function currentThinkingVerbDisplay(verb) {
    const text = String(verb ?? "");
    if (text.length === 0) {
      return text;
    }
    // 8-frame brand-purple gradient: deep → soft → vivid → bright → flash
    // peak → bright → vivid → soft. Cycle period 100 ms × 8 = 800 ms — a hair
    // faster than the spinner's 960 ms breath so the shimmer feels alive.
    const palette = [
      "\x1b[38;5;54m",   // 0  deepest aubergine
      "\x1b[38;5;92m",   // 1  deep purple
      "\x1b[38;5;98m",   // 2  soft lavender
      "\x1b[38;5;129m",  // 3  vivid brand
      "\x1b[38;5;165m",  // 4  bright violet
      "\x1b[38;5;207m",  // 5  flash magenta peak
      "\x1b[38;5;165m",  // 6  bright violet
      "\x1b[38;5;129m",  // 7  vivid brand
    ];
    const baseFrame = Math.floor((Number(nowMs()) || 0) / 100);
    let result = "";
    for (let charIndex = 0; charIndex < text.length; charIndex += 1) {
      // Negative offset so the bright peak appears to walk left → right.
      // The `+ palette.length * 1000` keeps the modulo positive even when
      // baseFrame is small.
      const paletteIndex = (baseFrame - charIndex + palette.length * 1000) % palette.length;
      const tone = palette[paletteIndex];
      result += `${tone}${color.bold}${text[charIndex]}`;
    }
    return `${result}${color.reset}`;
  }

  function currentThinkingFooterBrand(summary) {
    return {
      logoLines: currentThinkingPixelLines(),
      verb: currentThinkingVerb(summary).toLowerCase(),
      verbTone: currentThinkingVerbTone(),
      verbDisplay: currentThinkingVerbDisplay(currentThinkingVerb(summary).toLowerCase()),
    };
  }

  function formatComposerPathLabel(width) {
    const root = sanitizeInlineText(workspaceRoot || process.cwd() || "", "");
    if (!root) {
      return "";
    }
    const home = os.homedir();
    const displayRoot = root.startsWith(home)
      ? `~${root.slice(home.length) || "/"}`
      : root;
    return truncate(displayRoot, Math.max(12, Math.floor(width * 0.34)));
  }

  function currentWorkspaceName() {
    const root = sanitizeInlineText(workspaceRoot || process.cwd() || "", "");
    if (!root) {
      return "";
    }
    return path.basename(root) || root;
  }

  function currentGitBranchLabel() {
    const root = sanitizeInlineText(workspaceRoot || "", "");
    if (!root) {
      return "";
    }
    const now = Number(nowMs()) || Date.now();
    if (
      gitBranchCache.root === root &&
      gitBranchCache.updatedAtMs > 0 &&
      now - gitBranchCache.updatedAtMs < 15000
    ) {
      return gitBranchCache.value;
    }
    if (gitBranchCache.root === root && gitBranchCache.retryAfterMs > now) {
      return gitBranchCache.value;
    }

    let branch = "";
    try {
      if (typeof readGitBranchLabel === "function") {
        branch = sanitizeInlineText(readGitBranchLabel(root), "");
      } else {
        branch = sanitizeInlineText(
          execFileSync("git", ["-C", root, "branch", "--show-current"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
          "",
        );
        if (!branch) {
          branch = sanitizeInlineText(
            execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }),
            "",
          );
        }
      }
      gitBranchCache.root = root;
      gitBranchCache.value = branch;
      gitBranchCache.updatedAtMs = now;
      gitBranchCache.retryAfterMs = 0;
      return branch;
    } catch {
      gitBranchCache.root = root;
      gitBranchCache.value = "";
      gitBranchCache.updatedAtMs = 0;
      gitBranchCache.retryAfterMs = now + 15000;
      return "";
    }
  }

  function currentHeaderGitBranchLabel() {
    const branch = sanitizeInlineText(currentGitBranchLabel(), "");
    if (!branch) {
      return "";
    }
    return sanitizeInlineText(
      branch.replace(/^codex(?:$|[\/_-]+)/i, ""),
      "",
    ).trim();
  }

  function currentHeaderLogoLines({ compact = false } = {}) {
    const active = hasActiveSurfaceRun();
    // AgenC brand purple — saturated, not pastel. The palette's existing
    // purples (slate 141, fog 97) read too soft against the navy header
    // background, so the logo uses hardcoded vivid purples here:
    //   ANSI 129 = #af00ff vivid pure purple — active run
    //   ANSI 92  = #5f00d7 deep saturated purple — idle
    const artTone = active ? "\x1b[38;5;129m" : "\x1b[38;5;92m";
    return agencHeaderLogoBoxLines.map((line, index) => {
      const weight = index === 0 || index === agencHeaderLogoBoxLines.length - 1
        ? color.bold
        : "";
      return `${artTone}${weight}${line}${color.reset}`;
    });
  }

  function currentHeaderPrimaryText(summary, width) {
    const activeText =
      summary?.objective && summary.objective !== "No active objective"
        ? summary.objective
        : summary?.overview?.activeLine &&
            summary.overview.activeLine !== "Awaiting operator prompt"
          ? summary.overview.activeLine
          : summary?.runtimeLabel || "Awaiting operator prompt";
    return truncate(
      sanitizeInlineText(activeText, "Awaiting operator prompt"),
      Math.max(18, width),
    );
  }

  function currentHeaderRouteText(summary) {
    const model = sanitizeInlineText(
      summary?.modelLabel ?? summary?.overview?.modelLabel ?? "",
      "",
    );
    if (model && model !== "pending") {
      return model;
    }
    return sanitizeInlineText(summary?.routeLabel ?? "", "routing pending");
  }

  function currentHeaderWorkspaceText(width) {
    // Header style C — Modern Card: workspace name + git branch on row 2,
    // each prefixed with the ▸ marker. Branch is NOT in the top border.
    const workspaceName = currentWorkspaceName();
    const branch = currentHeaderGitBranchLabel();
    const parts = [];
    parts.push(
      `${color.fog}▸ workspace${color.reset} ${color.ink}${truncate(workspaceName || "—", Math.max(16, Math.floor(width * 0.4)))}${color.reset}`,
    );
    if (branch) {
      parts.push(
        `${color.fog}▸ git${color.reset} ${color.softInk}${truncate(branch, Math.max(12, Math.floor(width * 0.36)))}${color.reset}`,
      );
    }
    return parts.join("  ");
  }

  function currentHeaderContextText(summary, width) {
    // Header style C — Modern Card: each field gets its own ▸ bullet
    // and fields are joined with a single space (no inline · separator).
    const overview = summary?.overview ?? {};
    const parts = [
      `${color.fog}▸ phase${color.reset} ${color.ink}${truncate(sanitizeInlineText(overview.phaseLabel, "idle"), 22)}${color.reset}`,
    ];
    const latestTool = sanitizeInlineText(overview.latestTool, "");
    const terminalPhase = currentTerminalRunPhase();
    if (terminalPhase) {
      parts.push(
        `${color.fog}▸ tool${color.reset} ${color.softInk}—${color.reset}`,
      );
    } else if (latestTool && latestTool !== "idle") {
      parts.push(
        `${color.fog}▸ tool${color.reset} ${color.softInk}${truncate(latestTool, 26)}${color.reset}`,
      );
    }
    const activeAgents = Number(overview.activeAgentCount ?? 0);
    if (activeAgents > 0) {
      parts.push(
        `${color.fog}▸ agents${color.reset} ${color.softInk}${activeAgents}${color.reset}`,
      );
    }
    const queuedInputs = Number(overview.queuedInputCount ?? 0);
    if (queuedInputs > 0) {
      parts.push(
        `${color.fog}▸ queue${color.reset} ${color.softInk}${queuedInputs}${color.reset}`,
      );
    }
    return parts.join("  ");
  }

  function currentHeaderRunChip(summary, elapsed) {
    const phaseLabel = sanitizeInlineText(summary?.overview?.phaseLabel ?? "", hasActiveSurfaceRun() ? "running" : "idle");
    const runTone = hasActiveSurfaceRun() ? "cyan" : stateTone(phaseLabel);
    const runLabel = hasActiveSurfaceRun() ? phaseLabel || "running" : phaseLabel || "idle";
    return `${markerChip("run", `${runLabel}  ${elapsed}`, runTone)}`;
  }

  function currentHeaderStatusChip(summary) {
    const overview = summary?.overview ?? {};
    const attention = summary?.attention ?? {};
    const connectionState = sanitizeInlineText(overview.connectionState, "unknown");
    if (connectionState && !["live", "connected"].includes(connectionState.toLowerCase())) {
      return markerChip("status", `link ${connectionState}`, stateTone(connectionState));
    }
    const approvals = Number(attention.approvalAlertCount ?? 0);
    if (approvals > 0) {
      return markerChip(
        "STATUS",
        `${approvals} approval${approvals === 1 ? "" : "s"}`,
        "red",
      );
    }
    const errors = Number(attention.errorAlertCount ?? 0);
    if (errors > 0) {
      return markerChip(
        "STATUS",
        `${errors} error${errors === 1 ? "" : "s"}`,
        "red",
      );
    }
    if (sanitizeInlineText(overview.fallbackState, "") === "active") {
      return markerChip("status", "fallback active", "amber");
    }
    const runtimeState = sanitizeInlineText(overview.runtimeState, "");
    if (runtimeState && !["healthy", "ready", "ok", "idle"].includes(runtimeState.toLowerCase())) {
      return markerChip("status", `runtime ${runtimeState}`, stateTone(runtimeState));
    }
    return markerChip("status", "ready", "green");
  }

  function headerDataRow(logoLine, leftText, rightText, width) {
    const rightWidth = visibleLength(rightText);
    const gap = rightWidth > 0 ? 1 : 0;
    const leftWidth = Math.max(18, width - rightWidth - gap);
    const logoPrefix = visibleLength(logoLine) > 0 ? `${logoLine} ` : "";
    const left = fitAnsi(`${logoPrefix}${leftText}`, leftWidth);
    return fitAnsi(flexBetween(left, rightText, width), width);
  }

  function headerPanelInnerWidth(width, padding = 1) {
    return Math.max(0, width - 2 - (padding * 2));
  }

  // Header style C — Modern Card.
  // Top border inlays the brand on the left:
  //   ╭─ AgenC ─────────────────────────────╮
  // Bottom border inlays the active model name pushed to the right:
  //   ╰─────────────────── model grok-4-fast ─╯
  // Both borders are LEFT TRANSPARENT (terminal default background) so the
  // gray fill stays strictly inside the rectangle and never leaks into the
  // open terminal area to the right of the right border.
  function headerPanelTop(width, brandLabel = "") {
    const borderTone = color.borderStrong || color.border || "";
    const inner = Math.max(0, width - 2);
    const brandVis = visibleLength(brandLabel);

    if (brandVis === 0) {
      return `${borderTone}╭${"─".repeat(inner)}╮${color.reset}`;
    }

    // Visible-char accounting:
    //   ╭ ─ ' ' brand ' ' (dashes) ╮  =  2 corners + 1 + 1 + brand + 1 + N
    //   total = 5 + brand + N  ⇒  N = width − 5 − brand = inner − 3 − brand
    const dashes = Math.max(0, inner - 3 - brandVis);
    return `${borderTone}╭─ ${color.reset}${brandLabel}${borderTone} ${"─".repeat(dashes)}╮${color.reset}`;
  }

  function headerPanelBottom(width, modelLabel = "") {
    const borderTone = color.borderStrong || color.border || "";
    const inner = Math.max(0, width - 2);
    const modelVis = visibleLength(modelLabel);

    if (modelVis === 0 || inner < modelVis + 4) {
      return `${borderTone}╰${"─".repeat(inner)}╯${color.reset}`;
    }

    // Right-align the model with a single trailing dash + corner:
    //   ╰ (dashes) ' ' model ' ' ─ ╯
    //   total = 2 corners + dashes + 1 + model + 1 + 1
    //         = 5 + dashes + model
    //   ⇒ dashes = width − 5 − model = inner − 3 − model
    const dashes = Math.max(0, inner - 3 - modelVis);
    return `${borderTone}╰${"─".repeat(dashes)} ${color.reset}${modelLabel}${borderTone} ─╯${color.reset}`;
  }

  function headerPanelRow(text, width, background, { padding = 1 } = {}) {
    const borderTone = color.borderStrong || color.border || "";
    const inner = Math.max(0, width - 2);
    const contentWidth = headerPanelInnerWidth(width, padding);
    const content = fitAnsi(String(text ?? ""), contentWidth);
    const padded = `${" ".repeat(padding)}${content}${" ".repeat(padding)}`;
    // Borders stay transparent (terminal default bg). Only the inner content
    // gets the gray fill, so the rectangle's right edge is the hard boundary
    // between gray and the open terminal area.
    return `${borderTone}│${color.reset}${paintSurface(padded, inner, background)}${borderTone}│${color.reset}`;
  }

  function headerPanelSpacerRow(width, background, { padding = 1 } = {}) {
    return headerPanelRow("", width, background, { padding });
  }

  function wrapHeaderText(plainText, firstWidth, restWidth) {
    const safeText = sanitizeInlineText(plainText, "");
    if (!safeText) {
      return [];
    }
    if (safeText.length <= firstWidth) {
      return [safeText];
    }
    const [firstLine = safeText] = wrapBlock(safeText, firstWidth);
    const remaining = safeText.slice(firstLine.length).trimStart();
    if (!remaining) {
      return [firstLine];
    }
    return [firstLine, ...wrapBlock(remaining, restWidth)];
  }

  function currentHeaderUsageRows(summary, logoLine, width) {
    const usage = sanitizeInlineText(summary?.overview?.usage, "");
    if (!usage || usage === "n/a") {
      return [];
    }
    const logoPrefix = visibleLength(logoLine) > 0 ? `${logoLine} ` : "";
    const continuationPrefix = " ".repeat(visibleLength(logoPrefix));
    const labelWidth = visibleLength("usage ");
    const firstWidth = Math.max(12, width - visibleLength(logoPrefix) - labelWidth);
    const restWidth = Math.max(12, width - visibleLength(continuationPrefix));
    const wrappedUsage = wrapHeaderText(usage, firstWidth, restWidth);
    return wrappedUsage.map((line, index) => {
      if (index === 0) {
        return fitAnsi(
          `${logoPrefix}${color.fog}▸ usage${color.reset} ${color.ink}${line}${color.reset}`,
          width,
        );
      }
      return fitAnsi(
        `${continuationPrefix}${color.ink}${line}${color.reset}`,
        width,
      );
    });
  }

  function composerDividerLine(width, { label = "" } = {}) {
    const safeLabel = sanitizeInlineText(label, "");
    if (!safeLabel) {
      return `${color.borderStrong}${"─".repeat(Math.max(0, width))}${color.reset}`;
    }
    const labelText = `${color.green}${safeLabel}${color.reset}`;
    const labelWidth = visibleLength(safeLabel);
    const ruleWidth = Math.max(0, width - labelWidth - 1);
    return `${color.borderStrong}${"─".repeat(ruleWidth)}${color.reset} ${labelText}`;
  }

  function composerBandLines(
    width,
    composerLines = [],
    diffNavigation = null,
    { bottomGapRows = 1 } = {},
  ) {
    const statusLines = footerStatusLines(width, diffNavigation);
    return [
      ...statusLines,
      composerDividerLine(width, { label: formatComposerPathLabel(width) }),
      ...composerLines,
      composerDividerLine(width),
      ...Array.from({ length: Math.max(0, bottomGapRows) }, () => ""),
    ];
  }

  function transcriptInputBlock(lines, width, {
    tone = color.softInk,
    background = transcriptUserBg,
    marker = ">",
    markerTone = color.ink,
    // One empty bg-painted row above AND below the content for breathing
    // room. Set to 0 for a single-row block.
    paddingRows = 1,
  } = {}) {
    const blockLines = Array.isArray(lines) ? lines : [lines];

    const contentLines = blockLines.map((line, index) => {
      const safeText = sanitizeDisplayText(
        typeof line === "string" ? line : displayLinePlainText(line),
      ) || "";
      const prefix = index === 0
        ? `${transcriptBlockInset}${markerTone}${color.bold}${marker}${color.reset} `
        : transcriptBodyInset;
      const truncated = truncate(
        safeText,
        Math.max(4, width - visibleLength(prefix) - 1),
      );
      const content = `${prefix}${tone}${truncated}${color.reset}`;
      return paintSurface(content, width, background);
    });

    if (paddingRows <= 0) {
      return contentLines;
    }

    // Plain bg-painted empty rows above and below the content — no border
    // characters, no half-block edge tricks (those rendered as 3D shadows
    // in some terminals). Just a flat gray rectangle.
    const paddingLine = paintSurface("", width, background);
    const padding = Array.from({ length: paddingRows }, () => paddingLine);
    return [...padding, ...contentLines, ...padding];
  }

  function transcriptInputBar(text, width, options = {}) {
    // Bar variant returns a single line — bypass the vertical padding.
    return transcriptInputBlock([text], width, { ...options, paddingRows: 0 })[0];
  }

  function transcriptChatRows(lines, width, {
    marker = "●",
    markerTone = color.ink,
    textTone = color.ink,
    preserveBlankLines = false,
  } = {}) {
    const safeLines = (Array.isArray(lines) ? lines : [lines])
      .map((line) => sanitizeDisplayText(
        typeof line === "string" ? line : displayLinePlainText(line),
      ));
    const rows = [];
    safeLines.forEach((line, index) => {
      if (line.length === 0) {
        if (preserveBlankLines) {
          rows.push(fitAnsi(transcriptBodyInset, width));
        }
        return;
      }
      const markerPrefix = index === 0
        ? `${transcriptBlockInset}${markerTone}${color.bold}${marker}${color.reset} `
        : transcriptBodyInset;
      const availableWidth = Math.max(
        8,
        width - visibleLength(markerPrefix),
      );
      const leftText = `${markerPrefix}${textTone}${truncate(line, availableWidth)}${color.reset}`;
      rows.push(fitAnsi(leftText, width));
    });
    return rows;
  }

  function storedEventBodyText(event) {
    if (!event || typeof event !== "object") {
      return "";
    }
    if (typeof event.detailBody === "string" && event.detailBody.length > 0) {
      return event.detailBody;
    }
    return typeof event.body === "string" ? event.body : "";
  }

  function canonicalReplyRows(width) {
    const replyEvent = currentCanonicalReplyEvent();
    if (!replyEvent) {
      return [];
    }
    const fullReplyLines = fullAgentTranscriptLines(replyEvent, width);
    const previewLines = eventPreviewLines(replyEvent, Math.max(12, width - 4));
    const previewSplit = splitTranscriptPreviewForHeadline(replyEvent, previewLines);
    const headline = previewSplit.headline || eventHeadline(replyEvent, previewLines);
    const replySplit =
      fullReplyLines.length > 0
        ? isTableDisplayMode(fullReplyLines[0]?.mode)
          ? { headline, bodyLines: fullReplyLines }
          : splitTranscriptPreviewForHeadline(replyEvent, fullReplyLines)
        : previewSplit;
    const rows = [
      ...transcriptChatRows([replySplit.headline || headline], width, {
        marker: "●",
        markerTone: color.ink,
        textTone: color.ink,
      }),
    ];
    const bodyLines = fullReplyLines.length > 0 ? replySplit.bodyLines : previewSplit.bodyLines;
    for (const line of bodyLines) {
      const plain = sanitizeDisplayText(
        typeof line === "string" ? line : displayLinePlainText(line),
      );
      if (plain.length === 0) {
        rows.push(fitAnsi(transcriptBodyInset, width));
        continue;
      }
      rows.push(fitAnsi(renderEventBodyLine(replyEvent, line, {
        inline: true,
        prefix: transcriptBodyInset,
      }), width));
    }
    return rows;
  }

  function activePlanEntries(limit = 10) {
    return [...subagentPlanSteps.values()]
      .sort((left, right) => left.order - right.order)
      .slice(-limit);
  }

  function activeAgentEntries(limit = 24) {
    return activePlanEntries(limit).filter((step) =>
      step.status === "running" || step.status === "planned"
    );
  }

  function visibleTranscriptEvents() {
    const filter = String(watchState.eventCategoryFilter ?? "all").trim().toLowerCase();
    const categoryForKind = (kind) => {
      switch (kind) {
        case "approval":
          return "approval";
        case "tool":
        case "tool result":
        case "tool error":
          return "tool";
        case "run":
        case "inspect":
          return "run";
        case "subagent":
        case "subagent tool":
        case "subagent tool result":
        case "subagent error":
          return "agent";
        case "status":
        case "session":
        case "operator":
        case "checkpoint":
          return "system";
        case "agent":
        case "you":
        case "queued":
        case "history":
          return "shell";
        default:
          return "system";
      }
    };
    return events.filter((event) =>
      event &&
      !hiddenTranscriptKinds.has(event.kind) &&
      (filter === "all" || categoryForKind(event.kind) === filter)
    );
  }

  function currentCanonicalReplyEvent() {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index];
      if (!candidate || candidate.kind !== "agent") {
        continue;
      }
      if (candidate.canonicalReply === true) {
        return candidate;
      }
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index];
      if (candidate?.kind === "agent") {
        return candidate;
      }
    }
    return null;
  }

  function shouldShowIdleTranscript() {
    return !currentCanonicalReplyEvent() &&
      visibleTranscriptEvents().length === 0 &&
      sanitizeInlineText(currentInputValue(), "").length === 0;
  }

  function headerLines(width) {
    const safeWidth = Math.max(28, Number(width) || 0);
    const headerPanelPadding = 1;
    const innerWidth = Math.max(20, headerPanelInnerWidth(safeWidth, headerPanelPadding));
    const summary = currentSurfaceSummary();
    const elapsed = hasActiveSurfaceRun()
      ? currentRunElapsedLabel()
      : currentSessionElapsedLabel();
    const compact = safeWidth < 88 || termHeight() < 28;
    // \x1b[49m = default background. The header rectangle is just its
    // borders + content; no gray fill inside. Lets the brand purple logo
    // and the field labels read directly against the terminal's own bg
    // without competing with a panel surface color.
    const headerPanelBg = "\x1b[49m";
    const logoLines = currentHeaderLogoLines({ compact });

    // Style C — Modern Card, two-column layout.
    //
    //   ╭─ AgenC ───────────────────────────────────────────╮
    //   │                                                    │
    //   │ <logo> ▸ <objective>           ▸ run    <state>    │
    //   │ <logo> ▸ workspace <name>      ▸ status <state>    │
    //   │ <logo> ▸ git <branch>          ▸ phase  <state>    │
    //   │ <logo> ▸ usage <tokens>        ▸ tool   <latest>   │
    //   │                                                    │
    //   ╰─────────────────────────── model grok-4-fast ─╯
    //
    // - Brand inlaid in top border, model inlaid in bottom border (right).
    // - Every cell uses a `▸` marker (no `◆`, no `::`, no `·`).
    // - Left cells start at the same x (after the logo prefix).
    // - Right cells are padded to a single uniform width so they share both
    //   the same left edge and the same right edge, forming a clean column.
    // - Each row has exactly one left cell + one right cell — no inline
    //   joining like "▸ workspace ... ▸ git ..." that creates a phantom
    //   third middle column.
    const brandLabel = `${color.ink}${color.bold}AgenC${color.reset}`;
    const modelText = currentHeaderRouteText(summary);
    const modelTone = summary?.providerLabel && summary.providerLabel !== "pending" ? "teal" : "slate";
    const modelLabel = modelText
      ? `${color.fog}model${color.reset} ${toneColor(modelTone)}${color.bold}${truncate(modelText, Math.max(12, Math.floor(innerWidth * 0.5)))}${color.reset}`
      : "";

    // ── Helpers ──────────────────────────────────────────────────────────
    // A "field" is a left-column cell. A "stat" is a right-column cell.
    // Both share the same `▸ label  value` shape so they line up visually.
    const FIELD_VALUE_MAX = Math.max(14, Math.floor(innerWidth * 0.42));

    function field(label, value, tone = color.ink) {
      const safeValue = sanitizeInlineText(value, "—") || "—";
      const truncated = truncate(safeValue, FIELD_VALUE_MAX);
      if (label) {
        return `${color.fog}▸ ${label}${color.reset} ${tone}${truncated}${color.reset}`;
      }
      return `${color.fog}▸${color.reset} ${tone}${truncated}${color.reset}`;
    }

    function stat(label, value, tone = "ink") {
      const safeValue = sanitizeInlineText(value, "—") || "—";
      const truncated = truncate(safeValue, FIELD_VALUE_MAX);
      return `${color.fog}▸ ${label}${color.reset}  ${toneColor(tone)}${color.bold}${truncated}${color.reset}`;
    }

    // ── Left column (4 metadata cells) ───────────────────────────────────
    const objectiveCell = field(
      "",
      currentHeaderPrimaryText(summary, FIELD_VALUE_MAX),
      color.ink,
    );

    const workspaceName = currentWorkspaceName();
    const workspaceCell = field("workspace", workspaceName || "—", color.ink);

    const branchName = currentHeaderGitBranchLabel();
    const branchCell = field("git", branchName || "—", color.softInk);

    const overview = summary?.overview ?? {};
    const usageValue = sanitizeInlineText(overview.usage, "");
    const usageCell = field(
      "usage",
      usageValue && usageValue !== "n/a" ? usageValue : "—",
      color.ink,
    );

    // ── Right column (4 status cells) ────────────────────────────────────
    const phaseLabel = sanitizeInlineText(
      overview.phaseLabel ?? "",
      hasActiveSurfaceRun() ? "running" : "idle",
    );
    const runTone = hasActiveSurfaceRun() ? "cyan" : stateTone(phaseLabel);
    const runStateLabel = hasActiveSurfaceRun() ? phaseLabel || "running" : phaseLabel || "idle";
    const runCell = stat("run", `${runStateLabel}  ${elapsed}`, runTone);

    // Inline computation of the status cell — mirrors the old
    // currentHeaderStatusChip logic but emits the new ▸ format.
    const attention = summary?.attention ?? {};
    const connectionState = sanitizeInlineText(overview.connectionState, "unknown");
    const runtimeState = sanitizeInlineText(overview.runtimeState, "");
    const fallbackState = sanitizeInlineText(overview.fallbackState, "");
    const approvals = Number(attention.approvalAlertCount ?? 0);
    const errors = Number(attention.errorAlertCount ?? 0);
    let statusValue;
    let statusTone;
    if (connectionState && !["live", "connected"].includes(connectionState.toLowerCase())) {
      statusValue = `link ${connectionState}`;
      statusTone = stateTone(connectionState);
    } else if (approvals > 0) {
      statusValue = `${approvals} approval${approvals === 1 ? "" : "s"}`;
      statusTone = "red";
    } else if (errors > 0) {
      statusValue = `${errors} error${errors === 1 ? "" : "s"}`;
      statusTone = "red";
    } else if (fallbackState === "active") {
      statusValue = "fallback active";
      statusTone = "amber";
    } else if (runtimeState && !["healthy", "ready", "ok", "idle"].includes(runtimeState.toLowerCase())) {
      statusValue = `runtime ${runtimeState}`;
      statusTone = stateTone(runtimeState);
    } else {
      statusValue = "ready";
      statusTone = "green";
    }
    const statusCell = stat("status", statusValue, statusTone);

    const phaseCell = stat("phase", phaseLabel, stateTone(phaseLabel));

    // "idle" from the surface summary means "no tool currently running",
    // which is redundant with `phase idle`. Treat it the same as empty:
    // show a `—` placeholder so the tool row doesn't echo the phase row.
    const rawLatestTool = sanitizeInlineText(overview.latestTool, "");
    const hasMeaningfulTool = rawLatestTool.length > 0 && rawLatestTool !== "idle";

    // Sub-agent tool overlay: when the parent is dispatched into an
    // `execute_with_agent` delegation the parent session's
    // `latestTool` goes idle while the child runs. Surface the child's
    // most recent tool name so the cockpit reflects actual activity.
    // Mirrors the live `lastToolName` field in
    // `../claude_code/components/AgentProgressLine.tsx`.
    const activeSubagentMap =
      watchState.activeSubagentProgressByParentToolCallId instanceof Map
        ? watchState.activeSubagentProgressByParentToolCallId
        : null;
    let subagentOverlayToolName = null;
    let subagentOverlayTone = null;
    let subagentOverlayExtras = null;
    if (activeSubagentMap && activeSubagentMap.size > 0) {
      let bestEntry = null;
      for (const entry of activeSubagentMap.values()) {
        if (!bestEntry || (entry?.lastUpdatedAt ?? 0) > (bestEntry.lastUpdatedAt ?? 0)) {
          bestEntry = entry;
        }
      }
      if (bestEntry && typeof bestEntry.lastToolName === "string") {
        subagentOverlayToolName = bestEntry.lastToolName.trim();
        const lastActivityError = bestEntry.lastActivity?.isError === true;
        subagentOverlayTone = lastActivityError ? "red" : "cyan";
        subagentOverlayExtras = bestEntry;
      }
    }
    const shouldOverlaySubagent = Boolean(
      subagentOverlayToolName &&
        (!hasMeaningfulTool || rawLatestTool === "execute_with_agent"),
    );
    const toolCellValue = shouldOverlaySubagent
      ? `execute_with_agent › ${truncate(subagentOverlayToolName, 18)}`
      : hasMeaningfulTool
        ? rawLatestTool
        : "—";
    const toolCellTone = shouldOverlaySubagent
      ? subagentOverlayTone ?? "cyan"
      : hasMeaningfulTool
        ? stateTone(overview.latestToolState)
        : "slate";
    const toolCell = stat("tool", toolCellValue, toolCellTone);
    void subagentOverlayExtras;

    // ── Pad right column to uniform width ────────────────────────────────
    const rightColumnCells = [runCell, statusCell, phaseCell, toolCell];
    const rightColumnWidth = Math.max(
      ...rightColumnCells.map((cellText) => visibleLength(cellText)),
    );
    const padRightCell = (cellText) => {
      const padCount = Math.max(0, rightColumnWidth - visibleLength(cellText));
      return `${cellText}${" ".repeat(padCount)}`;
    };
    const [runRight, statusRight, phaseRight, toolRight] = rightColumnCells.map(padRightCell);

    // ── Assemble rows ────────────────────────────────────────────────────
    const leftCells = [objectiveCell, workspaceCell, branchCell, usageCell];
    const rightCells = [runRight, statusRight, phaseRight, toolRight];

    const bodyRows = leftCells.map((leftText, i) =>
      headerDataRow(
        logoLines[i] ?? "",
        leftText,
        rightCells[i] ?? "",
        innerWidth,
      ),
    );

    return [
      headerPanelTop(safeWidth, brandLabel),
      headerPanelSpacerRow(safeWidth, headerPanelBg, { padding: headerPanelPadding }),
      ...bodyRows.map((line) => headerPanelRow(line, safeWidth, headerPanelBg, { padding: headerPanelPadding })),
      headerPanelSpacerRow(safeWidth, headerPanelBg, { padding: headerPanelPadding }),
      headerPanelBottom(safeWidth, modelLabel),
      // Outer spacer row — gives the first transcript line breathing room
      // below the rectangle. Empty string is fine: the renderer paints every
      // frame line with color.panelBg (terminal default), so this just shows
      // up as a blank gap between the rectangle's bottom border and the
      // first prompt.
      "",
    ];
  }

  function normalizePaletteSelectionIndex(entryCount) {
    if (!Number.isInteger(entryCount) || entryCount <= 0) {
      return -1;
    }
    const nextIndex = Number.isInteger(watchState.composerPaletteIndex)
      ? watchState.composerPaletteIndex
      : 0;
    return Math.max(0, Math.min(entryCount - 1, nextIndex));
  }

  function paletteVisibleEntryLimit(height) {
    const safeHeight = Math.max(0, Number(height) || 0);
    if (safeHeight >= 30) return 8;
    if (safeHeight >= 24) return 6;
    if (safeHeight >= 20) return 5;
    if (safeHeight >= 18) return 4;
    return 3;
  }

  function currentComposerPaletteState(limit = 64) {
    if (watchState.expandedEventId) {
      return { mode: "none", entries: [], activeIndex: -1, summary: null };
    }

    const fileTagPalette = currentFileTagPalette(limit);
    if (fileTagPalette.activeTag) {
      const entries = (fileTagPalette.suggestions ?? []).map((entry) => ({
        kind: "file",
        label: entry.label,
        detail: entry.directory,
      }));
      return {
        mode: "file",
        entries,
        activeIndex: normalizePaletteSelectionIndex(entries.length),
        summary: fileTagPalette.summary,
      };
    }

    const inputValue = currentInputValue();
    if (!isSlashComposerInput(inputValue)) {
      return { mode: "none", entries: [], activeIndex: -1, summary: null };
    }

    const modelSuggestions = typeof currentModelSuggestions === "function"
      ? currentModelSuggestions(limit)
      : [];
    if (inputValue.trimStart().match(/^\/models?\s+/i)) {
      const entries = modelSuggestions.map((model) => ({
        kind: "model",
        label: model,
        detail: "",
      }));
      return {
        mode: "model",
        entries,
        activeIndex: normalizePaletteSelectionIndex(entries.length),
        summary: {
          title: "Models",
          empty: entries.length === 0,
        },
      };
    }

    const suggestions = currentSlashSuggestions(limit);
    const entries = suggestions.map((command) => ({
      kind: "command",
      label: command.usage,
      detail: command.description ?? "",
    }));
    return {
      mode: "command",
      entries,
      activeIndex: normalizePaletteSelectionIndex(entries.length),
      summary: buildCommandPaletteSummary({
        inputValue,
        suggestions,
        modelSuggestions: [],
      }),
    };
  }

  function composerPaletteWindow(entries, activeIndex, visibleCount) {
    const count = Math.max(1, Math.min(entries.length, visibleCount));
    const selectedIndex = activeIndex >= 0 ? activeIndex : 0;
    const maxStart = Math.max(0, entries.length - count);
    const start = Math.min(
      maxStart,
      Math.max(0, selectedIndex - count + 1),
    );
    return {
      start,
      end: Math.min(entries.length, start + count),
      entries: entries.slice(start, Math.min(entries.length, start + count)),
    };
  }

  function composerPaletteEntryLine(entry, width, { selected = false } = {}) {
    const marker = selected
      ? `${color.magenta}${color.bold}›${color.reset}`
      : `${color.fog}·${color.reset}`;
    const labelTone = selected ? color.magenta : color.softInk;
    const detail = entry.detail
      ? ` ${color.fog}· ${entry.detail}${color.reset}`
      : "";
    return fitAnsi(
      `${marker} ${labelTone}${entry.label}${color.reset}${detail}`,
      width,
    );
  }

  function composerPaletteEmptyMessage(paletteState) {
    if (paletteState.mode === "file") {
      return workspaceFileIndex.ready
        ? "No matching file tag."
        : paletteState.summary?.suggestionHint || "Workspace index unavailable.";
    }
    if (paletteState.mode === "model") {
      return "No matching model.";
    }
    return "No matching slash command.";
  }

  function composerPaletteLines(width, paletteState, height = termHeight()) {
    if (paletteState.mode === "none") {
      return [];
    }
    const visibleEntries = composerPaletteWindow(
      paletteState.entries,
      paletteState.activeIndex,
      paletteVisibleEntryLimit(height),
    );
    if (visibleEntries.entries.length === 0) {
      return [
        fitAnsi(
          `${color.red}${composerPaletteEmptyMessage(paletteState)}${color.reset}`,
          width,
        ),
      ];
    }
    const lines = [];
    visibleEntries.entries.forEach((entry, index) => {
      lines.push(
        composerPaletteEntryLine(entry, width, {
          selected: visibleEntries.start + index === paletteState.activeIndex,
        }),
      );
    });
    return lines;
  }

  function marketTaskBrowserStatusTone(status) {
    switch (String(status ?? "").trim().toLowerCase()) {
      case "open":
      case "active":
      case "approved":
      case "passed":
      case "registered":
        return color.green;
      case "claimed":
      case "pending":
      case "appealed":
      case "review":
        return color.yellow;
      case "completed":
      case "closed":
      case "resolved":
      case "executed":
        return color.teal;
      case "failed":
      case "cancelled":
      case "rejected":
      case "expired":
      case "slashed":
        return color.red;
      default:
        return color.fog;
    }
  }

  function normalizeMarketTaskBrowserSelectionIndex(itemCount, browserState) {
    if (!Number.isInteger(itemCount) || itemCount <= 0) {
      return -1;
    }
    const nextIndex = Number.isInteger(browserState?.selectedIndex)
      ? browserState.selectedIndex
      : 0;
    return Math.max(0, Math.min(itemCount - 1, nextIndex));
  }

  function marketTaskBrowserVisibleEntryLimit(height) {
    const safeHeight = Math.max(0, Number(height) || 0);
    if (safeHeight >= 30) return 4;
    if (safeHeight >= 24) return 3;
    if (safeHeight >= 20) return 2;
    return 1;
  }

  function joinMarketBrowserParts(parts = []) {
    return parts
      .map((value) => sanitizeInlineText(value ?? "", ""))
      .filter(Boolean)
      .join(" · ");
  }

  function marketBrowserCountLabel(value, noun) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return `${numeric} ${noun}${numeric === 1 ? "" : "s"}`;
  }

  function currentMarketTaskBrowserState() {
    const browser = watchState.marketTaskBrowser;
    if (!browser || typeof browser !== "object" || browser.open !== true) {
      return {
        mode: "none",
        browser: null,
        items: [],
        activeIndex: -1,
      };
    }
    if (watchState.expandedEventId) {
      return {
        mode: "none",
        browser: null,
        items: [],
        activeIndex: -1,
      };
    }
    if (String(currentInputValue() ?? "").trim().length > 0) {
      return {
        mode: "none",
        browser: null,
        items: [],
        activeIndex: -1,
      };
    }
    const items = Array.isArray(browser.items) ? browser.items : [];
    return {
      mode: "browser",
      browser,
      items,
      activeIndex: normalizeMarketTaskBrowserSelectionIndex(items.length, browser),
    };
  }

  function marketTaskBrowserSummaryLine(width, browserState) {
    const browser = browserState.browser;
    const kind = marketTaskBrowserKind(browserState);
    const count = browserState.items.length;
    const summaryLabel = browser.loading
      ? "loading…"
      : marketTaskBrowserCountLabel(kind, count);
    return fitAnsi(
      flexBetween(
        `${color.magenta}${browser.title}${color.reset}${color.fog} · ${summaryLabel}${color.reset}`,
        `${color.fog}↑↓ navigate · Enter details · Esc close${color.reset}`,
        width,
      ),
      width,
    );
  }

  function marketTaskBrowserFilterLine(width, browserState) {
    const kind = marketTaskBrowserKind(browserState);
    if (kind === "skills") {
      const query = String(browserState.browser?.query ?? "").trim();
      const filters = [];
      if (query) {
        filters.push(`query "${sanitizeInlineText(query) || query}"`);
      }
      filters.push(browserState.browser?.activeOnly === false ? "all skills" : "active only");
      return fitAnsi(
        `${color.fog}filters:${color.reset} ${color.softInk}${filters.join(" · ")}${color.reset}`,
        width,
      );
    }
    if (kind === "tasks" || kind === "governance" || kind === "disputes") {
      const statuses = Array.isArray(browserState.browser?.statuses)
        ? browserState.browser.statuses.filter(Boolean)
        : [];
      if (statuses.length === 0) {
        return null;
      }
      return fitAnsi(
        `${color.fog}filters:${color.reset} ${color.softInk}${statuses.join(", ")}${color.reset}`,
        width,
      );
    }
    return null;
  }

  function marketTaskBrowserEntryLine(item, width, browserState, { selected = false } = {}) {
    const kind = marketTaskBrowserKind(browserState);
    const marker = selected
      ? `${color.magenta}${color.bold}›${color.reset}`
      : `${color.fog}·${color.reset}`;
    if (kind === "skills") {
      const stateLabel = item?.isActive === false ? "inactive" : "active";
      const stateTone = item?.isActive === false ? color.fog : color.green;
      const name = sanitizeInlineText(item?.name ?? "") || "unknown skill";
      const priceLabel = String(item?.priceDisplay ?? "").trim() || "n/a";
      const authorLabel = sanitizeInlineText(item?.author ?? "")
        ? `by ${sanitizeInlineText(item.author)}`
        : null;
      const ratingLabel = Number.isFinite(Number(item?.rating))
        ? `rating ${Number(item.rating).toFixed(1)}`
        : null;
      const downloads = Number(item?.downloads);
      const downloadsLabel = Number.isFinite(downloads)
        ? `${downloads} download${downloads === 1 ? "" : "s"}`
        : null;
      return fitAnsi(
        flexBetween(
          `${marker} ${stateTone}[${stateLabel}]${color.reset} ${(selected ? color.magenta : color.softInk)}${name}${color.reset}`,
          `${color.fog}${joinMarketBrowserParts([priceLabel, authorLabel, ratingLabel, downloadsLabel])}${color.reset}`,
          width,
        ),
        width,
      );
    }
    if (kind === "governance") {
      const status = String(item?.status ?? "unknown").trim() || "unknown";
      const proposalType = sanitizeInlineText(item?.proposalType ?? "");
      const preview = sanitizeInlineText(item?.payloadPreview ?? "");
      const title = proposalType && preview
        ? `${proposalType}: ${preview}`
        : preview || proposalType || sanitizeInlineText(item?.proposalPda ?? "") || "proposal";
      const proposerLabel = sanitizeInlineText(item?.proposer ?? "")
        ? `by ${sanitizeInlineText(item.proposer)}`
        : null;
      const votesForLabel = item?.votesFor ? `for ${item.votesFor}` : null;
      const votesAgainstLabel = item?.votesAgainst ? `against ${item.votesAgainst}` : null;
      const votersLabel = Number.isFinite(Number(item?.totalVoters))
        ? `${item.totalVoters} voter${Number(item.totalVoters) === 1 ? "" : "s"}`
        : null;
      return fitAnsi(
        flexBetween(
          `${marker} ${marketTaskBrowserStatusTone(status)}[${status}]${color.reset} ${(selected ? color.magenta : color.softInk)}${title}${color.reset}`,
          `${color.fog}${joinMarketBrowserParts([proposerLabel, votesForLabel, votesAgainstLabel, votersLabel])}${color.reset}`,
          width,
        ),
        width,
      );
    }
    if (kind === "disputes") {
      const status = String(item?.status ?? "unknown").trim() || "unknown";
      const resolution = sanitizeInlineText(item?.resolutionType ?? "") || "dispute";
      const disputeLabel = sanitizeInlineText(item?.disputePda ?? "") || sanitizeInlineText(item?.taskPda ?? "") || "record";
      const title = `${resolution} · ${disputeLabel}`;
      const votesForLabel = item?.votesFor ? `for ${item.votesFor}` : null;
      const votesAgainstLabel = item?.votesAgainst ? `against ${item.votesAgainst}` : null;
      const votersLabel = Number.isFinite(Number(item?.totalVoters))
        ? `${item.totalVoters} voter${Number(item.totalVoters) === 1 ? "" : "s"}`
        : null;
      return fitAnsi(
        flexBetween(
          `${marker} ${marketTaskBrowserStatusTone(status)}[${status}]${color.reset} ${(selected ? color.magenta : color.softInk)}${title}${color.reset}`,
          `${color.fog}${[votesForLabel, votesAgainstLabel, votersLabel].filter(Boolean).join(" · ")}${color.reset}`,
          width,
        ),
        width,
      );
    }
    if (kind === "reputation") {
      const registered = item?.registered !== false;
      const stateLabel = registered ? "registered" : "unregistered";
      const stateTone = registered ? color.green : color.fog;
      const subject = sanitizeInlineText(item?.authority ?? item?.agentPda ?? item?.agentId ?? "") || "reputation summary";
      const effectiveLabel = Number.isFinite(Number(item?.effectiveReputation))
        ? `effective ${Number(item.effectiveReputation)}`
        : null;
      const tasksCompleted = String(item?.tasksCompleted ?? "").trim();
      const tasksLabel = tasksCompleted
        ? `${tasksCompleted} task${tasksCompleted === "1" ? "" : "s"}`
        : null;
      const earnedLabel = String(item?.totalEarnedSol ?? "").trim()
        ? `${item.totalEarnedSol} SOL`
        : null;
      return fitAnsi(
        flexBetween(
          `${marker} ${stateTone}[${stateLabel}]${color.reset} ${(selected ? color.magenta : color.softInk)}${subject}${color.reset}`,
          `${color.fog}${joinMarketBrowserParts([effectiveLabel, tasksLabel, earnedLabel])}${color.reset}`,
          width,
        ),
        width,
      );
    }
    const status = String(item?.status ?? "unknown").trim() || "unknown";
    const description = sanitizeInlineText(item?.description ?? "") || "untitled task";
    const workersLabel = Number.isFinite(Number(item?.currentWorkers))
      ? Number.isFinite(Number(item?.maxWorkers))
        ? `${item.currentWorkers}/${item.maxWorkers} workers`
        : `${item.currentWorkers} workers`
      : null;
    const rewardLabel = String(item?.rewardDisplay ?? "").trim() || "n/a";
    return fitAnsi(
      flexBetween(
        `${marker} ${marketTaskBrowserStatusTone(status)}[${status}]${color.reset} ${(selected ? color.magenta : color.softInk)}${description}${color.reset}`,
        `${color.fog}${[rewardLabel, workersLabel].filter(Boolean).join(" · ")}${color.reset}`,
        width,
      ),
      width,
    );
  }

  function marketTaskBrowserDetailLines(item, width, height, browserState) {
    const prefix = "   ";
    const detailWidth = Math.max(12, width - visibleLength(prefix));
    const lines = [];
    const maxRows = Math.max(2, Math.min(6, Math.floor(Math.max(0, Number(height) || 0) / 3)));
    const kind = marketTaskBrowserKind(browserState);
    const pushField = (label, value) => {
      if (value === null || value === undefined || value === "") {
        return;
      }
      const wrapped = wrapBlock(`${label}: ${String(value)}`, detailWidth);
      wrapped.forEach((line) => {
        lines.push(fitAnsi(`${prefix}${color.fog}${line}${color.reset}`, width));
      });
    };
    const pushJoinedField = (label, parts) => {
      const value = joinMarketBrowserParts(parts);
      if (value) {
        pushField(label, value);
      }
    };

    if (kind === "skills") {
      pushJoinedField("skill", [item?.name ?? item?.skillId ?? item?.key ?? null, item?.isActive === false ? "inactive" : "active"]);
      pushJoinedField("identity", [item?.skillId ?? item?.key ?? null, item?.skillPda ?? null]);
      pushField("author", item?.author ?? null);
      if (item?.priceDisplay && item.priceDisplay !== "n/a") {
        pushField(
          "pricing",
          item?.priceLamports
            ? `${item.priceDisplay} (${item.priceLamports} lamports)`
            : item.priceDisplay,
        );
      }
      const rating = Number.isFinite(Number(item?.rating))
        ? Number(item.rating).toFixed(1)
        : null;
      const ratingCount = Number(item?.ratingCount);
      const ratingCountLabel = Number.isFinite(ratingCount) && ratingCount > 0
        ? `${ratingCount} rating${ratingCount === 1 ? "" : "s"}`
        : null;
      const downloadsLabel = marketBrowserCountLabel(item?.downloads, "download");
      const versionLabel = Number.isFinite(Number(item?.version))
        ? `v${Number(item.version)}`
        : null;
      pushJoinedField("activity", [rating && `rating ${rating}`, ratingCountLabel, downloadsLabel, versionLabel]);
      if (Array.isArray(item?.tags) && item.tags.length > 0) {
        pushField("tags", item.tags.join(", "));
      }
      pushJoinedField("timestamps", [
        item?.createdAtLabel ?? item?.createdAt ? `created ${item?.createdAtLabel ?? item?.createdAt}` : null,
        item?.updatedAtLabel ?? item?.updatedAt ? `updated ${item?.updatedAtLabel ?? item?.updatedAt}` : null,
      ]);
      pushField("content hash", item?.contentHash ?? null);
    } else if (kind === "governance") {
      pushJoinedField("proposal", [item?.payloadPreview ?? item?.proposalType ?? item?.proposalPda ?? item?.key ?? null, item?.status ?? null]);
      pushJoinedField("identity", [item?.proposalPda ?? item?.key ?? null, item?.proposalType ?? null]);
      pushField("proposer", item?.proposer ?? null);
      const voteParts = [];
      if (item?.votesFor) voteParts.push(`for ${item.votesFor}`);
      if (item?.votesAgainst) voteParts.push(`against ${item.votesAgainst}`);
      if (Number.isFinite(Number(item?.totalVoters))) voteParts.push(`${item.totalVoters} voters`);
      if (item?.quorum) voteParts.push(`quorum ${item.quorum}`);
      pushField("votes", voteParts.join(" · ") || null);
      pushJoinedField("window", [
        item?.createdAtLabel ?? item?.createdAt ? `created ${item?.createdAtLabel ?? item?.createdAt}` : null,
        item?.votingDeadlineLabel ?? item?.votingDeadline ? `deadline ${item?.votingDeadlineLabel ?? item?.votingDeadline}` : null,
        item?.executionAfterLabel ?? item?.executionAfter ? `execute ${item?.executionAfterLabel ?? item?.executionAfter}` : null,
      ]);
      pushField("title hash", item?.titleHash ?? null);
      pushField("description hash", item?.descriptionHash ?? null);
    } else if (kind === "disputes") {
      pushJoinedField("dispute", [item?.resolutionType ?? item?.disputePda ?? item?.key ?? null, item?.status ?? null]);
      pushJoinedField("identity", [item?.disputePda ?? item?.key ?? null, item?.taskPda ?? null]);
      pushJoinedField("parties", [
        item?.initiator ? `initiator ${item.initiator}` : null,
        item?.defendant ? `defendant ${item.defendant}` : null,
      ]);
      const voteParts = [];
      if (item?.votesFor) voteParts.push(`for ${item.votesFor}`);
      if (item?.votesAgainst) voteParts.push(`against ${item.votesAgainst}`);
      if (Number.isFinite(Number(item?.totalVoters))) voteParts.push(`${item.totalVoters} voters`);
      pushField("votes", voteParts.join(" · ") || null);
      pushJoinedField("timeline", [
        item?.createdAtLabel ?? item?.createdAt ? `created ${item?.createdAtLabel ?? item?.createdAt}` : null,
        item?.votingDeadlineLabel ?? item?.votingDeadline ? `deadline ${item?.votingDeadlineLabel ?? item?.votingDeadline}` : null,
        item?.expiresAtLabel ?? item?.expiresAt ? `expires ${item?.expiresAtLabel ?? item?.expiresAt}` : null,
        item?.resolvedAtLabel ?? item?.resolvedAt ? `resolved ${item?.resolvedAtLabel ?? item?.resolvedAt}` : null,
      ]);
      pushJoinedField("flags", [
        item?.slashApplied === true ? "slash applied" : null,
        item?.initiatorSlashApplied === true ? "initiator slashed" : null,
        item?.initiatedByCreator === true ? "initiated by creator" : null,
      ]);
      pushJoinedField("economics", [item?.workerStakeAtDispute ? `stake ${item.workerStakeAtDispute}` : null, item?.rewardMint ? `mint ${item.rewardMint}` : null]);
      pushField("evidence hash", item?.evidenceHash ?? null);
    } else if (kind === "reputation") {
      pushJoinedField("summary", [item?.authority ?? item?.agentPda ?? item?.agentId ?? null, item?.registered !== false ? "registered" : "unregistered"]);
      pushJoinedField("identity", [item?.agentPda ?? null, item?.agentId ? `agent id ${item.agentId}` : null]);
      pushJoinedField("score", [
        item?.baseReputation !== null && item?.baseReputation !== undefined ? `base ${item.baseReputation}` : null,
        item?.effectiveReputation !== null && item?.effectiveReputation !== undefined ? `effective ${item.effectiveReputation}` : null,
      ]);
      pushJoinedField("activity", [
        item?.tasksCompleted ? `${item.tasksCompleted} task${String(item.tasksCompleted) === "1" ? "" : "s"}` : null,
        item?.totalEarnedSol
          ? `${item.totalEarnedSol} SOL earned${item?.totalEarned ? ` (${item.totalEarned} lamports)` : ""}`
          : item?.totalEarned ? `${item.totalEarned} lamports earned` : null,
        item?.stakedAmountSol
          ? `${item.stakedAmountSol} SOL staked${item?.stakedAmount ? ` (${item.stakedAmount} lamports)` : ""}`
          : item?.stakedAmount ? `${item.stakedAmount} lamports staked` : null,
      ]);
      pushJoinedField("delegations", [
        Array.isArray(item?.inboundDelegations) ? `${item.inboundDelegations.length} inbound` : null,
        Array.isArray(item?.outboundDelegations) ? `${item.outboundDelegations.length} outbound` : null,
      ]);
      pushField("locked until", item?.lockedUntilLabel ?? item?.lockedUntil ?? null);
    } else {
      pushJoinedField("task", [item?.description ?? item?.taskId ?? item?.key ?? null, item?.status ?? null]);
      pushJoinedField("identity", [item?.taskId ?? item?.key ?? null, item?.taskPda ?? null]);
      pushField("creator", item?.creator ?? null);
      if (item?.rewardDisplay && item.rewardDisplay !== "n/a") {
        pushField(
          "economics",
          item?.rewardLamports
            ? `${item.rewardDisplay} (${item.rewardLamports} lamports)`
            : item.rewardDisplay,
        );
      }
      pushJoinedField("delivery", [
        Number.isFinite(Number(item?.currentWorkers)) || Number.isFinite(Number(item?.maxWorkers))
          ? Number.isFinite(Number(item?.maxWorkers))
            ? `${item?.currentWorkers ?? 0}/${item.maxWorkers} workers`
            : `${item?.currentWorkers ?? 0} workers`
          : null,
        item?.deadlineLabel ?? item?.deadline ? `deadline ${item?.deadlineLabel ?? item?.deadline}` : null,
        item?.createdAtLabel ?? item?.createdAt ? `created ${item?.createdAtLabel ?? item?.createdAt}` : null,
      ]);
    }

    if (lines.length <= maxRows) {
      return lines;
    }
    return [
      ...lines.slice(0, maxRows - 1),
      fitAnsi(`${prefix}${color.fog}…${color.reset}`, width),
    ];
  }

  function marketTaskBrowserLines(width, browserState, height = termHeight()) {
    if (browserState.mode === "none") {
      return [];
    }
    const lines = [marketTaskBrowserSummaryLine(width, browserState)];
    const filterLine = marketTaskBrowserFilterLine(width, browserState);
    if (filterLine) {
      lines.push(filterLine);
    }
    const kind = marketTaskBrowserKind(browserState);
    if (browserState.browser?.loading) {
      lines.push(
        fitAnsi(
          `${color.fog}${marketTaskBrowserLoadingLabel(kind)}${color.reset}`,
          width,
        ),
      );
      return lines;
    }
    if (browserState.items.length === 0) {
      lines.push(
        fitAnsi(
          `${color.fog}${marketTaskBrowserEmptyLabel(kind)}${color.reset}`,
          width,
        ),
      );
      return lines;
    }

    const visibleEntries = composerPaletteWindow(
      browserState.items,
      browserState.activeIndex,
      marketTaskBrowserVisibleEntryLimit(height),
    );
    visibleEntries.entries.forEach((item, index) => {
      const absoluteIndex = visibleEntries.start + index;
      const selected = absoluteIndex === browserState.activeIndex;
      lines.push(marketTaskBrowserEntryLine(item, width, browserState, { selected }));
      if (selected && browserState.browser?.expandedTaskKey === item?.key) {
        lines.push(...marketTaskBrowserDetailLines(item, width, height, browserState));
      }
    });
    return lines;
  }

  function currentBottomPopupLayout(width = termWidth(), height = termHeight()) {

    const paletteState = currentComposerPaletteState(64);
    if (paletteState.mode !== "none") {
      return {
        popupState: paletteState,
        popup: composerPaletteLines(width, paletteState, height),
      };
    }
    const marketTaskBrowserState = currentMarketTaskBrowserState();
    return {
      popupState: marketTaskBrowserState,
      popup: marketTaskBrowserLines(width, marketTaskBrowserState, height),
    };
  }

  function currentTranscriptLayout() {
    const width = termWidth();
    const height = termHeight();
    const { popupState, popup } = currentBottomPopupLayout(width, height);
    const popupRows = popup.length;
    const headerRows = headerLines(width).length;
    return buildWatchLayout({
      width,
      height,
      headerRows,
      popupRows,
      slashMode: popupState.mode !== "none",
      detailOpen: Boolean(watchState.expandedEventId),
    });
  }

  function compactSummaryLines(width) {
    const inner = width - 2;
    const elapsed = hasActiveSurfaceRun()
      ? currentRunElapsedLabel()
      : currentSessionElapsedLabel();
    const summary = currentSurfaceSummary();
    const lines = [
      row(
        flexBetween(
          `${chip("RUN", summary.overview.phaseLabel, stateTone(summary.overview.phaseLabel))}`,
          `${chip("LINK", summary.overview.connectionState, stateTone(summary.overview.connectionState))}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("PROVIDER", summary.providerLabel, summary.providerLabel !== "pending" ? "teal" : "slate")}`,
          `${chip("FAILOVER", summary.overview.fallbackState, stateTone(summary.overview.fallbackState))}`,
          inner,
        ),
        color.panelAltBg,
      ),
      row(
        flexBetween(
          `${color.softInk}${truncate(summary.routeLabel, Math.max(24, inner - 10))}${color.reset}`,
          `${color.fog}${elapsed}${color.reset}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("RUNTIME", summary.overview.runtimeState, stateTone(summary.overview.runtimeState))}`,
          `${chip("DURABLE", summary.overview.durableRunsState, stateTone(summary.overview.durableRunsState))}`,
          inner,
        ),
        color.panelAltBg,
      ),
      row(
        flexBetween(
          `${chip("TOOL", summary.overview.latestTool, stateTone(summary.overview.latestToolState))}`,
          `${chip("QUEUE", summary.overview.queuedInputCount, summary.overview.queuedInputCount > 0 ? "amber" : "green")}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("AGENTS", summary.overview.activeAgentCount, summary.overview.activeAgentCount > 0 ? "green" : "slate")}`,
          `${chip("USAGE", summary.overview.usage, summary.overview.usage === "n/a" ? "slate" : "teal")}`,
          inner,
        ),
        color.panelAltBg,
      ),
    ];

    if (summary.objective && summary.objective !== "No active objective") {
      lines.push(
        row(
          flexBetween(
            `${toneColor("teal")}${color.bold}OBJECTIVE${color.reset}`,
            `${color.fog}${summary.overview.sessionToken}${color.reset}`,
            inner,
          ),
          color.panelHiBg,
        ),
      );
      lines.push(
        row(`${color.ink}${truncate(summary.objective, inner)}${color.reset}`, color.panelBg),
      );
    }
    lines.push(
      row(`${color.softInk}${truncate(summary.runtimeLabel, inner)}${color.reset}`, color.panelAltBg),
    );
    if (summary.overview.activeLine && summary.overview.activeLine !== "Awaiting operator prompt") {
      lines.push(
        row(`${color.ink}${truncate(summary.overview.activeLine, inner)}${color.reset}`, color.panelBg),
      );
    }

    return renderPanel({
      title: "CONTROL",
      subtitle: summary.overview.lastActivityAt || elapsed,
      tone: "magenta",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function dagMaskForChar(char) {
    switch (char) {
      case "─":
        return 0b0101;
      case "│":
        return 0b1010;
      case "┌":
        return 0b0110;
      case "┐":
        return 0b0011;
      case "└":
        return 0b1100;
      case "┘":
        return 0b1001;
      case "├":
        return 0b1110;
      case "┤":
        return 0b1011;
      case "┬":
        return 0b0111;
      case "┴":
        return 0b1101;
      case "┼":
        return 0b1111;
      default:
        return 0;
    }
  }

  function dagCharForMask(mask) {
    switch (mask) {
      case 0b0101:
        return "─";
      case 0b1010:
        return "│";
      case 0b0110:
        return "┌";
      case 0b0011:
        return "┐";
      case 0b1100:
        return "└";
      case 0b1001:
        return "┘";
      case 0b1110:
        return "├";
      case 0b1011:
        return "┤";
      case 0b0111:
        return "┬";
      case 0b1101:
        return "┴";
      case 0b1111:
        return "┼";
      default:
        return " ";
    }
  }

  function mergeDagCanvasChar(existing, next) {
    if (!next || next === " ") return existing;
    if (!existing || existing === " ") return next;
    if (existing === next) return existing;
    const mergedMask = dagMaskForChar(existing) | dagMaskForChar(next);
    return dagCharForMask(mergedMask) || next;
  }

  function buildPlannerDagSnapshot() {
    const baseNodes = [...plannerDagNodes.values()].sort((left, right) => left.order - right.order);

    // Inject synthetic child nodes for running subagents showing their live activity
    const syntheticNodes = [];
    const syntheticEdges = [];
    for (const node of baseNodes) {
      if (node.status !== "running" || !node.subagentSessionId) continue;
      const activity = watchState.subagentLiveActivity?.get(node.subagentSessionId);
      if (!activity) continue;
      const childKey = `${node.key}__live`;
      syntheticNodes.push({
        key: childKey,
        stepName: childKey,
        objective: activity,
        stepType: "deterministic_tool",
        status: "running",
        note: activity,
        order: node.order + 0.5,
        tool: null,
        subagentSessionId: node.subagentSessionId,
      });
      syntheticEdges.push({ from: node.key, to: childKey });
    }

    const nodes = [...baseNodes, ...syntheticNodes].sort((left, right) => left.order - right.order);
    const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
    const childrenByKey = new Map(nodes.map((node) => [node.key, []]));
    const parentsByKey = new Map(nodes.map((node) => [node.key, []]));
    const incomingCounts = new Map(nodes.map((node) => [node.key, 0]));

    const allEdges = [...plannerDagEdges, ...syntheticEdges];
    for (const edge of allEdges) {
      if (!nodeByKey.has(edge.from) || !nodeByKey.has(edge.to)) {
        continue;
      }
      childrenByKey.get(edge.from)?.push(edge.to);
      parentsByKey.get(edge.to)?.push(edge.from);
      incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
    }

    for (const children of childrenByKey.values()) {
      children.sort((left, right) => (nodeByKey.get(left)?.order ?? 0) - (nodeByKey.get(right)?.order ?? 0));
    }

    const depthByKey = new Map(nodes.map((node) => [node.key, 0]));
    const queue = nodes
      .filter((node) => (incomingCounts.get(node.key) ?? 0) === 0)
      .map((node) => node.key);
    const remainingIncoming = new Map(incomingCounts);

    while (queue.length > 0) {
      const key = queue.shift();
      if (!key) break;
      const nextDepth = (depthByKey.get(key) ?? 0) + 1;
      for (const child of childrenByKey.get(key) ?? []) {
        depthByKey.set(child, Math.max(depthByKey.get(child) ?? 0, nextDepth));
        remainingIncoming.set(child, Math.max(0, (remainingIncoming.get(child) ?? 0) - 1));
        if ((remainingIncoming.get(child) ?? 0) === 0) {
          queue.push(child);
        }
      }
    }

    const maxDepth = nodes.reduce((max, node) => Math.max(max, depthByKey.get(node.key) ?? 0), 0);
    return {
      nodes,
      nodeByKey,
      childrenByKey,
      parentsByKey,
      depthByKey,
      maxDepth,
    };
  }

  function plannerDagTypeTone(value) {
    switch (value) {
      case "subagent_task":
        return "magenta";
      case "deterministic_tool":
        return "teal";
      case "synthesis":
        return "yellow";
      default:
        return "slate";
    }
  }

  function plannerDagStatusShortLabel(value) {
    switch (value) {
      case "completed":
        return "done";
      case "running":
        return "live";
      case "failed":
        return "fail";
      case "cancelled":
        return "stop";
      case "partial":
        return "part";
      case "needs_verification":
        return "check";
      case "blocked":
        return "hold";
      default:
        return "wait";
    }
  }

  function selectPlannerDagDisplayNodes(snapshot, maxRows) {
    const { nodes } = snapshot;
    if (nodes.length <= maxRows) {
      return {
        nodes,
        hiddenBefore: 0,
        hiddenAfter: 0,
        hiddenTotal: 0,
      };
    }
    const focusStatuses = new Set(["running", "failed", "blocked", "partial", "needs_verification"]);
    const focusKeys = new Set();
    const focusNodes = nodes.filter((node) => focusStatuses.has(node.status));
    const seedNodes = focusNodes.length > 0
      ? focusNodes
      : nodes.slice(-Math.min(2, nodes.length));

    for (const node of seedNodes) {
      focusKeys.add(node.key);
      for (const parent of snapshot.parentsByKey.get(node.key) ?? []) {
        focusKeys.add(parent);
      }
      for (const child of snapshot.childrenByKey.get(node.key) ?? []) {
        focusKeys.add(child);
      }
    }

    const sortedNodes = [...nodes];
    const displayKeys = new Set(focusKeys);
    for (const node of [...sortedNodes].reverse()) {
      if (displayKeys.size >= maxRows) {
        break;
      }
      displayKeys.add(node.key);
    }
    const displayNodes = sortedNodes.filter((node) => displayKeys.has(node.key)).slice(-maxRows);
    const hiddenIndices = sortedNodes
      .map((node, index) => (displayKeys.has(node.key) ? -1 : index))
      .filter((index) => index >= 0);
    return {
      nodes: displayNodes,
      hiddenBefore: hiddenIndices.length > 0 ? hiddenIndices[0] : 0,
      hiddenAfter:
        hiddenIndices.length > 0
          ? Math.max(0, sortedNodes.length - (hiddenIndices[hiddenIndices.length - 1] + 1))
          : 0,
      hiddenTotal: Math.max(0, sortedNodes.length - displayNodes.length),
    };
  }

  function plannerDagLabelLine(node, id, width) {
    const isSynthetic = node.key?.endsWith("__live");
    const statusTone = plannerDagStatusTone(node.status);
    const typeTone = plannerDagTypeTone(node.stepType);
    const shortStatus = plannerDagStatusShortLabel(node.status);
    const baseLabel = isSynthetic
      ? sanitizeInlineText(node.note ?? node.objective ?? "working")
      : sanitizePlanLabel(
        node.stepName ?? node.objective,
        node.tool || "unnamed step",
      );
    const idLabel = isSynthetic ? `${color.fog}↳${color.reset}` : `${toneColor(statusTone)}${color.bold}${id}${color.reset}${toneColor(typeTone)}${plannerDagTypeGlyph(node.stepType)}${color.reset}`;
    const left = `${idLabel} ${truncate(baseLabel, Math.max(10, width - 9))}`;
    const right = isSynthetic ? "" : `${toneColor(statusTone)}${shortStatus}${color.reset}`;
    return flexBetween(left, right, width);
  }

  function plannerDagInfoLines(width, displayNodes, { hiddenBefore = 0, hiddenAfter = 0, hiddenTotal = 0 } = {}) {
    const lines = [];
    if (hiddenTotal > 0) {
      const hiddenParts = [];
      if (hiddenBefore > 0) {
        hiddenParts.push(`${hiddenBefore} earlier`);
      }
      if (hiddenAfter > 0) {
        hiddenParts.push(`${hiddenAfter} later`);
      }
      const focusSummary = hiddenParts.length > 0
        ? hiddenParts.join(" · ")
        : `${hiddenTotal} focused offstage`;
      lines.push(`${color.fog}… ${focusSummary} · ${hiddenTotal} node${hiddenTotal === 1 ? "" : "s"} offstage${color.reset}`);
    }

    const focusNodes = displayNodes.filter((node) =>
      node.status === "running" ||
      node.status === "failed" ||
      node.status === "blocked" ||
      node.status === "partial" ||
      node.status === "needs_verification"
    );
    const focusNote = focusNodes
      .map((node) => sanitizeInlineText(node.note || node.objective || ""))
      .find(Boolean);
    if (focusNote) {
      lines.push(`${color.softInk}${truncate(focusNote, width)}${color.reset}`);
    } else if (watchState.plannerDagNote) {
      lines.push(`${color.fog}${truncate(watchState.plannerDagNote, width)}${color.reset}`);
    }

    return lines.slice(0, 2);
  }

  function dagWidgetLines(width, maxCanvasLines = 8) {
    const snapshot = buildPlannerDagSnapshot();
    const { nodes, childrenByKey, depthByKey } = snapshot;
    const runningCount = nodes.filter((node) => node.status === "running").length;
    const failedCount = nodes.filter((node) => node.status === "failed").length;
    const completedCount = nodes.filter((node) => node.status === "completed").length;
    const updatedAt = watchState.plannerDagUpdatedAt > 0 ? formatClockLabel(watchState.plannerDagUpdatedAt) : "--:--:--";
    const header = flexBetween(
      `${toneColor(plannerDagStatusTone(watchState.plannerDagStatus))}${color.bold}LIVE DAG${color.reset}`,
      `${color.fog}${nodes.length} node${nodes.length === 1 ? "" : "s"}  ${updatedAt}${color.reset}`,
      width,
    );
    const metrics = flexBetween(
      `${chip("LIVE", runningCount, runningCount > 0 ? "cyan" : "slate")}  ${chip("DONE", completedCount, completedCount > 0 ? "green" : "slate")}`,
      `${chip("FAIL", failedCount, failedCount > 0 ? "red" : "slate")}`,
      width,
    );

    if (nodes.length === 0) {
      if (hasActiveSurfaceRun()) {
        const phaseLabel = sanitizeInlineText(currentPhaseLabel() || "thinking");
        const objective = currentDisplayObjective("");
        const pendingHeader = flexBetween(
          `${toneColor("cyan")}${color.bold}LIVE DAG${color.reset}`,
          `${color.fog}${formatClockLabel(nowMs())}${color.reset}`,
          width,
        );
        const activeLabel = phaseLabel === "planner"
          ? "planning"
          : phaseLabel === "thinking" || phaseLabel === "idle"
            ? "direct response"
            : phaseLabel;
        const lines = [
          pendingHeader,
          `${toneColor("cyan")}${plannerDagStatusGlyph("running")}${color.reset} ${color.softInk}${truncate(activeLabel, Math.max(12, width - 4))}${color.reset}`,
        ];
        if (objective) {
          lines.push(`${color.fog}${truncate(objective, width)}${color.reset}`);
        }
        return lines;
      }
      const lines = [
        header,
        metrics,
      ];
      if (watchState.plannerDagNote) {
        lines.push(`${color.fog}${truncate(watchState.plannerDagNote, width)}${color.reset}`);
      }
      return lines;
    }

    const display = selectPlannerDagDisplayNodes(snapshot, Math.max(3, maxCanvasLines));
    const displayNodes = display.nodes;
    const displayIndexByKey = new Map(displayNodes.map((node, index) => [node.key, index]));
    const maxDisplayDepth = displayNodes.reduce(
      (max, node) => Math.max(max, depthByKey.get(node.key) ?? 0),
      0,
    );
    const graphWidth = Math.max(
      12,
      Math.min(
        24,
        width - 14,
        maxDisplayDepth > 0 ? 4 + maxDisplayDepth * 5 : 12,
      ),
    );
    const labelWidth = Math.max(12, width - graphWidth - 2);
    const depthSpan = Math.max(1, maxDisplayDepth);
    const xByKey = new Map(
      displayNodes.map((node) => [
        node.key,
        maxDisplayDepth > 0
          ? Math.max(
            1,
            Math.min(
              graphWidth - 2,
              1 + Math.round(((depthByKey.get(node.key) ?? 0) * (graphWidth - 3)) / depthSpan),
            ),
          )
          : 1,
      ]),
    );
    const yByKey = new Map(displayNodes.map((node, index) => [node.key, index]));
    const canvas = Array.from(
      { length: displayNodes.length },
      () => Array.from({ length: graphWidth }, () => " "),
    );
    const placeDagChar = (x, y, char) => {
      if (y < 0 || y >= displayNodes.length || x < 0 || x >= graphWidth) return;
      canvas[y][x] = mergeDagCanvasChar(canvas[y][x], char);
    };
    const drawHorizontal = (y, left, right) => {
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      for (let x = start; x <= end; x += 1) {
        placeDagChar(x, y, "─");
      }
    };
    const drawVertical = (x, top, bottom) => {
      const start = Math.min(top, bottom);
      const end = Math.max(top, bottom);
      for (let y = start; y <= end; y += 1) {
        placeDagChar(x, y, "│");
      }
    };

    for (const node of displayNodes) {
      const childKeys = childrenByKey.get(node.key) ?? [];
      const fromX = xByKey.get(node.key) ?? 1;
      const fromY = yByKey.get(node.key) ?? 0;
      for (const childKey of childKeys) {
        if (!displayIndexByKey.has(childKey)) {
          continue;
        }
        const toX = xByKey.get(childKey) ?? fromX + 4;
        const toY = yByKey.get(childKey) ?? fromY;
        const startX = Math.min(graphWidth - 2, fromX + 1);
        const endX = toX > fromX
          ? Math.max(0, toX - 1)
          : Math.min(graphWidth - 2, toX + 1);
        const bendX = toX > fromX
          ? Math.max(startX, Math.min(endX, Math.floor((startX + endX) / 2)))
          : Math.min(graphWidth - 2, Math.max(startX + 1, fromX + 2));
        drawHorizontal(fromY, startX, bendX);
        drawVertical(bendX, fromY, toY);
        drawHorizontal(toY, Math.min(bendX, endX), Math.max(bendX, endX));
      }
    }

    const idByKey = new Map(
      displayNodes.map((node, index) => [
        node.key,
        "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[index] ?? String((index + 1) % 10),
      ]),
    );
    const nodeKeyByCoordinate = new Map(
      displayNodes.map((node) => [`${yByKey.get(node.key) ?? 0}:${xByKey.get(node.key) ?? 1}`, node.key]),
    );
    const lines = [
      header,
      metrics,
      ...displayNodes.map((node, rowIndex) => {
        let graphText = "";
        for (let columnIndex = 0; columnIndex < graphWidth; columnIndex += 1) {
          const key = nodeKeyByCoordinate.get(`${rowIndex}:${columnIndex}`);
          if (key) {
            const activeNode = snapshot.nodeByKey.get(key) ?? node;
            graphText += `${toneColor(plannerDagStatusTone(activeNode.status))}${plannerDagStatusGlyph(activeNode.status)}${color.reset}`;
            continue;
          }
          const char = canvas[rowIndex][columnIndex] ?? " ";
          graphText += char.trim().length > 0
            ? `${color.fog}${char}${color.reset}`
            : " ";
        }
        return `${fitAnsi(graphText.replace(/\s+$/g, ""), graphWidth)}  ${plannerDagLabelLine(node, idByKey.get(node.key) ?? "?", labelWidth)}`;
      }),
      ...plannerDagInfoLines(width, displayNodes, display),
    ];

    return lines;
  }

  function contextPanelLines(width) {
    const inner = width - 2;
    const elapsed = currentSessionElapsedLabel();
    const summary = currentSurfaceSummary();
    return renderPanel({
      title: "GUARD",
      subtitle: `${elapsed} attached`,
      tone:
        summary.attention.approvalAlertCount > 0
          ? "red"
          : summary.attention.errorAlertCount > 0
            ? "amber"
            : "teal",
      width,
      bg: color.panelBg,
      lines: [
        row(
          flexBetween(
            `${chip("MODE", summary.overview.transcriptMode, summary.overview.transcriptMode === "follow" ? "green" : summary.overview.transcriptMode === "detail" ? "cyan" : "amber")}`,
            `${chip("SESS", summary.overview.sessionToken, "slate")}`,
            inner,
          ),
          color.panelBg,
        ),
        row(
          flexBetween(
            `${chip("AUTH", summary.attention.approvalAlertCount, summary.attention.approvalAlertCount > 0 ? "red" : "green")}`,
            `${chip("ERR", summary.attention.errorAlertCount, summary.attention.errorAlertCount > 0 ? "amber" : "green")}`,
            inner,
          ),
          color.panelAltBg,
        ),
        row(
          flexBetween(
            `${chip("ACTIVE", summary.overview.durableActiveTotal, summary.overview.durableActiveTotal > 0 ? "cyan" : "slate")}`,
            `${chip("WAKE", summary.overview.durableQueuedSignalsTotal, summary.overview.durableQueuedSignalsTotal > 0 ? "amber" : "slate")}`,
            inner,
          ),
          color.panelBg,
        ),
        row(
          `${color.softInk}${truncate(summary.overview.runtimeLabel, inner)}${color.reset}`,
          color.panelAltBg,
        ),
        row("", color.panelBg),
        row(`${color.fog}${color.bold}RECENT ALERTS${color.reset}`, color.panelHiBg),
        ...(summary.attention.items.length > 0
          ? summary.attention.items.flatMap((item, index) => [
            row(
              `${toneColor(item.tone)}${truncate(item.timestamp, 10)}${color.reset} ${color.ink}${truncate(item.title, Math.max(18, inner - 12))}${color.reset}`,
              index % 2 === 0 ? color.panelBg : color.panelAltBg,
            ),
          ])
          : [row(`${color.softInk}No approval alerts or runtime faults.${color.reset}`, color.panelBg)]),
      ],
    });
  }

  function toolTimelinePanelLines(width, limit = 5) {
    const inner = width - 2;
    const summary = currentSurfaceSummary();
    const lines = [
      row(
        flexBetween(
          `${chip("LATEST", summary.overview.latestTool, stateTone(summary.overview.latestToolState))}`,
          `${chip("PLAN", summary.overview.planCount, summary.overview.planCount > 0 ? "magenta" : "slate")}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("AGENTS", summary.overview.activeAgentCount, summary.overview.activeAgentCount > 0 ? "green" : "slate")}`,
          `${chip("RUNTIME", summary.overview.runtimeState, stateTone(summary.overview.runtimeState))}`,
          inner,
        ),
        color.panelAltBg,
      ),
    ];

    if (summary.recentTools.length === 0) {
      lines.push(row(`${color.softInk}No recent tool activity.${color.reset}`, color.panelBg));
    } else {
      for (const [index, item] of summary.recentTools.slice(0, limit).entries()) {
        const bg = index % 2 === 0 ? color.panelBg : color.panelAltBg;
        lines.push(
          row(
            `${toneColor(item.tone)}${truncate(item.timestamp, 10)}${color.reset} ${color.ink}${truncate(item.title, Math.max(18, inner - 12))}${color.reset}`,
            bg,
          ),
        );
        lines.push(
          row(
            `${color.fog}${truncate(item.meta, inner)}${color.reset}`,
            bg,
          ),
        );
      }
    }

    return renderPanel({
      title: "TOOLS",
      subtitle: `${summary.recentTools.length} recent`,
      tone: summary.recentTools.length > 0 ? "teal" : "slate",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function agentsPanelLines(width, limit = 6, showSessionTokens = true) {
    const inner = width - 2;
    const planEntries = activePlanEntries(24);
    const activeAgents = activeAgentEntries(24);
    const terminalAgents = planEntries
      .filter((step) => step.status === "completed" || step.status === "failed" || step.status === "cancelled")
      .sort((left, right) => right.updatedAt - left.updatedAt || right.order - left.order)
      .slice(0, Math.max(1, limit));
    const completedCount = planEntries.filter((step) => step.status === "completed").length;
    const failedCount = planEntries.filter((step) => step.status === "failed").length;
    const lines = [
      row(
        flexBetween(
          `${chip("ACTIVE", activeAgents.length, activeAgents.length > 0 ? "green" : "slate")}`,
          `${chip("DONE", completedCount, completedCount > 0 ? "teal" : "slate")}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("FAIL", failedCount, failedCount > 0 ? "red" : "slate")}`,
          `${chip("QUEUE", queuedOperatorInputs.length, queuedOperatorInputs.length > 0 ? "amber" : "slate")}`,
          inner,
        ),
        color.panelAltBg,
      ),
    ];

    const displayAgents = activeAgents.length > 0
      ? activeAgents.slice(0, limit)
      : terminalAgents.slice(0, limit);

    if (displayAgents.length === 0) {
      lines.push(row(`${color.softInk}No delegated agents running.${color.reset}`, color.panelBg));
    } else {
      for (const [index, step] of displayAgents.entries()) {
        const tone = planStatusTone(step.status);
        const bg = index % 2 === 0 ? color.panelBg : color.panelAltBg;
        const label = `${toneColor(tone)}${planStatusGlyph(step.status)} ${planStepDisplayName(step, Math.max(16, inner - 6))}${color.reset}`;
        const token = compactSessionToken(step.subagentSessionId);
        const liveActivity = step.subagentSessionId
          ? sanitizeInlineText(subagentLiveActivity?.get(step.subagentSessionId) ?? "")
          : "";
        const note = sanitizeInlineText(liveActivity || step.note || step.objective || "");
        lines.push(row(label, bg));
        if (note) {
          lines.push(row(`${color.fog}${truncate(note, inner)}${color.reset}`, bg));
        } else if (token && showSessionTokens) {
          lines.push(row(`${color.fog}${truncate(`child ${token}`, inner)}${color.reset}`, bg));
        }
      }
    }

    return renderPanel({
      title: "AGENTS",
      subtitle: `${activeAgents.length} active`,
      tone: activeAgents.length > 0 ? "green" : "slate",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function cockpitPanelLines(width) {
    const inner = width - 2;
    const cockpit = watchState.cockpit;
    const lines = [];
    if (!cockpit || typeof cockpit !== "object") {
      lines.push(row(`${color.softInk}Cockpit data pending.${color.reset}`, color.panelBg));
    } else {
      const dirtyCounts = cockpit.repo?.dirtyCounts ?? {};
      const dirtyTotal =
        Number(dirtyCounts.staged ?? 0) +
        Number(dirtyCounts.unstaged ?? 0) +
        Number(dirtyCounts.untracked ?? 0);
      lines.push(
        row(
          flexBetween(
            `${chip("GIT", cockpit.repo?.branch ?? "n/a", cockpit.repo?.branch ? "teal" : "slate")}`,
            `${chip("DIRTY", dirtyTotal, dirtyTotal > 0 ? "amber" : "green")}`,
            inner,
          ),
          color.panelBg,
        ),
      );
      lines.push(
        row(
          flexBetween(
            `${chip("REVIEW", cockpit.review?.status ?? "idle", stateTone(cockpit.review?.status ?? "idle"))}`,
            `${chip("VERIFY", cockpit.verification?.verdict ?? cockpit.verification?.status ?? "idle", stateTone(cockpit.verification?.verdict ?? cockpit.verification?.status ?? "idle"))}`,
            inner,
          ),
          color.panelAltBg,
        ),
      );
      lines.push(
        row(
          flexBetween(
            `${chip("APPROVALS", cockpit.approvals?.count ?? 0, Number(cockpit.approvals?.count ?? 0) > 0 ? "red" : "green")}`,
            `${chip("OWNERS", Array.isArray(cockpit.ownership) ? cockpit.ownership.length : 0, Array.isArray(cockpit.ownership) && cockpit.ownership.length > 0 ? "cyan" : "slate")}`,
            inner,
          ),
          color.panelBg,
        ),
      );
      lines.push(
        row(
          `${color.softInk}${truncate(`worktrees: ${Array.isArray(cockpit.worktrees?.entries) ? cockpit.worktrees.entries.length : 0}`, inner)}${color.reset}`,
          color.panelAltBg,
        ),
      );
      const changedFiles = Array.isArray(cockpit.repo?.changedFiles)
        ? cockpit.repo.changedFiles
        : [];
      if (changedFiles.length > 0) {
        lines.push(row(`${color.fog}${color.bold}CHANGES${color.reset}`, color.panelHiBg));
        for (const [index, file] of changedFiles.slice(0, 4).entries()) {
          lines.push(
            row(
              `${color.softInk}${truncate(file, inner)}${color.reset}`,
              index % 2 === 0 ? color.panelBg : color.panelAltBg,
            ),
          );
        }
      }
      const ownership = Array.isArray(cockpit.ownership) ? cockpit.ownership : [];
      if (ownership.length > 0) {
        lines.push(row(`${color.fog}${color.bold}OWNERSHIP${color.reset}`, color.panelHiBg));
        for (const [index, entry] of ownership.slice(0, 4).entries()) {
          const bg = index % 2 === 0 ? color.panelBg : color.panelAltBg;
          lines.push(
            row(
              `${toneColor(stateTone(entry.state))}${truncate(`${entry.role} ${entry.state}`, inner)}${color.reset}`,
              bg,
            ),
          );
          const detail = entry.worktreePath ?? entry.childSessionId ?? entry.taskSubject;
          if (detail) {
            lines.push(
              row(
                `${color.fog}${truncate(detail, inner)}${color.reset}`,
                bg,
              ),
            );
          }
        }
      }
    }
    return renderPanel({
      title: "COCKPIT",
      subtitle: watchState.cockpitUpdatedAt ? `${currentSessionElapsedLabel()} attached` : "waiting",
      tone: watchState.cockpit ? "teal" : "slate",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function sidebarObjectiveHeader(width) {
    const inner = width - 2;
    const summary = currentSurfaceSummary();
    const lines = [];
    if (summary.objective && summary.objective !== "No active objective") {
      lines.push(
        paintSurface(
          `${toneColor("teal")}${color.bold}OBJ${color.reset} ${color.ink}${truncate(summary.objective, inner - 4)}${color.reset}`,
          width,
          color.panelBg,
        ),
      );
    }
    if (summary.overview.activeLine && summary.overview.activeLine !== "Awaiting operator prompt" &&
        summary.overview.activeLine !== summary.objective) {
      lines.push(
        paintSurface(
          `${color.softInk}${truncate(summary.overview.activeLine, inner)}${color.reset}`,
          width,
          color.panelAltBg,
        ),
      );
    }
    return lines;
  }

  function sidebarLines(width, targetHeight) {
    const policy = buildWatchSidebarPolicy(targetHeight);
    const summarySection = sidebarObjectiveHeader(width);
    const dagSnapshot = buildPlannerDagSnapshot();
    const hasDagNodes = dagSnapshot.nodes.length > 0;
    const optionalSections = [];

    // Always show tools panel — it's the primary sidebar content for direct tool paths
    const toolsSection = toolTimelinePanelLines(width, hasDagNodes ? policy.toolLimit : policy.toolLimit + 3);
    const guardSection = policy.showGuard ? contextPanelLines(width) : null;
    const cockpitSection = cockpitPanelLines(width);
    const agentsSection = policy.showAgents
      ? agentsPanelLines(width, policy.compactAgentLimit, policy.showSessionTokens)
      : null;

    // Only show DAG when there are actual planner nodes
    if (hasDagNodes) {
      const dagDesiredRows = Math.max(
        policy.minDagRows,
        Math.min(
          Math.max(0, targetHeight - summarySection.length - 1),
          dagSnapshot.nodes.length + 4,
        ),
      );
      optionalSections.push(dagWidgetLines(width, dagDesiredRows));
    }

    for (const candidate of [toolsSection, guardSection, cockpitSection, agentsSection]) {
      if (!candidate) {
        continue;
      }
      optionalSections.push(candidate);
    }

    const sections = [summarySection, ...optionalSections];
    const rows = [];
    for (const section of sections) {
      if (rows.length > 0) {
        rows.push("");
      }
      rows.push(...section);
    }
    while (rows.length < targetHeight) {
      rows.push(blankRow(width));
    }
    return rows;
  }

  function eventPreviewLines(event, width) {
    const sourcePreview = isSourcePreviewEvent(event);
    const mutationPreview = isMutationPreviewEvent(event);
    const markdownPreview = isMarkdownRenderableEvent(event);
    const latestEvent = events[events.length - 1] ?? null;
    const latestIsCurrent = latestEvent?.id === event?.id;
    const viewportLines = Math.max(12, termHeight() - 9);
    const maxLines = computeTranscriptPreviewMaxLines({
      eventKind: event.kind,
      sourcePreview,
      mutationPreview,
      latestIsCurrent,
      following: isTranscriptFollowing(),
      viewportLines,
      maxPreviewSourceLines,
    });
    const sourceLines =
      sourcePreview || markdownPreview || event.kind === "you" || event.kind === "subagent"
        ? buildEventDisplayLines(event, maxPreviewSourceLines)
        : compactBodyLines(event.body, Math.max(maxLines + 2, 4))
          .map((line) => createDisplayLine(line, "plain"));
    const wrapped =
      sourcePreview || markdownPreview
        ? wrapEventDisplayLines(event, width, sourcePreview ? maxPreviewSourceLines : maxPreviewSourceLines)
        : wrapDisplayLines(sourceLines, width);
    if (wrapped.length <= maxLines) {
      return wrapped;
    }
    const preview = wrapped.slice(0, maxLines);
    const lastIndex = preview.length - 1;
    const truncatedText = `${truncate(displayLineText(preview[lastIndex]).trimEnd(), Math.max(8, width - 1))}…`;
    preview[lastIndex] = {
      ...preview[lastIndex],
      text: truncatedText,
      plainText: truncatedText,
    };
    return preview;
  }

  function eventDetailVariant(event) {
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.detailBody !== "string" ||
      event.detailBody.trim().length === 0 ||
      event.detailBody === event.body
    ) {
      return event;
    }
    return {
      ...event,
      body: event.detailBody,
      bodyTruncated: false,
    };
  }

  function eventHasHiddenPreview(event, width) {
    if (eventDetailVariant(event) !== event) {
      return true;
    }
    const sourcePreview = isSourcePreviewEvent(event);
    const markdownPreview = isMarkdownRenderableEvent(event);
    const displayLinePreview =
      sourcePreview ||
      markdownPreview ||
      event?.kind === "you" ||
      event?.kind === "subagent";
    const wrapped =
      sourcePreview || markdownPreview
        ? wrapEventDisplayLines(event, width, maxPreviewSourceLines * 8)
        : displayLinePreview
          ? wrapDisplayLines(buildEventDisplayLines(event, maxPreviewSourceLines * 8), width)
        : wrapDisplayLines(
          compactBodyLines(event.body, maxPreviewSourceLines * 2).map((line) => createDisplayLine(line)),
          width,
        );
    return event.bodyTruncated || wrapped.length > eventPreviewLines(event, width).length;
  }

  function latestExpandableEvent() {
    const { transcriptWidth } = currentTranscriptLayout();
    const previewWidth = Math.max(12, transcriptWidth - 4);
    for (let index = events.length - 1; index >= Math.max(0, events.length - 20); index -= 1) {
      const candidate = events[index];
      if (!candidate) {
        continue;
      }
      if (eventHasHiddenPreview(candidate, previewWidth)) {
        return candidate;
      }
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event && (isSourcePreviewEvent(event) || isMarkdownRenderableEvent(event))) {
        return event;
      }
    }
    return events[events.length - 1] ?? null;
  }

  function currentExpandedEvent() {
    if (!watchState.expandedEventId) {
      return null;
    }
    return events.find((event) => event.id === watchState.expandedEventId) ?? null;
  }

  function toggleExpandedEvent() {
    if (watchState.expandedEventId) {
      watchState.expandedEventId = null;
      watchState.detailScrollOffset = 0;
      setTransientStatus("detail closed");
      return;
    }
    const target = latestExpandableEvent();
    if (!target) {
      setTransientStatus("no detail available");
      return;
    }
    watchState.expandedEventId = target.id;
    watchState.detailScrollOffset = 0;
    setTransientStatus(`detail open: ${target.title}`);
  }

  function eventHeadline(event, previewLines) {
    const { headline } = splitTranscriptPreviewForHeadline(event, previewLines);
    switch (event.kind) {
      case "you":
        return headline || sanitizeDisplayText(event.title);
      case "tool":
      case "tool result":
      case "tool error":
      case "subagent":
      case "subagent tool":
      case "subagent tool result":
      case "subagent error":
        return sanitizeDisplayText(event.title);
      case "queued":
        return headline || "Queued input";
      case "operator":
        return sanitizeDisplayText(event.title);
      case "agent":
        return headline || sanitizeDisplayText(event.title);
      default:
        return sanitizeDisplayText(event.title);
    }
  }

  function shouldShowEventBody(event, { showBody = true } = {}) {
    return showBody && event.kind !== "queued";
  }

  function isRoomyAgentDisplayMode(mode) {
    const normalized = String(mode ?? "");
    return normalized === "plain" ||
      normalized === "paragraph" ||
      normalized === "list" ||
      normalized === "quote" ||
      normalized === "heading";
  }

  function isTableDisplayMode(mode) {
    const normalized = String(mode ?? "");
    return normalized === "table-divider" ||
      normalized === "table-header" ||
      normalized === "table-row";
  }


  function shouldUseWidthAwareAgentLines(baseLines, widthAwareLines) {
    if (!Array.isArray(widthAwareLines) || widthAwareLines.length === 0) {
      return false;
    }
    const anchor = (Array.isArray(baseLines) ? baseLines : [])
      .map((line) => displayLinePlainText(line).trim())
      .find((line) => line.length > 0);
    if (!anchor) {
      return true;
    }
    const widthAwareText = widthAwareLines
      .map((line) => displayLinePlainText(line))
      .join("\n");
    return widthAwareText.includes(anchor.slice(0, Math.min(anchor.length, 18)));
  }

  function fullAgentTranscriptLines(event, width) {
    const previewWidth = Math.max(12, width - 4);
    const baseLines = buildEventDisplayLines(eventDetailVariant(event), Infinity);
    const widthAwareLines = wrapEventDisplayLines(eventDetailVariant(event), previewWidth, Infinity);
    const displayLines = shouldUseWidthAwareAgentLines(baseLines, widthAwareLines)
      ? widthAwareLines
      : baseLines;
    if (!Array.isArray(displayLines) || displayLines.length === 0) {
      return [];
    }
    const rows = [];
    displayLines.forEach((line, index) => {
      const entry = typeof line === "string" ? createDisplayLine(line, "plain") : line;
      const plainText = displayLinePlainText(entry).trim();
      if (entry?.mode === "blank" || plainText.length === 0) {
        if (rows.length > 0 && rows.at(-1)?.mode !== "blank") {
          rows.push(createDisplayLine("", "blank"));
        }
        return;
      }
      rows.push(...wrapDisplayLines([entry], previewWidth));
      const hasLaterContent = displayLines.slice(index + 1).some((candidate) => {
        const candidateText = displayLinePlainText(candidate).trim();
        return String(candidate?.mode ?? "") !== "blank" && candidateText.length > 0;
      });
      if (hasLaterContent && isRoomyAgentDisplayMode(entry?.mode)) {
        rows.push(createDisplayLine("", "blank"));
      }
    });
    while (rows.at(-1)?.mode === "blank") {
      rows.pop();
    }
    return rows;
  }

  function renderEventBlock(event, width, { showBody = true } = {}) {
    const rows = [];
    const previewLines = eventPreviewLines(event, Math.max(12, width - 4));
    const previewSplit = splitTranscriptPreviewForHeadline(event, previewLines);
    const summary = buildTranscriptEventSummary(
      event,
      previewLines.map((line) => displayLinePlainText(line)),
    );
    const badgeTone = toneColor(summary.badge.tone);
    const badgeText = `${badgeTone}${summary.badge.label}${color.reset}`;
    const headline = previewSplit.headline || eventHeadline(event, previewLines);
    if (event.kind === "you" || event.kind === "queued") {
      const blockLines = [headline, ...previewSplit.bodyLines]
        .map((line) => sanitizeDisplayText(
          typeof line === "string" ? line : displayLinePlainText(line),
        ))
        .filter((line) => line.length > 0);
      rows.push(
        ...transcriptInputBlock(
          blockLines.length > 0 ? blockLines : [sanitizeDisplayText(event.title)],
          width,
          event.kind === "queued"
            ? { tone: color.fog, background: transcriptQueuedBg, marker: ">", markerTone: color.fog }
            : undefined,
        ),
      );
      return rows;
    }
    if (event.kind === "agent") {
      const fullAgentLines = fullAgentTranscriptLines(event, width);
      const agentSplit =
        fullAgentLines.length > 0
          ? isTableDisplayMode(fullAgentLines[0]?.mode)
            ? { headline, bodyLines: fullAgentLines }
            : splitTranscriptPreviewForHeadline(event, fullAgentLines)
          : previewSplit;
      rows.push(
        ...transcriptChatRows([agentSplit.headline || headline], width, {
          marker: "●",
          markerTone: color.ink,
          textTone: color.ink,
        }),
      );
      if (fullAgentLines.length > 0) {
        for (const line of agentSplit.bodyLines) {
          const plain = sanitizeDisplayText(
            typeof line === "string" ? line : displayLinePlainText(line),
          );
          if (plain.length === 0) {
            rows.push(fitAnsi(transcriptBodyInset, width));
            continue;
          }
          rows.push(fitAnsi(renderEventBodyLine(event, line, {
            inline: true,
            prefix: transcriptBodyInset,
          }), width));
        }
        return rows;
      }
      rows.push(
        ...transcriptChatRows(agentSplit.bodyLines, width, {
          marker: "●",
          markerTone: color.ink,
          textTone: color.ink,
        }),
      );
      return rows;
    }
    rows.push(
      fitAnsi(
        `${transcriptBlockInset}${badgeText} ${color.ink}${sanitizeDisplayText(headline)}${color.reset}`,
        width,
      ),
    );
    if (summary.meta && summary.meta !== sanitizeDisplayText(headline)) {
      rows.push(
        `${transcriptBodyInset}${color.softInk}${truncate(summary.meta, Math.max(10, width - visibleLength(transcriptBodyInset)))}${color.reset}`,
      );
    }

    if (shouldShowEventBody(event, { showBody })) {
      previewSplit.bodyLines.forEach((line) => {
        rows.push(renderEventBodyLine(event, line, { inline: true, prefix: transcriptBodyInset }));
      });
    }
    return rows;
  }

  // Cache for the streaming preview block. The markdown builder is the
  // hot path during chunk streaming — every chunk arrival invalidates
  // watchState.agentStreamingText and triggers a render, which rebuilds
  // the streaming block. Memoizing by (committedPortion, width) avoids
  // re-parsing the whole accumulated markdown on every delta. Claude
  // Code uses a stable-prefix re-lex with an LRU token cache
  // (components/Markdown.tsx:22-71, 186-234); this is the lightweight
  // equivalent — full re-parse only when the committed text changes.
  const streamingPreviewCache = { text: null, width: null, rows: null };

  function buildStreamingPreviewBlock(width) {
    // Render the in-flight assistant stream as agent-style rows below the
    // committed transcript. Claude Code pattern (screens/REPL.tsx:1458-
    // 1473): only complete lines (up through the last "\n") are shown;
    // the incomplete trailing line is hidden until its newline arrives.
    // This avoids mid-word flicker without losing streaming feel.
    //
    // `commitAgentMessage` clears watchState.agentStreamingText atomically
    // when the final chat.message lands, so this block disappears and the
    // committed agent event takes its place with the canonical final
    // text. Defensive fallback for stop-hook/verification rejection is
    // preserved: the commit is authoritative, so any streamed partial
    // that never gets committed simply vanishes when a new turn starts.
    const streamingText =
      typeof watchState.agentStreamingText === "string"
        ? watchState.agentStreamingText
        : null;
    if (!streamingText || streamingText.length === 0) {
      return [];
    }
    const lastNewlineIndex = streamingText.lastIndexOf("\n");
    const committedPortion =
      lastNewlineIndex >= 0
        ? streamingText.slice(0, lastNewlineIndex + 1)
        : "";
    if (committedPortion.length === 0) {
      return [];
    }
    if (
      streamingPreviewCache.text === committedPortion &&
      streamingPreviewCache.width === width &&
      Array.isArray(streamingPreviewCache.rows)
    ) {
      return streamingPreviewCache.rows;
    }
    const previewWidth = Math.max(12, width - 4);
    const displayLines = buildStreamingMarkdownDisplayLines(committedPortion, {
      width: previewWidth,
    });
    if (!Array.isArray(displayLines) || displayLines.length === 0) {
      return [];
    }
    const rows = [];
    let markerEmitted = false;
    displayLines.forEach((entry) => {
      const line =
        typeof entry === "string" ? entry : displayLinePlainText(entry);
      const trimmed = sanitizeDisplayText(line ?? "").trimEnd();
      if (trimmed.length === 0) {
        if (rows.length > 0 && !markerEmitted) {
          return;
        }
        if (rows.length > 0) {
          rows.push(fitAnsi(transcriptBodyInset, width));
        }
        return;
      }
      if (!markerEmitted) {
        const markerPrefix = `${transcriptBlockInset}${color.ink}${color.bold}●${color.reset} `;
        const available = Math.max(8, width - visibleLength(markerPrefix));
        rows.push(
          fitAnsi(
            `${markerPrefix}${color.ink}${truncate(trimmed, available)}${color.reset}`,
            width,
          ),
        );
        markerEmitted = true;
        return;
      }
      const available = Math.max(
        8,
        width - visibleLength(transcriptBodyInset),
      );
      rows.push(
        fitAnsi(
          `${transcriptBodyInset}${color.ink}${truncate(trimmed, available)}${color.reset}`,
          width,
        ),
      );
    });
    // Collapse trailing blanks so the streaming block doesn't push a gap
    // onto the viewport right before the composer.
    while (rows.length > 0 && rows[rows.length - 1] === fitAnsi(transcriptBodyInset, width)) {
      rows.pop();
    }
    streamingPreviewCache.text = committedPortion;
    streamingPreviewCache.width = width;
    streamingPreviewCache.rows = rows;
    return rows;
  }

  function flattenTranscriptView(width) {
    const transcriptEvents = visibleTranscriptEvents();
    const streamingPreviewBlock = buildStreamingPreviewBlock(width);
    if (transcriptEvents.length === 0) {
      if (streamingPreviewBlock.length > 0) {
        return {
          rows: streamingPreviewBlock,
          ranges: new Map(),
        };
      }
      if (shouldShowIdleTranscript()) {
        return {
          rows: splashRenderer.renderIdleState(width),
          ranges: new Map(),
        };
      }
      return {
        rows: [],
        ranges: new Map(),
      };
    }

    const rows = [];
    const ranges = new Map();
    const latestEvent = transcriptEvents[transcriptEvents.length - 1] ?? null;
    const richBodyWindow =
      isSourcePreviewEvent(latestEvent) || isMarkdownRenderableEvent(latestEvent) ? 8 : 6;
    const recentSourcePreviewIds = new Set(
      transcriptEvents
        .filter((event) => isSourcePreviewEvent(event))
        .slice(-8)
        .map((event) => event.id),
    );
    transcriptEvents.forEach((event, index) => {
      // Agent text replies must NEVER be hidden behind the headline-only
      // collapse. The rich-body window only retains body rendering for the
      // last 6-8 events; agent reply events outside that window otherwise
      // collapse to a single headline line, which is how the final agent
      // text could vanish from the visible transcript when many tool
      // events ran between the reply and the latest event. Forcing
      // showBody=true for kind:"agent" guarantees the model's text reply
      // is always visible to the user regardless of position.
      const showBody =
        event.kind === "agent" ||
        recentSourcePreviewIds.has(event.id) ||
        index >= Math.max(0, transcriptEvents.length - richBodyWindow) ||
        event.id === latestEvent?.id;
      if (index > 0) {
        rows.push(blankRow(width));
      }
      const start = rows.length;
      const block = renderEventBlock(event, width, { showBody });
      rows.push(...block);
      ranges.set(event.id, { start, end: rows.length });
    });
    if (streamingPreviewBlock.length > 0) {
      if (rows.length > 0) {
        rows.push(blankRow(width));
      }
      rows.push(...streamingPreviewBlock);
    }
    return { rows, ranges };
  }

  function currentTranscriptRowCount() {
    const { transcriptWidth } = currentTranscriptLayout();
    return flattenTranscriptView(transcriptWidth).rows.length;
  }

  function withPreservedManualTranscriptViewport(mutator) {
    const shouldFollow = isTranscriptFollowing();
    const beforeRows = shouldFollow ? null : currentTranscriptRowCount();
    const result = mutator({ shouldFollow });
    if (beforeRows !== null) {
      const afterRows = currentTranscriptRowCount();
      const nextViewport = preserveManualTranscriptViewport({
        shouldFollow,
        beforeRows,
        afterRows,
        transcriptScrollOffset: watchState.transcriptScrollOffset,
      });
      watchState.transcriptScrollOffset = nextViewport.transcriptScrollOffset;
      watchState.transcriptFollowMode = nextViewport.transcriptFollowMode;
    }
    return result;
  }

  function recentSourceFocusRange(ranges) {
    for (let index = events.length - 1; index >= Math.max(0, events.length - 10); index -= 1) {
      const candidate = events[index];
      if (!candidate || !isMutationPreviewEvent(candidate)) {
        continue;
      }
      return ranges.get(candidate.id) ?? null;
    }
    return null;
  }

  function activityPanelLines(width, targetHeight) {
    // Canonical-reply pin removed. The latest agent reply is now
    // rendered as a regular event inside the transcript itself
    // (kind: "agent" with forced showBody so it never collapses).
    // Previously the pin took most of the panel height and the
    // transcript path EXCLUDED kind:"agent" via
    // hiddenTranscriptKinds — so when the pin disappeared on
    // manual scroll the reply vanished entirely from the visible
    // frame. One chronological scrollable list (Claude Code
    // pattern) avoids the layout-jump-on-first-wheel symptom and
    // keeps scroll behaviour predictable.
    void canonicalReplyRows;
    const transcriptView = flattenTranscriptView(width);
    const transcriptTargetHeight = Math.max(0, targetHeight);
    const sliced = sliceViewportRowsFromBottom(
      transcriptView.rows,
      transcriptTargetHeight,
      watchState.transcriptScrollOffset,
    );
    watchState.transcriptScrollOffset = sliced.normalizedOffset;
    const lines = [...sliced.rows];
    const visibleReplyRows = [];
    return {
      lines,
      hiddenAbove: sliced.hiddenAbove,
      hiddenBelow: sliced.hiddenBelow,
      transcriptStartIndex: visibleReplyRows.length > 0 && sliced.rows.length > 0
        ? visibleReplyRows.length + 1
        : visibleReplyRows.length,
    };
  }

  function isTranscriptFollowing() {
    return isViewportTranscriptFollowing({
      transcriptFollowMode: watchState.transcriptFollowMode,
      transcriptScrollOffset: watchState.transcriptScrollOffset,
    });
  }

  function detailViewportState(event, width, targetHeight) {
    const body = wrapEventDisplayLines(eventDetailVariant(event), Math.max(12, width - 2));
    const metaRows = event?.title && buildTranscriptEventSummary(event).meta !== sanitizeDisplayText(event.title)
      ? 1
      : 0;
    const availableRows = Math.max(4, targetHeight - (4 + metaRows) - 1);
    const sliced = sliceViewportRowsFromBottom(body, availableRows, watchState.detailScrollOffset);
    return {
      body,
      metaRows,
      availableRows,
      sliced,
    };
  }

  function buildDiffNavigationState(event, body, availableRows, visibleStartIndex = 0) {
    if (typeof isDiffRenderableEvent === "function" && !isDiffRenderableEvent(event)) {
      return {
        enabled: false,
        hunkAnchors: [],
        currentHunkIndex: 0,
        totalHunks: 0,
        currentFilePath: "",
        fileCount: 0,
      };
    }
    let currentFilePath = sanitizeInlineText(event?.filePath ?? "");
    const filePaths = [];
    const hunkAnchors = [];
    for (const [index, line] of body.entries()) {
      if (typeof line?.filePath === "string" && line.filePath.trim()) {
        currentFilePath = sanitizeInlineText(line.filePath);
        if (currentFilePath && !filePaths.includes(currentFilePath)) {
          filePaths.push(currentFilePath);
        }
      }
      if (line?.mode === "diff-hunk") {
        hunkAnchors.push({
          index,
          label: sanitizeInlineText(displayLinePlainText(line), "@@"),
          filePath: currentFilePath,
        });
      }
    }
    const currentHunkIndex = hunkAnchors.reduce((selected, anchor, index) =>
      anchor.index <= visibleStartIndex ? index : selected, 0);
    const currentHunk = hunkAnchors[currentHunkIndex] ?? null;
    return {
      enabled: hunkAnchors.length > 0,
      hunkAnchors,
      currentHunkIndex,
      totalHunks: hunkAnchors.length,
      currentFilePath: sanitizeInlineText(currentHunk?.filePath ?? filePaths[0] ?? event?.filePath ?? ""),
      fileCount: filePaths.length || (currentFilePath ? 1 : 0),
      availableRows,
      bodyLength: body.length,
    };
  }

  function buildExpandedDetailView(width, targetHeight) {
    const event = currentExpandedEvent();
    if (!event) {
      watchState.expandedEventId = null;
      watchState.detailScrollOffset = 0;
      return null;
    }
    const viewport = detailViewportState(event, width, targetHeight);
    watchState.detailScrollOffset = viewport.sliced.normalizedOffset;
    const diffNavigation = buildDiffNavigationState(
      event,
      viewport.body,
      viewport.availableRows,
      viewport.sliced.hiddenAbove,
    );
    const detailSummary = buildDetailPaneSummary(event, {
      bodyLineCount: viewport.body.length,
      visibleLineCount: viewport.sliced.rows.length,
      hiddenAbove: viewport.sliced.hiddenAbove,
      hiddenBelow: viewport.sliced.hiddenBelow,
    });
    if (diffNavigation.enabled) {
      detailSummary.hint = `${detailSummary.hint}  ctrl+p prev hunk  ctrl+n next hunk`;
      const detailParts = [
        detailSummary.statusLine,
        `hunk ${diffNavigation.currentHunkIndex + 1}/${diffNavigation.totalHunks}`,
      ];
      if (diffNavigation.currentFilePath) {
        detailParts.push(truncate(diffNavigation.currentFilePath, Math.max(18, width - 24)));
      }
      detailSummary.statusLine = detailParts.join("  ");
    }
    return {
      event,
      detailSummary,
      diffNavigation,
      ...viewport,
    };
  }

  function expandedDetailLines(width, targetHeight) {
    const detail = buildExpandedDetailView(width, targetHeight);
    if (!detail) {
      return activityPanelLines(width, targetHeight);
    }
    const {
      event,
      sliced,
      detailSummary,
      diffNavigation,
    } = detail;
    const rows = [
      fitAnsi(
        `${toneColor(detailSummary.badge.tone)}${detailSummary.badge.label}${color.reset} ${color.ink}${sanitizeDisplayText(detailSummary.title)}${color.reset}`,
        width,
      ),
      `${color.fog}${detailSummary.hint}${color.reset}`,
      ...(detailSummary.meta && detailSummary.meta !== sanitizeDisplayText(detailSummary.title)
        ? [`${color.border}│${color.reset} ${color.softInk}${truncate(detailSummary.meta, Math.max(10, width - 3))}${color.reset}`]
        : []),
      ...(diffNavigation.enabled && diffNavigation.currentFilePath
        ? [`${color.border}│${color.reset} ${color.softInk}${truncate(diffNavigation.currentFilePath, Math.max(10, width - 3))}${color.reset}`]
        : []),
      "",
      ...sliced.rows.map((line) => renderEventBodyLine(event, line)),
    ];
    while (rows.length < targetHeight - 1) {
      rows.push("");
    }
    rows.push(`${color.fog}${detailSummary.statusLine}${color.reset}`);
    return {
      lines: rows.slice(0, targetHeight),
      hiddenAbove: sliced.hiddenAbove,
      hiddenBelow: sliced.hiddenBelow,
      diffNavigation,
    };
  }

  function currentDiffNavigationState() {
    if (!watchState.expandedEventId) {
      return {
        enabled: false,
        currentHunkIndex: 0,
        totalHunks: 0,
        currentFilePath: "",
      };
    }
    const { transcriptWidth, bodyHeight } = currentTranscriptLayout();
    const detail = buildExpandedDetailView(transcriptWidth, bodyHeight);
    return detail?.diffNavigation ?? {
      enabled: false,
      currentHunkIndex: 0,
      totalHunks: 0,
      currentFilePath: "",
    };
  }

  function jumpCurrentDiffHunk(direction = 1) {
    const { transcriptWidth, bodyHeight } = currentTranscriptLayout();
    const detail = buildExpandedDetailView(transcriptWidth, bodyHeight);
    if (!detail?.diffNavigation?.enabled) {
      return false;
    }
    const step = Number(direction) >= 0 ? 1 : -1;
    const currentIndex = detail.diffNavigation.currentHunkIndex;
    const nextIndex = step > 0
      ? Math.min(detail.diffNavigation.totalHunks - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    if (nextIndex === currentIndex) {
      setTransientStatus(
        step > 0
          ? `last hunk ${currentIndex + 1}/${detail.diffNavigation.totalHunks}`
          : `first hunk ${currentIndex + 1}/${detail.diffNavigation.totalHunks}`,
      );
      return false;
    }
    const targetAnchor = detail.diffNavigation.hunkAnchors[nextIndex];
    const desiredStart = Math.max(0, targetAnchor.index - 1);
    watchState.detailScrollOffset = Math.max(
      0,
      detail.diffNavigation.bodyLength - Math.min(detail.diffNavigation.bodyLength, desiredStart + detail.diffNavigation.availableRows),
    );
    setTransientStatus(`hunk ${nextIndex + 1}/${detail.diffNavigation.totalHunks}`);
    return true;
  }

  function copyableTranscriptText() {
    if (watchState.expandedEventId) {
      const event = currentExpandedEvent();
      if (!event) {
        return "";
      }
      const { transcriptWidth, bodyHeight } = currentTranscriptLayout();
      const detail = buildExpandedDetailView(transcriptWidth, bodyHeight);
      const bodyLines = (detail?.body ?? wrapEventDisplayLines(event, transcriptWidth)).map((line) =>
        displayLinePlainText(line),
      );
      const detailSummary = detail?.detailSummary ?? buildTranscriptEventSummary(event);
      const headerLines = [
        `[${event.timestamp}] ${sanitizeDisplayText(event.title)}`,
        detailSummary.meta && detailSummary.meta !== sanitizeDisplayText(detailSummary.title)
          ? detailSummary.meta
          : null,
      ].filter(Boolean);
      return [
        headerLines.join("\n"),
        bodyLines.join("\n"),
      ].filter(Boolean).join("\n\n").trim();
    }

    // Canonical-reply pin removal: the agent reply is now part of
    // `visibleTranscriptEvents()` so we don't prepend it as a
    // separate section — that would duplicate it in the export.
    const sections = visibleTranscriptEvents()
      .map((event) => [
        `[${event.timestamp}] ${sanitizeDisplayText(event.title)}`,
        storedEventBodyText(event),
      ].join("\n"))
      .filter((block) => block.trim().length > 0);
    return sections.join("\n\n").trim();
  }

  function exportViewText(text, mode = watchState.expandedEventId ? "detail" : "transcript") {
    const safeMode = String(mode ?? "view")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "view";
    const exportPath = path.join(
      os.tmpdir(),
      `agenc-watch-${safeMode}-${nowMs()}.txt`,
    );
    fs.writeFileSync(exportPath, `${text}\n`);
    return exportPath;
  }

  function exportCurrentView({ announce = false } = {}) {
    const text = copyableTranscriptText();
    if (!text) {
      setTransientStatus("nothing to export");
      scheduleRender();
      return null;
    }

    const mode = watchState.expandedEventId ? "detail" : "transcript";
    const exportPath = exportViewText(text, mode);
    if (announce) {
      pushEvent(
        "operator",
        mode === "detail" ? "Detail Export" : "Transcript Export",
        `${mode[0].toUpperCase()}${mode.slice(1)} exported to ${exportPath}.`,
        "teal",
      );
    } else {
      setTransientStatus(`${mode} exported to ${exportPath}`);
      scheduleRender();
    }
    return exportPath;
  }

  function isTerminalSelectionModeActive() {
    return frameState.selectionModeActive;
  }

  function selectionModeTextBlock(viewLabel, text) {
    const divider = "=".repeat(42);
    return [
      "",
      divider,
      "agenc watch: terminal selection mode",
      `native terminal copy/select is enabled for the current ${viewLabel}.`,
      "press ctrl+q to return to the live watch interface.",
      divider,
      "",
      text,
      "",
    ].join("\n");
  }

  function toggleTerminalSelectionMode() {
    if (frameState.selectionModeActive) {
      frameState.selectionModeActive = false;
      setTransientStatus("watch resumed");
      scheduleRender();
      return true;
    }

    const text = copyableTranscriptText();
    if (!text) {
      setTransientStatus("nothing to show");
      scheduleRender();
      return false;
    }

    const viewLabel = watchState.expandedEventId ? "detail" : "transcript";
    leaveAltScreen();
    frameState.selectionModeActive = true;
    stdout.write(selectionModeTextBlock(viewLabel, text));
    setTransientStatus(`${viewLabel} in terminal; ctrl+q returns`);
    return true;
  }

  function copyCurrentView() {
    const text = copyableTranscriptText();
    if (!text) {
      setTransientStatus("nothing to copy");
      scheduleRender();
      return;
    }

    const destinations = [];
    let clipboardCommand = null;
    const clipboardCommands = [
      ["pbcopy", []],
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ];
    for (const [command, args] of clipboardCommands) {
      try {
        execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
        clipboardCommand = command;
        destinations.push(`clipboard via ${command}`);
        break;
      } catch {}
    }

    try {
      if (process.env.TMUX) {
        execFileSync("tmux", ["load-buffer", "-"], { input: text });
        destinations.push("tmux buffer");
      }
    } catch {}

    if (!clipboardCommand) {
      destinations.push(exportViewText(text));
    }

    const viewLabel = watchState.expandedEventId ? "detail" : "transcript";
    setTransientStatus(`${viewLabel} copied: ${destinations.join(" / ")}`);
    scheduleRender();
  }

  function scrollTranscriptBy(delta) {
    watchState.transcriptScrollOffset = applyViewportScrollDelta(
      watchState.transcriptScrollOffset,
      delta,
    );
    watchState.transcriptFollowMode = watchState.transcriptScrollOffset === 0;
    scheduleRender();
  }

  function scrollDetailBy(delta) {
    watchState.detailScrollOffset = applyViewportScrollDelta(
      watchState.detailScrollOffset,
      delta,
    );
    scheduleRender();
  }

  function scrollCurrentViewBy(delta) {
    if (watchState.expandedEventId) {
      scrollDetailBy(delta);
      return;
    }
    scrollTranscriptBy(delta);
  }

  function enterAltScreen() {
    if (!stdout.isTTY || frameState.enteredAltScreen) {
      return;
    }
    stdout.write(buildAltScreenEnterSequence({ enableMouseTracking }));
    frameState.enteredAltScreen = true;
  }

  function leaveAltScreen() {
    if (!frameState.enteredAltScreen) {
      return;
    }
    stdout.write(buildAltScreenLeaveSequence({ enableMouseTracking }));
    frameState.enteredAltScreen = false;
    frameState.lastRenderedFrameLines = [];
    frameState.lastRenderedFrameWidth = 0;
    frameState.lastRenderedFrameHeight = 0;
  }

  function footerHintLine(width, diffNavigation = null) {
    const fileTagPalette = currentFileTagPalette(6);
    const inputPreferences = typeof currentInputPreferences === "function"
      ? currentInputPreferences() ?? {}
      : {};
    const footer = buildWatchFooterSummary({
      summary: currentSurfaceSummary(),
      inputValue: currentInputValue(),
      suggestions: currentSlashSuggestions(6),
      modelSuggestions: typeof currentModelSuggestions === "function" ? currentModelSuggestions(6) : [],
      fileTagQuery: fileTagPalette.activeTag?.query ?? null,
      fileTagSuggestions: fileTagPalette.suggestions,
      fileTagIndexReady: workspaceFileIndex.ready,
      fileTagIndexError: workspaceFileIndex.error,
      connectionState: transportState.connectionState,
      activeRun: hasActiveSurfaceRun(),
      elapsedLabel: hasActiveSurfaceRun()
        ? currentRunElapsedLabel()
        : currentSessionElapsedLabel(),
      latestTool: currentSurfaceToolLabel(""),
      latestToolState: watchState.latestToolState,
      transientStatus: watchState.transientStatus,
      latestAgentSummary: watchState.latestAgentSummary,
      objective: hasActiveSurfaceRun() ? currentDisplayObjective("") : "",
      isOpen: transportState.isOpen,
      bootstrapPending: bootstrapPending(),
      latestExpandable: Boolean(latestExpandableEvent()),
      enableMouseTracking,
      detailDiffNavigation: diffNavigation,
      activeCheckpointId: watchState.activeCheckpointId,
      checkpointCount: Array.isArray(watchState.checkpoints) ? watchState.checkpoints.length : 0,
      inputModeProfile: inputPreferences.inputModeProfile,
      keybindingProfile: inputPreferences.keybindingProfile,
      composerMode: watchState.composerMode,
      themeName: inputPreferences.themeName,
      featureFlags: watchFeatureFlags,
    });
    return flexBetween(
      `${color.fog}${truncate(footer.hintLeft, Math.max(16, width - 22))}${color.reset}`,
      `${color.fog}${footer.hintRight}${color.reset}`,
      width,
    );
  }

  function footerStatusLines(width, diffNavigation = null) {
    const summary = currentSurfaceSummary();
    const activeRun = hasActiveSurfaceRun();
    const elapsedLabel = activeRun ? currentRunElapsedLabel() : currentSessionElapsedLabel();
    const fileTagPalette = currentFileTagPalette(6);
    const modelSuggestions = typeof currentModelSuggestions === "function" ? currentModelSuggestions(6) : [];
    const inputPreferences = typeof currentInputPreferences === "function"
      ? currentInputPreferences() ?? {}
      : {};
    const footer = buildWatchFooterSummary({
      summary,
      inputValue: currentInputValue(),
      suggestions: currentSlashSuggestions(6),
      modelSuggestions,
      fileTagQuery: fileTagPalette.activeTag?.query ?? null,
      fileTagSuggestions: fileTagPalette.suggestions,
      fileTagIndexReady: workspaceFileIndex.ready,
      fileTagIndexError: workspaceFileIndex.error,
      connectionState: transportState.connectionState,
      activeRun,
      elapsedLabel,
      latestTool: currentSurfaceToolLabel(""),
      latestToolState: watchState.latestToolState,
      transientStatus: watchState.transientStatus,
      latestAgentSummary: watchState.latestAgentSummary,
      objective: activeRun ? currentDisplayObjective("") : "",
      isOpen: transportState.isOpen,
      bootstrapPending: bootstrapPending(),
      latestExpandable: Boolean(latestExpandableEvent()),
      enableMouseTracking,
      detailDiffNavigation: diffNavigation,
      activeCheckpointId: watchState.activeCheckpointId,
      checkpointCount: Array.isArray(watchState.checkpoints) ? watchState.checkpoints.length : 0,
      inputModeProfile: inputPreferences.inputModeProfile,
      keybindingProfile: inputPreferences.keybindingProfile,
      composerMode: watchState.composerMode,
      themeName: inputPreferences.themeName,
      featureFlags: watchFeatureFlags,
    });
    const transcriptMode = sanitizeInlineText(summary?.overview?.transcriptMode ?? "follow", "follow");
    const slashMode = isSlashComposerInput(currentInputValue());
    const fileTagMode = Boolean(fileTagPalette.activeTag);
    const detailMode = transcriptMode === "detail";
    const normalizeFooterStatusText = (value) => {
      const text = sanitizeInlineText(value, "");
      if (!text) {
        return "";
      }
      if (text === "no active background run for this session") {
        return "";
      }
      if (text.startsWith("session resumed:")) {
        return "restoring session";
      }
      if (text.startsWith("no existing session")) {
        return "starting session";
      }
      if (text.startsWith("history loaded:") || text.startsWith("history restored:")) {
        return "history restored";
      }
      if (text === "agent is typing…" || text === "agent streaming…" || text.startsWith("streaming:")) {
        return "responding";
      }
      if (text === "agent reply received" || text === "agent stream complete") {
        return "";
      }
      return text;
    };
    let leftText = "";
    if (detailMode) {
      leftText = "detail";
    } else if (activeRun) {
      const footerBrand = currentThinkingFooterBrand(summary);
      leftText = `${footerBrand.verb}`;
    }
    // Slash / file-tag mode used to set leftText to "/ command", "/ model",
    // or "@ file" — these labels appear in the status row directly above the
    // composer's top divider. Since the palette popup itself renders below
    // the input and makes the mode obvious, that label was redundant clutter
    // floating above the upper input line. Leave the status row alone in
    // those modes.
    let rightText = normalizeFooterStatusText(watchState.transientStatus || "");
    if (!rightText && activeRun) {
      rightText = normalizeFooterStatusText(footer.rightStatus || "");
    }
    if (!rightText && !transportState.isOpen) {
      rightText = "reconnecting";
    }
    if (!rightText && bootstrapPending()) {
      rightText = "restoring session";
    }

    if (activeRun) {
      const terminalPhase = currentTerminalRunPhase();
      if (terminalPhase) {
        const terminalText =
          terminalPhase === "background_blocked"
            ? "idle · type to resume"
            : terminalPhase === "background_completed"
              ? "done · type to start a new run"
              : "failed · see logs for details";
        const rightStatusText = `${color.fog}${truncate(rightText, Math.max(18, Math.floor(width * 0.32)))}${color.reset}`;
        return [
          "",
          flexBetween(
            `${color.fog}${terminalText}${color.reset}`,
            rightStatusText,
            width,
          ),
          "",
        ];
      }
      const footerBrand = currentThinkingFooterBrand(summary);
      const rightStatusText = `${color.fog}${truncate(rightText, Math.max(18, Math.floor(width * 0.32)))}${color.reset}`;
      // 1-char rotating braille spinner + verb on a single row. Wrapped
      // in empty rows above and below for visual breathing room (matches
      // the original 3-row footer footprint).
      const spinnerGlyph = footerBrand.logoLines[0] ?? "";
      // `verbDisplay` carries the per-character neon scan gradient. The
      // trailing ellipsis is appended after the gradient with a soft
      // brand-purple tone (#af00ff) so it reads as part of the word but
      // doesn't compete with the shimmer.
      const verbText = `${footerBrand.verbDisplay}\x1b[38;5;129m${color.bold}…${color.reset}`;
      const leftWithVerb = `${spinnerGlyph} ${verbText}`;
      return [
        "",
        flexBetween(leftWithVerb, rightStatusText, width),
        "",
      ];
    }

    return [
      flexBetween(
        `${color.fog}${truncate(leftText, Math.max(18, width - 22))}${color.reset}`,
        `${color.fog}${truncate(rightText, Math.max(18, Math.floor(width * 0.32)))}${color.reset}`,
        width,
      ),
    ];
  }

  function buildVisibleFrameSnapshot({ width = termWidth(), height = termHeight() } = {}) {
    let frame = [];
    let diffNavigation = null;
    const { popup } = currentBottomPopupLayout(width, height);
    const composer = composerRenderLine(width);
    const composerLines = composer.lines ?? [composer.line];
    let composerBand = composerBandLines(width, composerLines, diffNavigation);
    const composerBandRows = composerBand.length;
    const contentRows = Math.max(4, height - popup.length - composerBandRows);

    let headerRowCount = 0;
    const isSplashShown = splashRenderer.shouldShowSplash();
    if (isSplashShown) {
      frame = contentRows >= 14
        ? splashRenderer.renderSplash(width, contentRows)
        : splashRenderer.renderCompactSplash(width, contentRows);
    } else {
      const header = headerLines(width);
      headerRowCount = header.length;
      const {
        useSidebar,
        sidebarWidth,
        transcriptWidth,
        bodyHeight,
      } = currentTranscriptLayout();
      const transcriptHeight = Math.max(4, contentRows - header.length);
      const transcriptView = watchState.expandedEventId
        ? expandedDetailLines(transcriptWidth, transcriptHeight)
        : activityPanelLines(transcriptWidth, transcriptHeight);
      diffNavigation = transcriptView.diffNavigation ?? null;
      const transcriptLines = [...transcriptView.lines];
      const transcriptStartIndex = Math.max(
        0,
        Math.min(
          transcriptLines.length - 1,
          Number.isFinite(Number(transcriptView.transcriptStartIndex))
            ? Number(transcriptView.transcriptStartIndex)
            : 0,
        ),
      );
      if (!watchState.expandedEventId && transcriptLines.length > 0) {
        if (transcriptView.hiddenAbove > 0) {
          const aboveText = `${color.fog}▲ ${transcriptView.hiddenAbove} more line${transcriptView.hiddenAbove === 1 ? "" : "s"} above${color.reset}`;
          transcriptLines[transcriptStartIndex] = paintSurface(
            aboveText,
            transcriptWidth,
            color.panelBg,
          );
        }
        if (transcriptView.hiddenBelow > 0) {
          const belowText = `${color.fog}▼ ${transcriptView.hiddenBelow} more line${transcriptView.hiddenBelow === 1 ? "" : "s"} below${color.reset}`;
          transcriptLines[transcriptLines.length - 1] = paintSurface(belowText, transcriptWidth, color.panelBg);
        }
      }
      const transcript = useSidebar
        ? joinColumns(
          transcriptLines,
          sidebarLines(sidebarWidth, bodyHeight),
          transcriptWidth,
          sidebarWidth,
          2,
        )
        : transcriptLines;
      frame = [
        ...header,
        ...transcript,
      ];
    }
    const statusLines = footerStatusLines(width, diffNavigation);
    composerBand = composerBandLines(width, composerLines, diffNavigation);
    const nextFrameLines = [];
    for (const line of frame.slice(0, contentRows)) {
      nextFrameLines.push(paintSurface(line ?? "", width, color.panelBg));
    }
    // Pin the composer + popup to the bottom by padding the body
    // before them. This gives the right-side art strip a body region
    // that always spans from below the header down to the composer
    // regardless of how short the transcript is, so the art doesn't
    // collapse to a sliver when the chat is near-empty.
    while (nextFrameLines.length < contentRows) {
      nextFrameLines.push(paintSurface("", width, color.panelBg));
    }
    const composerStartRow = nextFrameLines.length + 1;
    const composerInputOffsetRows = statusLines.length + 1;
    for (const cLine of composerBand) {
      nextFrameLines.push(paintSurface(cLine, width, color.panelBg));
    }
    for (const popupLine of popup) {
      nextFrameLines.push(paintSurface(popupLine, width, color.panelBg));
    }
    while (nextFrameLines.length < height) {
      nextFrameLines.push(paintSurface("", width, color.panelBg));
    }
    const cursorAbsoluteRow = Math.max(
      1,
      Math.min(height, composerStartRow + composerInputOffsetRows + (composer.cursorRow ?? 0)),
    );

    // Right-side ANSI art wallpaper compositing, confined to the
    // BODY region of the frame: rows strictly between the cockpit
    // header (first `headerRowCount` rows) and the composer/popup
    // footer band (starts at `composerStartRow - 1`). Header and
    // footer render cleanly without any art intrusion. Splash
    // screen disables the compositor entirely. Within body rows,
    // TUI non-space cells stay opaque and space cells fall through
    // to the art pixel at that column.
    const artPanelRows = Array.isArray(watchState.artPanelRows)
      ? watchState.artPanelRows
      : null;
    const artPanelCols = Number.isFinite(Number(watchState.artPanelCols))
      ? Math.max(0, Math.floor(Number(watchState.artPanelCols)))
      : 0;
    const bodyStart = headerRowCount;
    const bodyEndExclusive = Math.max(bodyStart, composerStartRow - 1);
    const measuredBodyHeight = Math.max(0, bodyEndExclusive - bodyStart);
    // Publish the exact body dimensions every frame so refreshArtPanel
    // can size the art to match. A change in body dimensions (resize,
    // popup show/hide, composer band growth) bumps the revision
    // counter so the art controller can detect the mismatch and
    // request a re-render asynchronously.
    if (
      watchState.currentBodyWidth !== width ||
      watchState.currentBodyHeight !== measuredBodyHeight
    ) {
      watchState.currentBodyWidth = width;
      watchState.currentBodyHeight = measuredBodyHeight;
      watchState.currentBodyRevision =
        (Number(watchState.currentBodyRevision) || 0) + 1;
    }
    if (
      !isSplashShown &&
      artPanelRows &&
      artPanelRows.length > 0 &&
      artPanelCols > 0 &&
      artPanelCols <= width
    ) {
      for (let rowIndex = bodyStart; rowIndex < bodyEndExclusive; rowIndex += 1) {
        const artRowIdx = rowIndex - bodyStart;
        nextFrameLines[rowIndex] = compositeRowWithArt(
          String(nextFrameLines[rowIndex] ?? ""),
          artPanelRows[artRowIdx] ?? "",
          width,
          artPanelCols,
        );
      }
    }

    return {
      lines: nextFrameLines,
      width,
      height,
      composer: {
        ...composer,
        cursorColumn: composer.cursorColumn,
        absoluteRow: cursorAbsoluteRow,
      },
      diffNavigation,
    };
  }

  function render() {
    frameState.renderPending = false;
    if (frameState.selectionModeActive) {
      return;
    }
    enterAltScreen();
    const snapshot = buildVisibleFrameSnapshot();
    const { lines: nextFrameLines, width, height, composer } = snapshot;

    const requiresFullClear =
      frameState.lastRenderedFrameWidth !== width ||
      frameState.lastRenderedFrameHeight !== height ||
      frameState.lastRenderedFrameLines.length !== nextFrameLines.length;

    stdout.write("\x1b[?25l");
    if (requiresFullClear) {
      stdout.write(`${color.panelBg}\x1b[H\x1b[2J`);
      for (let rowIndex = 0; rowIndex < nextFrameLines.length; rowIndex += 1) {
        stdout.write(`\x1b[${rowIndex + 1};1H${nextFrameLines[rowIndex]}`);
      }
    } else {
      for (let rowIndex = 0; rowIndex < nextFrameLines.length; rowIndex += 1) {
        if (nextFrameLines[rowIndex] === frameState.lastRenderedFrameLines[rowIndex]) {
          continue;
        }
        stdout.write(`\x1b[${rowIndex + 1};1H\x1b[2K${nextFrameLines[rowIndex]}`);
      }
    }
    frameState.lastRenderedFrameLines = nextFrameLines;
    frameState.lastRenderedFrameWidth = width;
    frameState.lastRenderedFrameHeight = height;
    const cursorRow = composer.absoluteRow ?? height;
    stdout.write(`\x1b[${cursorRow};${composer.cursorColumn}H\x1b[?25h`);
    stdout.write(color.reset);
  }

  // Minimum gap between streaming-chunk-triggered frames. The custom
  // renderer diff-rebuilds the full ~150KB frame on every render; at
  // the ~50-80 tok/s rate Grok streams, that can burn CPU rebuilding
  // the same frame multiple times per 16ms. Ink batches automatically
  // via its render loop; we get the same effect by collapsing rapid
  // streaming-reason schedules into a single frame every STREAM_RENDER_MIN_GAP_MS.
  //
  // Non-streaming reasons (user input, tool events, status changes,
  // ticker) bypass the gap and render immediately — those MUST be
  // low-latency for the UI to feel responsive.
  const STREAM_RENDER_MIN_GAP_MS = 33;

  function scheduleRender(options) {
    // Make sure the active-run ticker reflects current run state: a
    // brand-new activeRunStartedAtMs (e.g. the first event of a new
    // actor turn) should start the steady tick immediately, and a
    // cycle boundary that cleared activeRunStartedAtMs should stop
    // it. Putting this here is cheap — O(1) per render call — and
    // avoids a separate wiring point in every state-mutation site.
    ensureActiveRunTicker();
    if (frameState.renderPending) {
      return;
    }
    const reason =
      options && typeof options === "object"
        ? String(options.reason ?? "")
        : "";
    if (reason === "stream") {
      const now = Date.now();
      const lastRenderedAt = frameState.lastRenderedAtMs ?? 0;
      const elapsed = now - lastRenderedAt;
      const gap =
        elapsed >= STREAM_RENDER_MIN_GAP_MS
          ? 0
          : STREAM_RENDER_MIN_GAP_MS - elapsed;
      frameState.renderPending = true;
      setTimer(() => {
        frameState.lastRenderedAtMs = Date.now();
        render();
      }, gap);
      return;
    }
    frameState.renderPending = true;
    setTimer(() => {
      frameState.lastRenderedAtMs = Date.now();
      render();
    }, 0);
  }

  return {
    currentTranscriptLayout,
    shouldShowSplash: splashRenderer.shouldShowSplash,
    latestExpandableEvent,
    currentExpandedEvent,
    currentDiffNavigationState,
    jumpCurrentDiffHunk,
    toggleExpandedEvent,
    currentTranscriptRowCount,
    withPreservedManualTranscriptViewport,
    exportCurrentView,
    copyCurrentView,
    isTerminalSelectionModeActive,
    toggleTerminalSelectionMode,
    scrollCurrentViewBy,
    buildVisibleFrameSnapshot,
    leaveAltScreen,
    render,
    scheduleRender,
  };
}
