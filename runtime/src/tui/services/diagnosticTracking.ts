// Cherry-picked from openclaude src/services/diagnosticTracking.ts.
//
// Only the parts the wholesale-ported DiagnosticsDisplay component
// consumes are ported here: the Diagnostic + DiagnosticFile types and
// the static getSeveritySymbol() used to emit the severity glyph in
// each diagnostic row. The rest of openclaude diagnosticTracking
// (MCP IDE-RPC, file-path normalization, slowOperations) is
// product-runtime infrastructure that doesn't apply to AgenC.
//
// figures glyphs are inlined to dodge the openclaude `figures` npm
// dep + its runtime env-detection (we always use the unicode form;
// AgenC doesn't gate on Windows-fallback).

export interface Diagnostic {
  message: string;
  severity: "Error" | "Warning" | "Info" | "Hint";
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source?: string;
  code?: string;
}

export interface DiagnosticFile {
  filePath: string;
  diagnostics: Diagnostic[];
}

export class DiagnosticTrackingService {
  static getSeveritySymbol(severity: Diagnostic["severity"]): string {
    return (
      {
        Error: "✖",
        Warning: "⚠",
        Info: "ℹ",
        Hint: "★",
      }[severity] || "•"
    );
  }
}
