# Image and video generation tools

LIVE tools `ImagineImage` and `ImagineVideo` use separately authenticated
media backends. The provider that performs the reasoning turn does **not** gate
these tools: Meta, OpenAI, Grok, and any other tool-capable model can invoke
them when the corresponding media backend is configured.

Because one registry survives in-session provider switches, bootstrap keeps a
universal `ImagineImage` entry deferred even before a session or saved BYOK is
attached. Discovering it after a switch re-resolves the current backend; an
unconfigured or Coding-Plan-only session fails closed without making HTTP.

| Tool | Backend availability |
| --- | --- |
| `ImagineImage` | Meta Muse Image (`MODEL_API_KEY`), QwenCloud image APIs (`DASHSCOPE_API_KEY` / `QWEN_API_KEY` or `QWEN_TOKEN_PLAN_API_KEY`), Z.AI GLM-Image (`ZAI_API_KEY`), or xAI Imagine (`XAI_API_KEY`, `GROK_API_KEY`, or `/grok-login` OAuth) |
| `ImagineVideo` | xAI Imagine with `XAI_API_KEY`, `GROK_API_KEY`, or `/grok-login` OAuth |

Backend authority is credential-isolated. A provider session key is reused
only for that same provider's native media route. A direct Grok session may
reuse its own xAI bearer; QwenCloud and Z.AI Pay-As-You-Go sessions likewise
prefer their matching image service. A Z.AI Coding Plan credential is chat-only
and is never reused for images. Other reasoning providers reach those services only
through independently configured media credentials. No OpenAI, Meta,
QwenCloud, Z.AI, xAI, or gateway key is forwarded to a different backend.

Both tools require approval (`requiresApproval: true`) and run exclusive
(no parallel sibling Imagine calls). Files land under
`<workspace>/.agenc/imagine/` (`imagine-<uuid>.<image-extension>`,
`imagine-video-<uuid>.mp4`). The tool result returns the path.

Catalog row: [tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md).
OAuth: [grok-oauth.md](grok-oauth.md).

## ImagineImage

Source: `runtime/src/tools/system/imagine-image.ts`.

- Meta backend: POST
  `${META_BASE_URL:-https://api.meta.ai/v1}/images/generations` with
  `muse-image-1.0`.
- QwenCloud backend: the matching Pay-As-You-Go synchronous Qwen Image route,
  or Token Plan asynchronous Wan route and task polling.
- Z.AI backend: POST
  `${ZAI_BASE_URL:-https://api.z.ai/api/paas/v4}/images/generations` with
  `glm-image` (default) or `cogview-4-250304`. The separate Coding Plan base
  does not accept or advertise this general image route; only `ZAI_API_KEY`
  can authorize it.
- xAI backend: POST `https://api.x.ai/v1/images/generations` with
  `grok-imagine-image` or `grok-imagine-image-quality`.

The tool timeout is 210 s; the request/polling path uses a 180 s abort.

| Argument | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | Text prompt |
| `model` | no | Backend-specific allowlist. Defaults: `muse-image-1.0` on Meta, `qwen-image-3.0` or `wan2.7-image` on QwenCloud, `glm-image` on Z.AI, and `grok-imagine-image` on xAI |
| `n` | no | Default 1. Z.AI returns exactly one. Other backend/model limits are clamped by their documented maximum |
| `aspect_ratio` | no | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `auto` |
| `resolution` | no | QwenCloud/xAI: `1k` or `2k` |
| `quality` | no | Z.AI only: `hd` or `standard`; defaults to `hd` for `glm-image` and `standard` for CogView |

For Meta, aspect ratios map to `1024x1024`, `1536x1024`, or `1024x1536`.
QwenCloud sizes use the provider's grid/area constraints. Z.AI aspect ratios
map to its recommended model-specific sizes; arbitrary image models are
rejected from both this tool and the Z.AI chat provider. URL downloads require
credential-free HTTPS, revalidate every redirect against a provider-specific
host allowlist, stream through a 20 MiB cap, require an image content type, and
derive the saved extension from that content type.

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
- `ZAI_BASE_URL` points at the chat-only Coding Plan route
- The requested model belongs to the other image backend
- Missing `prompt`
- Approval denied

Changing the reasoning provider does not fix a missing media credential. There
is no separate `agenc imagine` CLI; these are model tools.
