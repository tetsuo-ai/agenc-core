# MCP display attachments

Core uses MCP content annotations from SDK 1.29.0, whose latest protocol version is `2025-11-25`. Its `ContentBlock` union includes annotations, embedded resources, and resource links, and Core's normalizer handles all three. Put `annotations: { audience: ["user"] }` on a content block to show it to the user without sending its payload to the model. The audience must be exactly `["user"]`. Unannotated blocks and assistant audience blocks keep their existing model behavior. Each accepted attachment contributes one short model caption; each rejected one contributes a reason caption.

## Blocks

| Kind | MCP block | MIME | Payload |
| --- | --- | --- | --- |
| Chart | Embedded `resource` with `resource.text` | `application/vnd.agenc.chart+json` | Chart v1 JSON, at most 512 KiB |
| Table | Embedded `resource` with `resource.text` | `application/vnd.agenc.table+json` | Table v1 JSON, at most 512 KiB |
| Image | `image` with base64 `data`, embedded `resource` with base64 `blob`, or a `resource_link` with a `file:` URI | PNG, JPEG, WebP, GIF | At most 5 MiB of image bytes per result |
| File | embedded `resource` with base64 `blob`, or a `resource_link` with a `file:` URI and `name` | `application/octet-stream`, `text/plain`, `text/csv`, `text/calendar`, `application/pdf`, `application/zip` | At most 32 MiB per file |

At most eight accepted attachments appear in one result, subject to the 4 MiB completion journal row limit. Images are structurally checked and their bytes must match their MIME. SVG and HTML are not display formats. On Linux, a linked file must be a regular file inside the calling plugin's `AGENC_PLUGIN_DATA` directory or the session workspace; descriptor traversal protects those roots. On macOS, FreeBSD, and other platforms without Linux descriptor traversal, every `file:` link is refused, including links inside the plugin data directory. The fixed refusal caption asks the plugin to send an embedded resource instead. An embedded resource with a canonical base64 `blob` and supported MIME works on every platform under the same image and file size limits. Links outside the allowed roots, including symlink escapes, are rejected. A PNG/JPEG/WebP/GIF link without a MIME is inferred from its extension and still checked against its bytes. All accepted and rejected display attempts share a 64 MiB read and validation budget per result; a file link consumes at least 8 MiB, and unsupported MIME is rejected before opening.

The 512 KiB JSON cap covers the 504 bar finance example with room for overlays while keeping validation bounded. The 5 MiB image cap matches Core's existing MCP result envelope. The 32 MiB file cap permits ordinary exports. The eight entry cap bounds transcript and UI work per tool completion. Inline attachment metadata has a 3.5 MiB aggregate budget, so fewer than eight large tables may be accepted. Core also measures the full serialized completion, including ordinary output and metadata, before persisting attachments; ordinary output is shortened when needed to keep the completion within the recovery row limit.

Chart and table `resource.text` must contain one JSON document. Timeseries chart v1 validation mirrors the rules in Desktop `src/renderer/src/chartSpec.ts`: real daily dates or representable UNIX seconds, finite numbers, one time format across series, ascending unique times, valid OHLC ranges, at most eight series and 5,000 points each, and markers on actual data points. Changes to either validator must be mirrored in the other. Core also accepts bounded `category`, `xy`, and `pie` chart v1 documents; Desktop must add renderers for those kinds. Tables have 1–32 unique columns, 0–1,000 rows, scalar cells, and no undeclared row keys.

The other chart v1 bodies are `{version:1, kind:"category", title, categories:[string], series:[{name, values:[number]}]}` (one value per category), `{version:1, kind:"xy", title, series:[{name, data:[{x:number,y:number}]}]}`, and `{version:1, kind:"pie", title, slices:[{label, value:number}]}` (nonnegative values). A table body is `{version:1, title, columns:[{key,label,format?}], rows:[{[key]: string|number|boolean|null}]}`. Timeseries series use `line`, `area`, or `histogram` with `{time,value}` points, or `candlestick` or `bar` with `{time,open,high,low,close}` points. See the Core and Desktop validators for all limits and optional fields.

For example:

```json
{
  "content": [
    {
      "type": "resource",
      "annotations": { "audience": ["user"] },
      "resource": {
        "uri": "agenc:chart:price",
        "mimeType": "application/vnd.agenc.chart+json",
        "text": "{\"version\":1,\"kind\":\"timeseries\",\"title\":\"Price\",\"series\":[{\"name\":\"Close\",\"type\":\"line\",\"data\":[{\"time\":\"2026-09-23\",\"value\":100}]}]}"
      }
    }
  ]
}
```

## Delivery and retention

The durable `tool_call_completed` event carries `payload.displayAttachments`. Each entry has `id`, `kind`, `title`, `mimeType`, `size`, and `digest`; chart and table entries also have inline `data`. An `event.session_event` notification delivers the same event live. `session.transcript.v2` includes an event of type `tool_call_completed` with `payload.displayAttachments` for clients negotiating protocol 1.18 or later; older clients receive their prior transcript projection. The snapshot omits chart and table `data` above 8 KiB; clients fetch those bytes by `id`. It caps the full response at 384 KiB before transport wrapping, keeps the newest message when history exceeds that size, and sets `truncated: true` when older rows are omitted. An oversized message body is stored as an artifact; its row carries a `textArtifact` digest and a short fetch caption. The TUI restores attachment captions and warns when a snapshot was truncated. Code-mode nested tool completions also publish attachment events.

Artifact bytes are fetched with authenticated `session.artifact.read({ sessionId, id, offset?, length? })` under protocol 1.18, which returns at most 512 KiB as base64 with `size`, `offset`, and `nextOffset` (`null` at EOF). Clients advance `offset` to `nextOffset` and verify the SHA-256 digest after reassembly. Protocol 1.17 is reserved for the routine session preparation handshake and cannot read display artifacts. The method never accepts a path. This chunked response fits the SDK socket and remote response limits for files up to 32 MiB. The id is a SHA-256 digest scoped to that session's store. Chart and table digests cover the validated JSON after secret redaction, matching both inline `data` and stored bytes. Artifact bytes are written to a temporary file, fsynced, atomically published, and directory fsynced before the completion event is published. Archive cleanup waits for active writers to stop and can be retried after a failed removal.

The TUI uses the model caption. A sub-agent's model-facing caption can enter its parent summary, while the artifact stays in the child's session. The parent transcript does not duplicate child bytes.
