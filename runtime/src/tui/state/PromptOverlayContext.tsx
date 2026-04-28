/**
 * Portal for content that floats above the prompt so it escapes
 * FullscreenLayout's bottom-slot `overflowY:hidden` clip.
 *
 * The clip is load-bearing (tall pastes squash the ScrollBox without
 * it), but floating overlays use `position:absolute bottom="100%"` to
 * float above the prompt — and Ink's clip stack intersects ALL
 * descendants, so they were clipped to ~1 row.
 *
 * Two channels:
 *   - `useSetPromptOverlay` — slash-command suggestion data
 *     (structured, written by the prompt input footer)
 *   - `useSetPromptOverlayDialog` — arbitrary dialog node (e.g. an
 *     inline approval mini-dialog, written by the prompt input)
 *
 * The fullscreen layout reads both and renders them outside the
 * clipped slot.
 *
 * Split into data/setter context pairs so writers never re-render on
 * their own writes — the setter contexts are stable.
 *
 * Type note: upstream imported `SuggestionItem` from a sibling
 * `PromptInput/PromptInputFooterSuggestions` module. AgenC has not
 * landed that widget yet, so we declare a structurally compatible
 * suggestion shape locally. Tranche-4/5 widgets that import this
 * module will satisfy `SuggestionItem` shape regardless of where it
 * was originally declared.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * Local stand-in for upstream's `SuggestionItem`. The structure is the
 * subset that the overlay needs to render — concrete widgets that emit
 * suggestions will define their own item type that matches this
 * shape. Once the prompt input footer lands, we can replace this with
 * an import from there.
 */
export interface SuggestionItem {
  readonly value: string;
  readonly displayValue?: string;
  readonly description?: string;
}

export interface PromptOverlayData {
  readonly suggestions: readonly SuggestionItem[];
  readonly selectedSuggestion: number;
  readonly maxColumnWidth?: number;
}

type Setter<T> = (d: T | null) => void;

const DataContext = createContext<PromptOverlayData | null>(null);
const SetContext = createContext<Setter<PromptOverlayData> | null>(null);
const DialogContext = createContext<ReactNode>(null);
const SetDialogContext = createContext<Setter<ReactNode> | null>(null);

export interface PromptOverlayProviderProps {
  readonly children: ReactNode;
}

export function PromptOverlayProvider({
  children,
}: PromptOverlayProviderProps): React.ReactElement {
  const [data, setData] = useState<PromptOverlayData | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);

  return (
    <SetContext.Provider value={setData}>
      <SetDialogContext.Provider value={setDialog}>
        <DataContext.Provider value={data}>
          <DialogContext.Provider value={dialog}>
            {children}
          </DialogContext.Provider>
        </DataContext.Provider>
      </SetDialogContext.Provider>
    </SetContext.Provider>
  );
}

export function usePromptOverlay(): PromptOverlayData | null {
  return useContext(DataContext);
}

export function usePromptOverlayDialog(): ReactNode {
  return useContext(DialogContext);
}

/**
 * Register suggestion data for the floating overlay. Clears on
 * unmount. No-op outside the provider (non-fullscreen renders inline
 * instead).
 */
export function useSetPromptOverlay(data: PromptOverlayData | null): void {
  const set = useContext(SetContext);
  useEffect(() => {
    if (!set) return;
    set(data);
  }, [set, data]);
  useEffect(() => {
    if (!set) return;
    return () => set(null);
  }, [set]);
}

/**
 * Register a dialog node to float above the prompt. Clears on
 * unmount. No-op outside the provider (non-fullscreen renders inline
 * instead).
 */
export function useSetPromptOverlayDialog(node: ReactNode): void {
  const set = useContext(SetDialogContext);
  useEffect(() => {
    if (!set) return;
    set(node);
  }, [set, node]);
  useEffect(() => {
    if (!set) return;
    return () => set(null);
  }, [set]);
}
