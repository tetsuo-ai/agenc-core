// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AgenCConfig } from '../../../config/schema.js';
import { useStdin } from '../../ink/components/StdinContext.js';
import { logError } from '../../../utils/log.js';
import { type CanonicalSettingsAuthority, getCanonicalSettingsAuthority } from '../../../utils/settings/canonicalAuthority.js';
import { autoThemeForBackground, getTerminalBackground, type TerminalBackground } from '../../../utils/terminalBackground.js'; // upstream-import: keep target is owned by another Z-PURGE item
import type { ThemeName, ThemeSetting } from '../../../utils/theme.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { saveThemeSetting, themeSettingFromConfig } from '../../../utils/themeSetting.js';
type ThemeContextValue = {
  /** The saved user preference. May be 'auto'. */
  themeSetting: ThemeSetting;
  setThemeSetting: (setting: ThemeSetting) => void;
  setPreviewTheme: (setting: ThemeSetting) => void;
  savePreview: () => void;
  cancelPreview: () => void;
  /** The resolved theme to render with. Never 'auto'. */
  currentTheme: ThemeName;
};

// Non-'auto' default so useTheme() works without a provider (tests, tooling).
const DEFAULT_THEME: ThemeName = 'dark';
const ThemeContext = createContext<ThemeContextValue>({
  themeSetting: DEFAULT_THEME,
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
  currentTheme: DEFAULT_THEME
});
type Props = {
  children: React.ReactNode;
  initialState?: ThemeSetting;
  onThemeSave?: (setting: ThemeSetting) => void;
  /**
   * The settings store whose `tui.theme` is the saved theme. Defaults to the
   * store bound when the provider mounts; read once. The provider follows
   * the store's reloads, so a theme saved by /theme or edited in
   * config.toml and reloaded shows at once.
   */
  settingsAuthority?: CanonicalSettingsAuthority | null;
};
export function ThemeProvider({
  children,
  initialState,
  onThemeSave,
  settingsAuthority
}: Props) {
  const [authority] = useState(() => settingsAuthority !== undefined ? settingsAuthority : getCanonicalSettingsAuthority());
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(() => initialState ?? themeSettingFromConfig(authority?.current(), DEFAULT_THEME));
  const [previewTheme, setPreviewTheme] = useState<ThemeSetting | null>(null);

  // Track terminal theme for 'auto' resolution. Seeds from $COLORFGBG (or
  // 'dark' if unset); the OSC 11 watcher corrects it on first poll.
  const [terminalBackground, setTerminalBackground] = useState<TerminalBackground>(() => (initialState ?? themeSetting) === 'auto' ? getTerminalBackground() : 'dark');
  const saveTheme = useCallback((setting: ThemeSetting) => {
    if (onThemeSave !== undefined) {
      onThemeSave(setting);
      return;
    }
    if (authority === null) return;
    void saveThemeSetting(setting, authority).then(({
      error
    }) => {
      if (error) logError(error);
    });
  }, [onThemeSave, authority]);

  // Follow the saved theme. /theme and its picker save through the store,
  // and /config reload picks up a hand edit; each reload lands here. A
  // preview in progress stays on top until its picker ends it.
  useEffect(() => {
    if (authority === null) return;
    const follow = (config: AgenCConfig) => {
      const saved = themeSettingFromConfig(config, DEFAULT_THEME);
      // Seed 'auto' from the cached terminal background, as a direct switch
      // does, so the OSC round-trip doesn't flash the wrong palette.
      if (saved === 'auto') setTerminalBackground(getTerminalBackground());
      setThemeSetting(saved);
    };
    if (initialState === undefined) follow(authority.current());
    const unsubscribe = authority.subscribe(follow);
    return () => {
      unsubscribe?.();
    };
  }, [authority, initialState]);

  // The setting currently in effect (preview wins while picker is open)
  const activeSetting = previewTheme ?? themeSetting;
  const previewRef = useRef(previewTheme);
  previewRef.current = previewTheme;
  const {
    internal_querier
  } = useStdin();

  // Watch for live terminal theme changes while 'auto' is active. The watcher
  // polls OSC 11 immediately, then continues polling until this effect cleans
  // it up. COLORFGBG remains the synchronous seed above so first render never
  // waits on the terminal round-trip.
  useEffect(() => {
    if (activeSetting !== 'auto' || !internal_querier) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import('../../../utils/terminalBackgroundWatcher.js').then(({
      watchTerminalBackground
    }) => {
      if (cancelled) return;
      try {
        cleanup = watchTerminalBackground(internal_querier, setTerminalBackground);
      } catch (error) {
        logError(error);
      }
    }, logError);
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [activeSetting, internal_querier]);
  const currentTheme: ThemeName = activeSetting === 'auto' ? autoThemeForBackground(terminalBackground) : activeSetting;
  const value = useMemo<ThemeContextValue>(() => ({
    themeSetting,
    setThemeSetting: (newSetting: ThemeSetting) => {
      setThemeSetting(newSetting);
      setPreviewTheme(null);
      // Switching to 'auto' restarts the watcher (activeSetting dep), whose
      // first poll fires immediately. Seed from the cache so the OSC
      // round-trip doesn't flash the wrong palette.
      if (newSetting === 'auto') {
        setTerminalBackground(getTerminalBackground());
      }
      saveTheme(newSetting);
    },
    setPreviewTheme: (newSetting_0: ThemeSetting) => {
      setPreviewTheme(newSetting_0);
      if (newSetting_0 === 'auto') {
        setTerminalBackground(getTerminalBackground());
      }
    },
    // Both read the live preview, so a picker may hold these from its first
    // render and still end the preview it started.
    savePreview: () => {
      const preview = previewRef.current;
      if (preview !== null) {
        setThemeSetting(preview);
        setPreviewTheme(null);
        saveTheme(preview);
      }
    },
    cancelPreview: () => {
      setPreviewTheme(null);
    },
    currentTheme
  }), [themeSetting, currentTheme, saveTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Returns the resolved theme for rendering (never 'auto') and a setter that
 * accepts any ThemeSetting (including 'auto').
 */
export function useTheme() {
  const $ = _c(3);
  const {
    currentTheme,
    setThemeSetting
  } = useContext(ThemeContext);
  let t0;
  if ($[0] !== currentTheme || $[1] !== setThemeSetting) {
    t0 = [currentTheme, setThemeSetting];
    $[0] = currentTheme;
    $[1] = setThemeSetting;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  return t0;
}

/**
 * Returns the raw theme setting stored by the canonical settings authority.
 * Use this in UI that needs to show 'auto' as a distinct choice (for example,
 * ThemePicker).
 */
export function useThemeSetting() {
  return useContext(ThemeContext).themeSetting;
}
export function usePreviewTheme() {
  const $ = _c(4);
  const {
    setPreviewTheme,
    savePreview,
    cancelPreview
  } = useContext(ThemeContext);
  let t0;
  if ($[0] !== cancelPreview || $[1] !== savePreview || $[2] !== setPreviewTheme) {
    t0 = {
      setPreviewTheme,
      savePreview,
      cancelPreview
    };
    $[0] = cancelPreview;
    $[1] = savePreview;
    $[2] = setPreviewTheme;
    $[3] = t0;
  } else {
    t0 = $[3];
  }
  return t0;
}
