import { describe, expect, test, vi } from "vitest";

import type { KeybindingBlock, ParsedBinding } from "./types.js";
import {
  checkDuplicates,
  checkReservedShortcuts,
  formatWarning,
  formatWarnings,
  validateBindings,
  validateUserConfig,
} from "./validate.js";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

describe("keybinding validation", () => {
  test("rejects non-array configs and malformed blocks", () => {
    expect(validateUserConfig({})).toEqual([
      expect.objectContaining({
        message: "tui.keybindings must contain an array",
        severity: "error",
        suggestion: "Set tui.keybindings to an array of override blocks",
        type: "parse_error",
      }),
    ]);

    const warnings = validateUserConfig([
      null,
      {},
      { context: "Nope", bindings: [] },
      { context: "Chat" },
    ]);

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Keybinding block 1 is not an object",
          type: "parse_error",
        }),
        expect.objectContaining({
          message: 'Keybinding block 2 missing "context" field',
          type: "parse_error",
        }),
        expect.objectContaining({
          context: "Nope",
          suggestion: expect.stringContaining("Valid contexts:"),
          type: "invalid_context",
        }),
        expect.objectContaining({
          message: 'Keybinding block 4 missing "bindings" field',
          type: "parse_error",
        }),
      ]),
    );
  });

  test("validates key syntax and action values", () => {
    const warnings = validateUserConfig([
      {
        context: "Chat",
        bindings: {
          "ctrl++": "chat:submit",
          " ": "chat:submit",
          a: 42,
          b: "command:bad command",
          c: "modal:confirm",
        },
      },
      {
        context: "Global",
        bindings: {
          x: "command:run",
        },
      },
    ]);

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "ctrl++",
          message: expect.stringContaining('Invalid chord "ctrl++"'),
          type: "parse_error",
        }),
        expect.objectContaining({
          key: "a",
          message: 'Invalid action for "a": must be a string or null',
          type: "invalid_action",
        }),
        expect.objectContaining({
          action: "command:bad command",
          key: "b",
          severity: "warning",
          type: "invalid_action",
        }),
        expect.objectContaining({
          action: "modal:confirm",
          key: "c",
          message: 'Unknown action "modal:confirm" for "c"',
          severity: "error",
          type: "invalid_action",
        }),
        expect.objectContaining({
          action: "command:run",
          context: "Global",
          suggestion: 'Move this binding to a block with "context": "Chat"',
          type: "invalid_action",
        }),
      ]),
    );
  });

  test("detects duplicate normalized bindings within a context only when action differs", () => {
    const blocks: KeybindingBlock[] = [
      {
        context: "Chat",
        bindings: {
          "control+x": "chat:cancel",
          "ctrl+x": "chat:submit",
          "alt+a": "chat:stash",
          "option+a": "chat:stash",
        },
      },
      {
        context: "Global",
        bindings: {
          "ctrl+x": "app:toggleTodos",
        },
      },
    ];

    expect(checkDuplicates(blocks)).toEqual([
      expect.objectContaining({
        action: "chat:submit",
        context: "Chat",
        key: "ctrl+x",
        suggestion: 'Previously bound to "chat:cancel". Only the last binding will be used.',
        type: "duplicate",
      }),
    ]);
  });

  test("flags reserved shortcuts and preserves parsed binding metadata", () => {
    const warnings = checkReservedShortcuts([
      {
        action: "chat:submit",
        chord: [
          {
            alt: false,
            ctrl: true,
            key: "c",
            meta: false,
            shift: false,
            super: false,
          },
        ],
        context: "Chat",
      },
    ] as ParsedBinding[]);

    expect(warnings).toEqual([
      expect.objectContaining({
        action: "chat:submit",
        context: "Chat",
        key: "ctrl+c",
        severity: "error",
        type: "reserved",
      }),
    ]);
  });

  test("validateBindings suppresses exact default echoes but flags real reserved overrides", () => {
    const defaultEcho = validateBindings(
      [
        {
          context: "Global",
          bindings: {
            "ctrl+c": "app:interrupt",
            "ctrl+d": "app:exit",
          },
        },
      ],
      [],
    );
    expect(defaultEcho).toEqual([]);

    const override = validateBindings(
      [
        {
          context: "Global",
          bindings: {
            "ctrl+c": "app:redraw",
          },
        },
      ],
      [],
    );
    expect(override).toEqual([
      expect.objectContaining({
        action: "app:redraw",
        context: "Global",
        key: "ctrl+c",
        type: "reserved",
      }),
    ]);
  });

  test("deduplicates repeated warnings from the combined validator", () => {
    const warnings = validateBindings(
      [
        {
          context: "Chat",
          bindings: {
            "ctrl++": "chat:submit",
          },
        },
      ],
      [],
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(
      expect.objectContaining({
        key: "ctrl++",
        type: "parse_error",
      }),
    );
  });

  test("formats one or many warnings for display", () => {
    expect(
      formatWarning({
        message: "Bad key",
        severity: "error",
        suggestion: "Use another key",
        type: "parse_error",
      }),
    ).toBe("✗ Keybinding error: Bad key\n  Use another key");

    expect(formatWarnings([])).toBe("");
    expect(
      formatWarnings([
        {
          message: "Bad key",
          severity: "error",
          type: "parse_error",
        },
        {
          message: "Risky key",
          severity: "warning",
          type: "reserved",
        },
      ]),
    ).toBe(
      [
        "Found 1 keybinding error:",
        "✗ Keybinding error: Bad key",
        "",
        "Found 1 keybinding warning:",
        "! Keybinding warning: Risky key",
      ].join("\n"),
    );
  });
});
