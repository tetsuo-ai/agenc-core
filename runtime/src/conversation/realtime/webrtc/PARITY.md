# Realtime WebRTC Parity

Upstream reference root: local CX runtime donor checkout at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:

- `realtime-webrtc/src/lib.rs`
- `realtime-webrtc/src/native.rs`
- `realtime-webrtc/Cargo.toml`

This directory owns the TypeScript port of the realtime WebRTC session
primitive:

- `lib.ts` owns the public session, handle, event receiver, local audio peak,
  error, and unsupported-platform surface.
- `native.ts` owns offer creation, answer application, close/failure events,
  local audio-level polling, and host WebRTC capability detection.
- `webrtc.contract.test.ts` covers the unsupported fallback, SDP lifecycle,
  event stream, close semantics, error wrapping, and local audio-level helpers.

`Cargo.toml` contributes only Rust crate metadata and the original native
dependency declaration. AgenC intentionally has no Cargo counterpart here:
the implementation uses WebRTC primitives supplied by the host Node/Electron
runtime rather than binding the native crate.

Host WebRTC runtimes also own captured media stream and track identifiers.
The source native crate creates fixed `realtime` / `realtime-mic` identifiers,
but browser/Electron `MediaStream.id` and `MediaStreamTrack.id` values are
host-generated and can be readonly. AgenC preserves the offer/answer lifecycle
and event surface without mutating those host identifiers.
