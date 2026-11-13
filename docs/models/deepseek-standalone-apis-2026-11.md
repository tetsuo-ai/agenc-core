# DeepSeek standalone APIs, verified 2026-11-13

This note covers client tool backends, independent of the reasoning provider.
It does not change the native DeepSeek chat request, wire format, or replay.

## Sources and API facts

The [2026-11-13 announcement](https://api-docs.deepseek.com/news/news261113/)
and [chatbot overview](https://api-docs.deepseek.com/guides/build_a_chatbot)
distinguish built-in model tools from standalone services. Core already had
Search and Fetch clients for native DeepSeek sessions at the starting commit;
this change adds explicit provider-independent selection and OCR extraction.
A successful HTTP 200 that is too large, truncated, or malformed leaves tool
billing unknown. Local response failures do not prove that the service was free.

| API | Request and result | Limits | Listed fee |
| --- | --- | --- | --- |
| [Search](https://api-docs.deepseek.com/api/search) | `POST /v1/tools/search`, bearer auth, JSON `query`, `count`; returns `results` with title, URL, snippet, summary, date and site | Query 1–128 Unicode characters; count 1–50; 100 requests/sec/account | $0.75/1,000 successful nonempty requests |
| [Fetch](https://api-docs.deepseek.com/api/fetch) | `POST /v1/tools/fetch`, bearer auth, JSON `url`; returns title and Markdown content | HTTP(S) URL, host required, no credentials, at most 8,192 characters; 25 requests/sec/account plus an unpublished domain limit | $0.75/1,000 successful content responses |
| [OCR](https://api-docs.deepseek.com/guides/ocr) | `POST /v1/tools/ocr`, bearer auth, multipart `purpose=text_recognition` then `file`; returns indexed pages, text, finish reason and page count | 100 MiB; 1,000 pages; upload within 120 seconds with no pause over 30 seconds; total 180 seconds; 15 recognitions/account | $0.225/1,000 recognized pages |

Search and Fetch fees depend on successful content, not result count or tokens.
Empty searches, failures and timeouts are free according to the
[Search & Fetch guide](https://api-docs.deepseek.com/guides/search).
Core's standalone calls pace Search starts by 10 ms and Fetch starts by 40 ms
within one process, across credentials. Separate Core processes and other
clients share the upstream account quota; the service can still return 429.
The existing Fetch client retries transient statuses at most once within its
time budget. Credential-bearing requests never follow HTTP redirects.

OCR supports PDF, Word DOC/DOCX, PowerPoint PPT/PPTX and PNG/JPEG/WebP/GIF/BMP/TIFF.
It detects actual content, not just the extension. Text recognition directly
extracts text from Word/PowerPoint files without images; other inputs undergo
page recognition. Special coordinate tokens may remain in output. `length`
means a page is incomplete. Keepalive newlines precede the JSON result. An
HTTP 200 response may contain an `error` instead of a result. OCR usage tokens
are informational; billing uses `page_count`. A disconnected recognition can
continue, occupy a concurrency slot, and be billed. Core does not retry uploads.
See the [OCR schema](https://api-docs.deepseek.com/api/ocr) and
[pricing page](https://api-docs.deepseek.com/quick_start/pricing).

## File Parsing is not an extraction download API

The [File Parsing guide](https://api-docs.deepseek.com/guides/document_parsing)
describes `POST /files`, with `purpose` before `file`. Parsed PDF/Office/image
uploads accept 100 MiB and 1,000 pages, with 120-second upload and parsing limits
and 15 concurrent uploads/account. The returned file ID is used by
`deepseek-flash` chat. Neither original nor parsed content can be downloaded.

XLS/XLSX and supported ebooks use `purpose=user_data`, with 32 MiB original and
8 MiB extracted-text limits; those uploads are free. Their converted text is
available to DeepSeek chat through the file ID, not through a standalone text
response. Therefore Core uses OCR for supported formats and gives Excel users
a local-reading/export-to-PDF hint. It does not upload a spreadsheet that the
active Ollama/OpenRouter model cannot read, and does not silently introduce a
second reasoning model call. Figure extraction and rich layout are not enabled.

## Core behavior and privacy

The new selections are off by default and independently configurable through
`tools_config.web_search_provider = "deepseek"`,
`tools_config.web_fetch_provider = "deepseek"`, and
`tools_config.file_read_provider = "deepseek"`. The invoking session's DeepSeek
environment key or normal native secure-storage key supplies credentials.
The reasoning model's key is never used. Missing credentials fail closed.
The normal DeepSeek base URL and session transport settings apply. No new
credential store, key file, or ambient environment lookup is introduced.

Ordinary `FileRead` retains local text, Poppler PDF, image, and notebook behavior.
An enabled `extract_text=true` call asks to upload the whole file and is bound
to its checked path/inode before approval. Read denies remain effective.
Delegated read-only authority cannot upload. No page selection silently becomes
a whole-document upload. OCR text has explicit DeepSeek attribution and full
external untrusted-data markers. It is not recorded as an editable raw-file read.
Errors do not include provider bodies, keys, or document text. Extraction is
bounded locally and reports truncation. Costs use the existing admission ledger;
ambiguous upload outcomes remain unknown instead of being recorded as free.

Standalone Fetch asks about provider-side redirects. It requires a public URL
and public local DNS results and refuses configured `web_fetch` rules because
DeepSeek does not expose redirect destinations for local policy checks. The
local fetch backend remains available for that policy. Search results preserve
source URLs and domain filtering; a filtered-to-empty paid search remains billed.

See [configuration](../reference/config.md#standalone-deepseek-tools).

## Live evidence

On 2026-11-13 a job-local recorder used the approved credential loader from
`round4/jobs/h2h12/rv_recorder.py`. Only the recorder held the key. A placeholder
key reached the Core clients; only the three exact standalone endpoints and
synthetic/public inputs were allowed. The recorder capped liability below $0.20.

| Call | Outcome | Fee |
| --- | --- | --- |
| Search for `DeepSeek API documentation`, count 1 | HTTP 200, one result with source URL | $0.000750 |
| Fetch `https://example.com/` | HTTP 200, title and 916 characters of multilingual content | $0.000750 |
| OCR a synthetic one-page DOCX | HTTP 200, one complete page, expected text recognized | $0.000225 |
| Total | Three calls; recorder key scan clean | **$0.001725** |

Recorded response fixtures live in
`runtime/tests/llm/providers/deepseek/fixtures/standalone-*.json`. The OCR text
is redacted; request upload bytes and OCR text were not logged. The client
initially looked for the page title inside Fetch's content; the recorded title
field and nonempty body independently verified the result without another call.
