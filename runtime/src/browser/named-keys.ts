interface NamedKey {
  readonly keyCode: number;
  readonly key: string;
  readonly code: string;
  readonly text?: string;
}

export const NAMED_KEYS: Readonly<Record<string, NamedKey>> = {
  Enter: { keyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  Tab: { keyCode: 9, key: "Tab", code: "Tab" },
  Escape: { keyCode: 27, key: "Escape", code: "Escape" },
  Backspace: { keyCode: 8, key: "Backspace", code: "Backspace" },
  Delete: { keyCode: 46, key: "Delete", code: "Delete" },
  ArrowUp: { keyCode: 38, key: "ArrowUp", code: "ArrowUp" },
  ArrowDown: { keyCode: 40, key: "ArrowDown", code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, key: "ArrowLeft", code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, key: "ArrowRight", code: "ArrowRight" },
  PageUp: { keyCode: 33, key: "PageUp", code: "PageUp" },
  PageDown: { keyCode: 34, key: "PageDown", code: "PageDown" },
  Home: { keyCode: 36, key: "Home", code: "Home" },
  End: { keyCode: 35, key: "End", code: "End" },
};

export const BROWSER_NAMED_KEYS = Object.freeze(Object.keys(NAMED_KEYS));
