# Image and video generation tools

LIVE tools `ImagineImage` and `ImagineVideo` use separately authenticated
media backends. The provider that performs the reasoning turn does **not** gate
these tools: Meta, OpenAI, Grok, and any other tool-capable model can invoke
them when the corresponding media backend is configured.

| Tool | Backend availability |
| --- | --- |
| `ImagineImage` | Meta Muse Image with `MODEL_API_KEY`, or xAI Imagine with `XAI_API_KEY`, `GROK_API_KEY`, or `/grok-login` OAuth |
| `ImagineVideo` | xAI Imagine with `XAI_API_KEY`, `GROK_API_KEY`, or `/grok-login` OAuth |

Backend authority is credential-isolated. A Meta, OpenAI, or gateway session
key is never forwarded to xAI, and an xAI key is never forwarded to Meta. A
direct Grok session may reuse its own xAI bearer; otherwise xAI media calls use
the independently configured xAI credentials. A Meta reasoning session prefers
Muse Image when `MODEL_API_KEY` is configured. Other reasoning providers can
also use Muse Image when it is the available image backend.

Both tools require approval (`requiresApproval: true`) and run exclusive
(no parallel sibling Imagine calls). Files land under
`<workspace>/.agenc/imagine/` (`imagine-<uuid>.jpg`,
`imagine-video-<uuid>.mp4`). The tool result returns the path.

Catalog row: [tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md).
OAuth: [grok-oauth.md](grok-oauth.md).

## ImagineImage

Source: `runtime/src/tools/system/imagine-image.ts`.

- Meta backend: POST
  `${META_BASE_URL:-https://api.meta.ai/v1}/images/generations` with
  `muse-image-1.0`.
- xAI backend: POST `https://api.x.ai/v1/images/generations` with
  `grok-imagine-image` or `grok-imagine-image-quality`.

The tool timeout is 150 s; the request itself uses a 120 s abort.

| Argument | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | Text prompt |
| `model` | no | Backend default: `muse-image-1.0` on Meta; `grok-imagine-image` on xAI. xAI also accepts `grok-imagine-image-quality` |
| `n` | no | 1-10 images, default 1 |
| `aspect_ratio` | no | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `auto` |
| `resolution` | no | xAI only: `1k` or `2k` |

For Meta, aspect ratios map to `1024x1024`, `1536x1024`, or `1024x1536`.
The tool accepts either base64 or URL results from both backends, downloads the
image when necessary, and saves Meta output as WebP (xAI output as JPEG) under
the workspace so desktop media rendering receives the correct content type.

## ImagineVideo

Source: `runtime/src/tools/system/imagine-video.ts`.
The execution backend is always direct xAI: POST `/v1/videos/generations`, then
poll `GET /v1/videos/{request_id}` until done. The reasoning model can belong to
any provider. Tool timeout 300 s. Poll interval 5 s, poll budget 240 s.

| Argument | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | Text prompt |
| `model` | no | `grok-imagine-video` (text-to-video default) or `grok-imagine-video-1.5-preview` (image-to-video default) |
| `image_url` | no | URL, `data:image/…` URI, or workspace path for image-to-video |
| `reference_image_urls` | no | Up to 7 references. Do not combine with `image_url` |
| `duration` | no | 1-15 seconds (max 10 with reference images). Default 8 |
| `aspect_ratio` | no | Same family as image, plus whatever the video API accepts on the wire |
| `resolution` | no | `480p` or `720p` |

Saves an MP4 under the workspace.

## Failures you will actually see

- No compatible media credential is configured
- An independently configured xAI base URL is not direct `api.x.ai`
- The requested model belongs to the other image backend
- Missing `prompt`
- Approval denied

Changing the reasoning provider does not fix a missing media credential. There
is no separate `agenc imagine` CLI; these are model tools.
