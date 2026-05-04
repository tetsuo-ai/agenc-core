# Markdown Rendering Parity

Checklist item: T-18

Absorbed from donor TUI rendering components into AgenC-owned paths:

- `src/components/Markdown.tsx` -> `runtime/src/tui/components/markdown/Markdown.tsx`
- `src/components/MarkdownTable.tsx` -> `runtime/src/tui/components/markdown/MarkdownTable.tsx`
- `src/components/HighlightedCode.tsx` -> `runtime/src/tui/components/markdown/HighlightedCode.tsx`
- `src/components/HighlightedCode/Fallback.tsx` -> `runtime/src/tui/components/markdown/HighlightedCodeFallback.tsx`

The single highlighted-code fallback file is flattened into the markdown
component home so AgenC does not preserve the donor subdirectory shape.
