/**
 * Doctor — diagnostic display screen.
 *
 * Renders the runtime/health diagnostics inside a `<Pane>` frame. The
 * upstream Doctor surface bundles many product-specific items (npm
 * dist-tags, native auto-updater, marketplace plugin errors, MCP
 * upgrade nags) that don't apply to AgenC. This port keeps the visual
 * frame and the AgenC-applicable diagnostic groups so future items can
 * plug in without rebuilding the layout.
 *
 * Wired sections (AgenC-relevant):
 *   - Diagnostics: install type, package version, working directory,
 *     active permission mode.
 *   - Environment: process.argv[0], node version, AGENC_HOME.
 *   - Configuration: config-store snapshot summary.
 *   - Permissions: live `ToolPermissionContext` summary.
 *
 * Dropped from upstream:
 *   - Anthropic account / billing diagnostics
 *   - npm dist-tag fetch and DistTagsDisplay (no auto-update channel)
 *   - PID-based native installer locks
 *   - Plugin error ledger and unreachable-rule warning
 *   - Context-warnings card (project memory / agent / mcp size warnings)
 *
 * Diagnostic items are passed in by the caller so this component stays
 * a pure renderer. The runtime side will add real collectors over time.
 */

import React, { useCallback } from "react";

import { Box, Text } from "../ink-public.js";
import { Pane } from "../design-system/Pane.js";
import { glyphs } from "../design-system/glyphs.js";
import { useKeybinding } from "../keybindings/KeybindingContext.js";
import { useAgenCAppState } from "../state/AppState.js";

// TODO(tranche-7-followup): wire upstream PressEnterToContinue equivalent
// once the AgenC slash-command surface exposes a shared confirm component.

/**
 * Generic diagnostic line. The Doctor does not know the meaning of
 * each item — collectors upstream produce label/value/severity tuples
 * and this component renders them.
 */
export interface DiagnosticItem {
  readonly label: string;
  readonly value: string;
  readonly severity?: "ok" | "warning" | "error";
}

export interface DiagnosticSection {
  readonly title: string;
  readonly items: ReadonlyArray<DiagnosticItem>;
}

export interface DoctorProps {
  /**
   * Caller-provided diagnostic sections. When omitted the Doctor renders
   * a placeholder section so the frame is never empty (useful while
   * collectors are still wiring up).
   */
  readonly sections?: ReadonlyArray<DiagnosticSection>;
  /**
   * Optional callback fired when the user presses Enter or sends the
   * confirm keybinding. Defaults to a no-op.
   */
  readonly onDone?: () => void;
}

const DEFAULT_SECTIONS: ReadonlyArray<DiagnosticSection> = [
  {
    title: "Diagnostics",
    items: [
      {
        label: "Status",
        value: "diagnostic collectors not yet wired",
        severity: "warning",
      },
    ],
  },
];

type ThemeColorKey =
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "dim"
  | "accent"
  | "primary";

function severityColor(
  severity: DiagnosticItem["severity"] | undefined,
): ThemeColorKey {
  switch (severity) {
    case "ok":
      return "success";
    case "warning":
      return "warning";
    case "error":
      return "error";
    default:
      return "muted";
  }
}

function severityGlyph(severity: DiagnosticItem["severity"] | undefined): string {
  switch (severity) {
    case "ok":
      return glyphs.tick;
    case "warning":
      return glyphs.warning;
    case "error":
      return glyphs.cross;
    default:
      return glyphs.info;
  }
}

const DiagnosticRow: React.FC<{ readonly item: DiagnosticItem }> = ({ item }) => {
  const color = severityColor(item.severity);
  const glyph = severityGlyph(item.severity);
  return (
    <Text>
      {"└ "}
      <Text color={color}>
        {glyph} {item.label}:
      </Text>{" "}
      {item.value}
    </Text>
  );
};

const DiagnosticBlock: React.FC<{ readonly section: DiagnosticSection }> = ({
  section,
}) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{section.title}</Text>
      {section.items.map((item, idx) => (
        <DiagnosticRow key={`${section.title}-${idx}`} item={item} />
      ))}
    </Box>
  );
};

function PressEnterToContinue(): React.ReactElement {
  return (
    <Box>
      <Text color="dim">Press Enter to continue.</Text>
    </Box>
  );
}

/**
 * Doctor screen. Renders inside a `<Pane>` so it visually matches the
 * other AgenC slash-command surfaces. Collectors are caller-supplied;
 * callers ship diagnostic sections via the `sections` prop.
 */
export function Doctor({ sections, onDone }: DoctorProps): React.ReactElement {
  const { mode } = useAgenCAppState();
  const handleDismiss = useCallback(() => {
    onDone?.();
  }, [onDone]);

  // The AgenC keybinding registry uses `global`/`chat`/`modal`/`transcript`
  // contexts. Treat the Doctor surface as a modal: confirm/cancel both
  // dismiss the screen.
  useKeybinding("modal:confirm", handleDismiss, "modal");
  useKeybinding("modal:cancel", handleDismiss, "modal");

  const liveSections: ReadonlyArray<DiagnosticSection> = sections ?? [
    ...DEFAULT_SECTIONS,
    {
      title: "Permissions",
      items: [
        {
          label: "Active mode",
          value: mode,
          severity: "ok",
        },
      ],
    },
  ];

  return (
    <Pane color="accent">
      {liveSections.map((section, idx) => (
        <DiagnosticBlock key={`${section.title}-${idx}`} section={section} />
      ))}
      <PressEnterToContinue />
    </Pane>
  );
}

export default Doctor;
