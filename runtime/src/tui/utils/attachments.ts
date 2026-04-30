// Cherry-picked from openclaude src/utils/attachments.ts.
//
// openclaude's full Attachment union has ~15 variants tied to their
// chat-attachment system (file refs, plan-mode reentries, PDF refs,
// already-read-file, …). The AgenC port currently only needs the
// `diagnostics` variant + the `DiagnosticFile` shape, which is what
// the wholesale-ported DiagnosticsDisplay narrows to via
// `Extract<Attachment, { type: 'diagnostics' }>`.
//
// As more openclaude components are wholesale-ported and consume
// other attachment variants, expand this union from openclaude
// src/utils/attachments.ts.

import type { DiagnosticFile } from "../services/diagnosticTracking.js";

export type Attachment = {
  type: "diagnostics";
  files: DiagnosticFile[];
  isNew: boolean;
};
