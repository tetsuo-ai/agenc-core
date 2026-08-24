# Imagine image and video tools

LIVE tools `ImagineImage` and `ImagineVideo` call xAI Grok Imagine REST
endpoints. They are registered on the tool catalog but only run when all of
these hold:

1. Session provider is `grok`
2. Inference host is direct xAI (`api.x.ai`), not OpenRouter or another gateway
3. Credentials: `XAI_API_KEY` / `GROK_API_KEY`, or
   `/grok-login` subscription OAuth

Both tools require approval (`requiresApproval: true`) and run exclusive
(no parallel sibling Imagine calls). Files land under
`<workspace>/.agenc/imagine/` (`imagine-<uuid>.jpg`,
`imagine-video-<uuid>.mp4`). The tool result returns the path.

Catalog row: [tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md).
OAuth: [grok-oauth.md](grok-oauth.md).

## ImagineImage

Source: `runtime/src/tools/system/imagine-image.ts`.
POST `https://api.x.ai/v1/images/generations`. Tool timeout 150 s; the
request itself uses a 120 s abort.

| Argument | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | Text prompt |
| `model` | no | `grok-imagine-image` (default) or `grok-imagine-image-quality` |
| `n` | no | 1-10 images, default 1 |
| `aspect_ratio` | no | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `auto` |
| `resolution` | no | `1k` or `2k` |

Ask the agent to generate an image in a grok session, or call the tool by
name. The model only sees the tool when the gate stack above succeeds.

## ImagineVideo

Source: `runtime/src/tools/system/imagine-video.ts`.
POST `/v1/videos/generations`, then poll `GET /v1/videos/{request_id}` until
done. Tool timeout 300 s. Poll interval 5 s, poll budget 240 s.

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

- Session provider is not grok
- Base URL is not `api.x.ai` (OpenRouter is refused)
- No bearer token (set a key or run `/grok-login`)
- Missing `prompt`
- Approval denied

There is no separate `agenc imagine` CLI. These are model tools.
