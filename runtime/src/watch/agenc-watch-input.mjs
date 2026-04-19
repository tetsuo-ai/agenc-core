function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchInputController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchInputController requires a ${name} object`);
  }
}

export function createWatchInputController(dependencies = {}) {
  const {
    watchState,
    currentInputPreferences = () => watchState.inputPreferences ?? { inputModeProfile: "default" },
    shuttingDown,
    parseMouseWheelSequence,
    scrollCurrentViewBy,
    shutdownWatch,
    toggleExpandedEvent,
    toggleTerminalSelectionMode,
    currentDiffNavigationState,
    jumpCurrentDiffHunk,
    copyCurrentView,
    isTerminalSelectionModeActive = () => false,
    clearLiveTranscriptView,
    deleteComposerTail,
    deleteComposerBackward,
    deleteComposerForward,
    autocompleteComposerInput,
    acceptComposerPaletteSelection = () => false,
    navigateComposer,
    hasActiveMarketTaskBrowser = () => false,
    navigateMarketTaskBrowser = () => false,
    toggleMarketTaskBrowserExpansion = () => false,
    dismissMarketTaskBrowser = () => false,
    hasActiveComposerPalette = () => false,
    navigateComposerPalette = () => false,
    moveComposerCursorByCharacter,
    moveComposerCursorByWord,
    insertComposerTextValue,
    dismissIntro,
    resetComposer,
    recordComposerHistory,
    operatorInputBatcher,
    setTransientStatus,
    cancelActiveChat,
    scheduleRender,
  } = dependencies;

  assertObject("watchState", watchState);
  assertFunction("currentInputPreferences", currentInputPreferences);
  assertFunction("shuttingDown", shuttingDown);
  assertFunction("parseMouseWheelSequence", parseMouseWheelSequence);
  assertFunction("scrollCurrentViewBy", scrollCurrentViewBy);
  assertFunction("shutdownWatch", shutdownWatch);
  assertFunction("toggleExpandedEvent", toggleExpandedEvent);
  assertFunction("toggleTerminalSelectionMode", toggleTerminalSelectionMode);
  assertFunction("currentDiffNavigationState", currentDiffNavigationState);
  assertFunction("jumpCurrentDiffHunk", jumpCurrentDiffHunk);
  assertFunction("copyCurrentView", copyCurrentView);
  assertFunction("isTerminalSelectionModeActive", isTerminalSelectionModeActive);
  assertFunction("clearLiveTranscriptView", clearLiveTranscriptView);
  assertFunction("deleteComposerTail", deleteComposerTail);
  assertFunction("deleteComposerBackward", deleteComposerBackward);
  assertFunction("deleteComposerForward", deleteComposerForward);
  assertFunction("autocompleteComposerInput", autocompleteComposerInput);
  assertFunction("acceptComposerPaletteSelection", acceptComposerPaletteSelection);
  assertFunction("navigateComposer", navigateComposer);
  assertFunction("hasActiveMarketTaskBrowser", hasActiveMarketTaskBrowser);
  assertFunction("navigateMarketTaskBrowser", navigateMarketTaskBrowser);
  assertFunction("toggleMarketTaskBrowserExpansion", toggleMarketTaskBrowserExpansion);
  assertFunction("dismissMarketTaskBrowser", dismissMarketTaskBrowser);
  assertFunction("hasActiveComposerPalette", hasActiveComposerPalette);
  assertFunction("navigateComposerPalette", navigateComposerPalette);
  assertFunction("moveComposerCursorByCharacter", moveComposerCursorByCharacter);
  assertFunction("moveComposerCursorByWord", moveComposerCursorByWord);
  assertFunction("insertComposerTextValue", insertComposerTextValue);
  assertFunction("dismissIntro", dismissIntro);
  assertFunction("resetComposer", resetComposer);
  assertFunction("recordComposerHistory", recordComposerHistory);
  if (!operatorInputBatcher || typeof operatorInputBatcher.push !== "function") {
    throw new TypeError("createWatchInputController requires an operatorInputBatcher with push()");
  }
  assertFunction("setTransientStatus", setTransientStatus);
  assertFunction("scheduleRender", scheduleRender);
  const BRACKETED_PASTE_START = "\x1b[200~";
  const BRACKETED_PASTE_END = "\x1b[201~";
  const PASTE_SUMMARY_CHAR_THRESHOLD = 120;
  let pendingBracketedPaste = null;

  function normalizePastedText(text) {
    return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  function shouldSummarizePastedText(text) {
    const normalized = normalizePastedText(text);
    if (!normalized) {
      return false;
    }
    const lineCount = normalized.split("\n").length;
    return lineCount > 1 || normalized.length >= PASTE_SUMMARY_CHAR_THRESHOLD;
  }

  function insertPastedText(text) {
    const normalized = normalizePastedText(text);
    if (!normalized) {
      return false;
    }
    if (!watchState.introDismissed) {
      dismissIntro();
    }
    insertComposerTextValue(normalized, {
      markPasted: shouldSummarizePastedText(normalized),
    });
    watchState.composerHistoryIndex = -1;
    return true;
  }

  function currentSecretPrompt() {
    return watchState.secretPrompt && typeof watchState.secretPrompt === "object"
      ? watchState.secretPrompt
      : null;
  }

  function insertSecretPromptText(text) {
    const prompt = currentSecretPrompt();
    if (!prompt || prompt.pending) {
      return false;
    }
    const normalized = normalizePastedText(text);
    if (!normalized) {
      return false;
    }
    prompt.value = `${String(prompt.value ?? "")}${normalized}`;
    return true;
  }

  // Upper bound for a single bracketed-paste payload. 4 MB is well
  // past any legitimate paste a user would make interactively and
  // caps memory usage if a runaway producer (or malicious input)
  // never emits the end marker. When the bound is hit, the excess
  // bytes are dropped and the paste is accepted with what was
  // buffered so far.
  const BRACKETED_PASTE_MAX_BYTES = 4 * 1024 * 1024;

  function consumeBracketedPaste(input, index, { insertText = insertPastedText } = {}) {
    const source = String(input ?? "");
    if (
      pendingBracketedPaste === null &&
      !source.startsWith(BRACKETED_PASTE_START, index)
    ) {
      return null;
    }

    let scanIndex = index;
    if (pendingBracketedPaste === null) {
      pendingBracketedPaste = "";
      scanIndex += BRACKETED_PASTE_START.length;
    }

    const endIndex = source.indexOf(BRACKETED_PASTE_END, scanIndex);
    if (endIndex === -1) {
      pendingBracketedPaste += source.slice(scanIndex);
      if (pendingBracketedPaste.length > BRACKETED_PASTE_MAX_BYTES) {
        // Truncate and commit whatever we have. Subsequent bytes up
        // to the next end marker are dropped silently (nextIndex
        // jumps to source end so the outer loop skips them).
        const truncated = pendingBracketedPaste.slice(
          0,
          BRACKETED_PASTE_MAX_BYTES,
        );
        pendingBracketedPaste = null;
        const didMutate = insertText(truncated);
        return {
          nextIndex: source.length,
          didMutate,
        };
      }
      return {
        nextIndex: source.length,
        didMutate: false,
      };
    }

    pendingBracketedPaste += source.slice(scanIndex, endIndex);
    if (pendingBracketedPaste.length > BRACKETED_PASTE_MAX_BYTES) {
      pendingBracketedPaste = pendingBracketedPaste.slice(
        0,
        BRACKETED_PASTE_MAX_BYTES,
      );
    }
    const didMutate = insertText(pendingBracketedPaste);
    pendingBracketedPaste = null;
    return {
      nextIndex: endIndex + BRACKETED_PASTE_END.length,
      didMutate,
    };
  }

  function handleSecretPromptInput(input) {
    if (shuttingDown() || input.length === 0) {
      return;
    }

    let index = 0;
    let didMutate = false;

    while (index < input.length) {
      const prompt = currentSecretPrompt();
      if (!prompt) {
        break;
      }

      const bracketedPaste = consumeBracketedPaste(input, index, {
        insertText: insertSecretPromptText,
      });
      if (bracketedPaste) {
        didMutate = didMutate || bracketedPaste.didMutate;
        index = bracketedPaste.nextIndex;
        continue;
      }

      const char = input[index];
      if (char === "\x03") {
        shutdownWatch(0);
        return;
      }

      if (prompt.pending) {
        index += char === "\r" && input[index + 1] === "\n" ? 2 : 1;
        continue;
      }

      if (char === "\r" || char === "\n") {
        const submission = typeof prompt.onSubmit === "function"
          ? prompt.onSubmit(prompt.value ?? "")
          : null;
        Promise.resolve(submission).catch(() => {});
        didMutate = true;
        index += char === "\r" && input[index + 1] === "\n" ? 2 : 1;
        continue;
      }

      if (char === "\x7f" || char === "\b") {
        const value = String(prompt.value ?? "");
        if (value.length > 0) {
          prompt.value = value.slice(0, -1);
          didMutate = true;
        }
        index += 1;
        continue;
      }

      if (char === "\x1b") {
        const rest = String(input ?? "").slice(index);
        if (rest === "\x1b") {
          if (typeof prompt.onCancel === "function") {
            prompt.onCancel();
            didMutate = true;
          }
          index += 1;
          continue;
        }
        index = consumeUnknownEscapeSequence(input, index);
        continue;
      }

      if (char < " ") {
        index += 1;
        continue;
      }

      prompt.value = `${String(prompt.value ?? "")}${char}`;
      didMutate = true;
      index += 1;
    }

    if (didMutate) {
      scheduleRender();
    }
  }

  function submitComposerInput() {
    if (hasActiveMarketTaskBrowser()) {
      toggleMarketTaskBrowserExpansion();
      scheduleRender();
      return;
    }
    // Enter in an active palette accepts the highlighted selection —
    // it must NOT also fire submit in the same keystroke. Previously
    // selecting `/plan` from the dropdown accepted the selection and
    // immediately submitted the filled-in command, giving the user
    // no chance to edit the arguments before send.
    if (hasActiveComposerPalette()) {
      acceptComposerPaletteSelection();
      scheduleRender();
      return;
    }
    const value = watchState.composerInput.trim();
    if (!value) {
      scheduleRender();
      return;
    }
    recordComposerHistory(value);
    resetComposer();
    operatorInputBatcher.push(value);
    scheduleRender();
  }

  function currentInputModeProfile() {
    return currentInputPreferences()?.inputModeProfile === "vim" ? "vim" : "default";
  }

  function currentKeybindingProfile() {
    return currentInputPreferences()?.keybindingProfile === "vim" ? "vim" : "default";
  }

  function isVimNormalMode() {
    return currentInputModeProfile() === "vim" && watchState.composerMode === "normal";
  }

  function consumeUnknownEscapeSequence(input, index) {
    const rest = String(input ?? "").slice(index);
    if (!rest.startsWith("\x1b")) {
      return index + 1;
    }
    if (rest.length === 1) {
      return index + 1;
    }
    if (rest[1] !== "[") {
      return index + 2;
    }
    for (let cursor = index + 2; cursor < input.length; cursor += 1) {
      const code = input.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) {
        return cursor + 1;
      }
    }
    return input.length;
  }

  function handleTerminalEscapeSequence(input, index) {
    const rest = input.slice(index);
    const sequenceTable = [
      { seq: "\x1b[1;5D", run: () => moveComposerCursorByWord(-1) },
      { seq: "\x1b[5D", run: () => moveComposerCursorByWord(-1) },
      { seq: "\x1bb", run: () => moveComposerCursorByWord(-1) },
      { seq: "\x1b[1;5C", run: () => moveComposerCursorByWord(1) },
      { seq: "\x1b[5C", run: () => moveComposerCursorByWord(1) },
      { seq: "\x1bf", run: () => moveComposerCursorByWord(1) },
      { seq: "\x1b[5~", run: () => scrollCurrentViewBy(12) },
      { seq: "\x1b[6~", run: () => scrollCurrentViewBy(-12) },
      // Modifier forms emitted by modern terminals for Shift/Ctrl/Alt+
      // PageUp/PageDown (`\x1b[5;2~` etc). Without these the modifier
      // combinations fall into consumeUnknownEscapeSequence and scroll
      // silently fails for those keystrokes.
      { seq: "\x1b[5;2~", run: () => scrollCurrentViewBy(24) },
      { seq: "\x1b[5;3~", run: () => scrollCurrentViewBy(24) },
      { seq: "\x1b[5;5~", run: () => scrollCurrentViewBy(24) },
      { seq: "\x1b[6;2~", run: () => scrollCurrentViewBy(-24) },
      { seq: "\x1b[6;3~", run: () => scrollCurrentViewBy(-24) },
      { seq: "\x1b[6;5~", run: () => scrollCurrentViewBy(-24) },
      { seq: "\x1b[3~", run: () => {
        deleteComposerForward();
      } },
      { seq: "\x1b[A", run: () => {
        if (hasActiveMarketTaskBrowser()) {
          navigateMarketTaskBrowser(-1);
          return;
        }
        if (hasActiveComposerPalette()) {
          navigateComposerPalette(-1);
          return;
        }
        // When the composer is empty and no palette is active, the
        // user's intent on arrow-up is to scroll the transcript, not
        // to navigate composer history (which only has meaning when
        // there IS composer text to replace). Previously every plain
        // Up arrow went straight to navigateComposer and the user
        // had no keyboard-scroll path short of PageUp.
        if (
          typeof watchState.composerInput === "string" &&
          watchState.composerInput.length === 0
        ) {
          scrollCurrentViewBy(3);
          return;
        }
        navigateComposer(-1);
      } },
      { seq: "\x1b[B", run: () => {
        if (hasActiveMarketTaskBrowser()) {
          navigateMarketTaskBrowser(1);
          return;
        }
        if (hasActiveComposerPalette()) {
          navigateComposerPalette(1);
          return;
        }
        if (
          typeof watchState.composerInput === "string" &&
          watchState.composerInput.length === 0
        ) {
          scrollCurrentViewBy(-3);
          return;
        }
        navigateComposer(1);
      } },
      { seq: "\x1b[D", run: () => moveComposerCursorByCharacter(-1) },
      { seq: "\x1b[C", run: () => moveComposerCursorByCharacter(1) },
      { seq: "\x1b[H", run: () => {
        watchState.composerCursor = 0;
      } },
      { seq: "\x1b[F", run: () => {
        watchState.composerCursor = watchState.composerInput.length;
      } },
      { seq: "\x1b[1~", run: () => {
        watchState.composerCursor = 0;
      } },
      { seq: "\x1b[4~", run: () => {
        watchState.composerCursor = watchState.composerInput.length;
      } },
      // Alt-Enter and Alt-Return send `\x1b\r` / `\x1b\n` in most
      // terminals. Insert a literal newline into the composer instead
      // of submitting — Shift-Enter equivalents (`\x1b[13;2u`) are
      // handled by terminals that support kitty keyboard protocol; for
      // now Alt-Enter is the universal fallback for multi-line input.
      { seq: "\x1b\r", run: () => {
        insertComposerTextValue("\n");
        watchState.composerHistoryIndex = -1;
      } },
      { seq: "\x1b\n", run: () => {
        insertComposerTextValue("\n");
        watchState.composerHistoryIndex = -1;
      } },
    ];

    for (const entry of sequenceTable) {
      if (rest.startsWith(entry.seq)) {
        entry.run();
        return index + entry.seq.length;
      }
    }

    // Treat any Escape not followed by a recognized CSI/OSC/SS3/DCS
    // introducer as a bare-escape press. Previously this only fired
    // when `rest === "\x1b"` exactly; if the user pressed Esc quickly
    // enough that a follow-up byte landed in the same input buffer,
    // the whole sequence fell through to consumeUnknownEscapeSequence
    // and the palette stayed open. Accept escape-plus-noise too.
    const isBareEscape =
      rest === "\x1b" ||
      (rest.startsWith("\x1b") &&
        rest.length > 1 &&
        rest[1] !== "[" &&
        rest[1] !== "O" &&
        rest[1] !== "]" &&
        rest[1] !== "P" &&
        rest[1] !== "\r" &&
        rest[1] !== "\n");
    if (isBareEscape) {
      if (hasActiveMarketTaskBrowser()) {
        dismissMarketTaskBrowser();
      } else if (watchState.expandedEventId) {
        watchState.expandedEventId = null;
        watchState.detailScrollOffset = 0;
        setTransientStatus("detail closed");
      } else if (currentInputModeProfile() === "vim" && watchState.composerMode !== "normal") {
        watchState.composerMode = "normal";
        setTransientStatus("vim normal");
      } else if (typeof cancelActiveChat === "function") {
        cancelActiveChat();
      }
      return index + 1;
    }

    return consumeUnknownEscapeSequence(input, index);
  }

  function handleTerminalInput(input) {
    if (shuttingDown() || input.length === 0) {
      return;
    }

    if (isTerminalSelectionModeActive()) {
      if (input.includes("\x03")) {
        shutdownWatch(0);
        return;
      }
      if (input.includes("\x11")) {
        toggleTerminalSelectionMode();
        scheduleRender();
      }
      return;
    }

    if (currentSecretPrompt()) {
      handleSecretPromptInput(input);
      return;
    }

    let index = 0;
    let didMutate = false;

    while (index < input.length) {
      const mouseWheel = parseMouseWheelSequence(input, index);
      if (mouseWheel) {
        // Only trigger a render when an actual wheel scroll fired —
        // non-wheel mouse events (clicks, drags) were previously
        // flagged as mutations and forced a full re-render each time
        // the user moved the cursor across the terminal.
        if (mouseWheel.isWheel && mouseWheel.delta !== 0) {
          scrollCurrentViewBy(mouseWheel.delta);
          didMutate = true;
        }
        index += mouseWheel.length;
        continue;
      }

      const bracketedPaste = consumeBracketedPaste(input, index);
      if (bracketedPaste) {
        didMutate = didMutate || bracketedPaste.didMutate;
        index = bracketedPaste.nextIndex;
        continue;
      }

      const char = input[index];
      if (char === "\x03") {
        shutdownWatch(0);
        return;
      }
      // Ctrl-D: EOF on empty composer (like a shell), delete-forward
      // otherwise. Previously Ctrl-D was silently discarded.
      if (char === "\x04") {
        if ((watchState.composerInput ?? "").length === 0) {
          shutdownWatch(0);
          return;
        }
        deleteComposerForward();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x0f") {
        toggleExpandedEvent();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x19") {
        copyCurrentView();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x11") {
        toggleTerminalSelectionMode();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x10" || char === "\x0e") {
        const diffNavigation = currentDiffNavigationState();
        if (diffNavigation?.enabled) {
          jumpCurrentDiffHunk(char === "\x0e" ? 1 : -1);
          didMutate = true;
          index += 1;
          continue;
        }
      }
      if (char === "\x0c") {
        // Ctrl-L: dismiss any open overlay first — otherwise the
        // cleared view still has the dropdown drawn on top and the
        // user has to press a second key to get a clean screen.
        // Collapse expanded event, close market-task browser, or
        // clear the composer palette trigger. Only when no overlay
        // is active does Ctrl-L clear the transcript itself.
        if (watchState.expandedEventId) {
          watchState.expandedEventId = null;
          watchState.detailScrollOffset = 0;
          didMutate = true;
          index += 1;
          continue;
        }
        if (hasActiveMarketTaskBrowser()) {
          dismissMarketTaskBrowser();
          didMutate = true;
          index += 1;
          continue;
        }
        clearLiveTranscriptView();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x0b") {
        deleteComposerTail();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x01") {
        watchState.composerCursor = 0;
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x05") {
        watchState.composerCursor = watchState.composerInput.length;
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        submitComposerInput();
        didMutate = true;
        index += char === "\r" && input[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (char === "\t") {
        autocompleteComposerInput();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x7f" || char === "\b") {
        deleteComposerBackward();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x1b") {
        index = handleTerminalEscapeSequence(input, index);
        didMutate = true;
        continue;
      }
      // `j` / `k` scroll the transcript when the composer is empty,
      // regardless of keybinding profile. Previously these only
      // scrolled in vim-normal mode, leaving default-profile users
      // with no single-key scroll path. When the composer has text,
      // fall through so they insert as literal characters.
      if (
        (char === "j" || char === "k") &&
        typeof watchState.composerInput === "string" &&
        watchState.composerInput.length === 0 &&
        !hasActiveComposerPalette() &&
        !hasActiveMarketTaskBrowser() &&
        !isVimNormalMode()
      ) {
        scrollCurrentViewBy(char === "k" ? 1 : -1);
        didMutate = true;
        index += 1;
        continue;
      }
      if (isVimNormalMode()) {
        if (char === "i") {
          watchState.composerMode = "insert";
          setTransientStatus("vim insert");
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "a") {
          if (watchState.composerCursor < watchState.composerInput.length) {
            watchState.composerCursor += 1;
          }
          watchState.composerMode = "insert";
          setTransientStatus("vim insert");
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "h") {
          moveComposerCursorByCharacter(-1);
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "l") {
          moveComposerCursorByCharacter(1);
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "b") {
          moveComposerCursorByWord(-1);
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "w") {
          moveComposerCursorByWord(1);
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "0") {
          watchState.composerCursor = 0;
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "$") {
          watchState.composerCursor = watchState.composerInput.length;
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "x") {
          deleteComposerForward();
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "j") {
          if (currentKeybindingProfile() === "vim") {
            scrollCurrentViewBy(-1);
          } else {
            navigateComposer(1);
          }
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "k") {
          if (currentKeybindingProfile() === "vim") {
            scrollCurrentViewBy(1);
          } else {
            navigateComposer(-1);
          }
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "p") {
          navigateComposer(-1);
          didMutate = true;
          index += 1;
          continue;
        }
        if (char === "n") {
          navigateComposer(1);
          didMutate = true;
          index += 1;
          continue;
        }
        index += 1;
        continue;
      }
      if (char < " ") {
        index += 1;
        continue;
      }

      if (!watchState.introDismissed) {
        dismissIntro();
      }
      insertComposerTextValue(char);
      watchState.composerHistoryIndex = -1;
      didMutate = true;
      index += 1;
    }

    if (didMutate) {
      scheduleRender();
    }
  }

  return {
    submitComposerInput,
    handleTerminalEscapeSequence,
    handleTerminalInput,
  };
}
