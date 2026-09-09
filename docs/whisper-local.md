# Local Whisper dictation

Whisper is an opt-in local speech-to-text engine, independent of the session's
chat model and permissions. It never submits messages itself. The Desktop client
owns microphone permission, silence detection, the captured target session, and
ordinary chat submission. No Google, OpenAI, or remote inference credentials are
used by this service. Remote browser methods do not grant access to these RPCs.

## Host setup

This implementation does **not** ship a native engine binary. Install
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) on the host, or set the
absolute `AGENC_WHISPER_CLI` executable path in the daemon's startup environment.
Without this override, macOS checks `/opt/homebrew/bin/whisper-cli` and
`/usr/local/bin/whisper-cli`; other hosts check `/usr/local/bin/whisper-cli` and
`/usr/bin/whisper-cli`. Client params and client environment snapshots cannot
choose an executable, filesystem path, URL, shell argument, or engine provider.

The AgenC Desktop distribution handles its own pinned native-engine packaging
and supplies the bundled executable through the host startup override. The
standalone Core package and this service do not download or install executable
code; the one-click model action still downloads only verified model weights.

Desktop Settings must request a model installation explicitly. Status checks
never download a model or create storage. Base is approximately 148 MB and Small
488 MB (decimal). Models are multilingual, pinned to ggml repository revision
`5359861c739e955e79d9a303bcbc70fb988958b1`, and checked against upstream LFS
SHA256 digests before atomic installation. Corrupt files are never used.

Engine setup and model download are separate steps: the Settings download action
installs model weights, not whisper.cpp itself. A missing engine must be installed
on the host first. Model installation is complete only after its integrity check;
the current RPC reports completion, not percentage progress. Show an indeterminate
download/verification state, allow cancellation, and keep the existing model usable
if a new download fails. No internet connection is needed to transcribe after the
engine and chosen model are available.

Models live under `<AGENC_HOME>/whisper` with private directory/file permissions.
Audio is accepted as canonical PCM16 mono 16 kHz WAV, maximum 30 seconds, decoded
only after strict base64/header validation. Each transcription uses a private
temporary directory removed on success, failure, timeout, and cancellation.
There is no audio history, logging of transcripts, or voice-note attachment.
One installation or transcription is admitted at a time; excess work receives
`WHISPER_BUSY`, not an unbounded queue. A transcription has a 90 second execution
deadline and a 64 KiB combined output limit. Download deadline is ten minutes.
Client cancellation and disconnect terminate the child; SIGKILL follows after
1.5 seconds if it does not stop. Silence returns an empty string, not filler text.

## Internal local RPCs

- `audio.whisper.status {}` returns `{engine:"whisper.cpp", optionsVersion:1, available, reason?, models:[{id, installed, bytes}]}`.
- `audio.whisper.install {model:"base"|"small"}` explicitly downloads a model and returns the same status.
- `audio.whisper.transcribe {model, language, audio:{mimeType:"audio/wav", data:<base64>}, task?, compute?, prompt?}` returns `{text, model, provider:"local"}`.
- Use `request.cancel {requestId}` on the same connection to cancel installation or transcription. Closing that connection also cancels it.

Input language is an explicit allowlist: `auto`, `en`, `es`, `fr`, `de`, `it`,
`pt`, `nl`, `pl`, `ru`, `uk`, `zh`, `ja`, `ko`, `ar`, `hi`, and `tr`. Automatic
language detection is available; selecting the known spoken language avoids
asking the model to detect it from short phrases.

Optional controls preserve old behavior when omitted:

- `task`: `transcribe` (default) keeps the spoken language. `translate` asks
  Whisper for **English output only** using `-tr`; it is not a general translation
  service and does not change the selected input language.
- `compute`: `auto` (default) keeps whisper.cpp's automatic acceleration behavior.
  `cpu` disables GPU inference with `-ng`; it can be slower. The existing four
  worker threads and execution deadline remain unchanged.
- `prompt`: an empty string by default. Optional vocabulary hints, such as names
  and product terms, use one `--prompt` argument. They are not a chat instruction
  or a guarantee of exact spelling. Input is limited to 500 JavaScript characters,
  must not contain C0/DEL control characters, and is trimmed before use. No shell
  is used. Avoid entering secrets: vocabulary is part of the native process's
  argument list and may be visible to local process-inspection tools.

Status responses advertise `optionsVersion: 1`, including when the engine is
missing and after successful installation. This field is optional in the type
because older Core versions omit it. Desktop must gate the additional languages
and new options on this marker; older Core rejects unknown parameters/languages.

Feature-detect these methods from `initialize.result.capabilities["daemon.methods"]`.
Use a dedicated client connection so inference/download does not block the normal
daemon control lane. Errors contain stable codes and user-safe messages, never
native stderr or temporary audio paths.

The canonical protocol schema includes `WhisperInternalRequest`, its three
request definitions and the `WhisperStatus`/`WhisperTranscription` result
definitions. `x-agenc-whisper-internal-methods` identifies this opt-in extension.
It deliberately remains outside the public request union and public method list;
publishing these validation definitions does not grant remote access.

## Licenses and redistribution

[whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/LICENSE)
is MIT licensed. [OpenAI Whisper code and model weights](https://github.com/openai/whisper#license)
are MIT licensed. The downloaded ggml models are converted Whisper weights,
not a Google language model. Preserve applicable copyright and MIT permission
notices with any future redistribution of the engine or models; private repository
visibility does not replace license obligations. This implementation introduces
no FFmpeg, SDL, Silero, or Google runtime dependency. Native binary packaging,
platform signing, and bundled-license verification belong to the distributing
application's release pipeline, separate from this Core service.

## Verification

Run the focused unit and dispatcher contracts through the repo's hermetic Vitest
wrapper. The opt-in real-engine check below creates its own temporary home,
downloads/verifies Base, transcribes the bundled upstream JFK fixture, checks
silence/temporary-file cleanup, and removes the test model/home afterward. It
never starts a daemon, reads real sessions, opens a microphone, or sends a chat.

```sh
cd runtime
WHISPER_VERIFY_DOWNLOAD=1 node --import tsx scripts/check-whisper-local.ts /opt/homebrew/opt/whisper-cpp/share/whisper-cpp/jfk.wav
```
