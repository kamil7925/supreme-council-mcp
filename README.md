# Supreme Council MCP

A local MCP server that sends the same sourced project briefing to OpenAI, Claude,
Gemini, Mistral, and optional Meta Muse Spark for independent reviews. Codex gathers context with its existing
tools; this server runs consultations and preserves their evidence and answers.

**Moving computers:** start with [TRANSFER.md](TRANSFER.md) for the exact clean
installation commands, Codex registration, machine dependencies, exclusions and
secure-transfer checklist. See [ARCHITECTURE.md](ARCHITECTURE.md) for the application
protocol and decision-making model, and [TRANSFER_VERIFICATION.md](TRANSFER_VERIFICATION.md)
for the tested setup and audit scope.

## What works in v0.4

- Five MCP tools and a reusable `council_review` prompt over stdio.
- Original and clarified questions, source excerpts/references/timestamps, assumptions,
  and missing context in an inspectable briefing with a SHA-256 content fingerprint.
- Independent concurrent provider requests, optional provider synthesis, or synthesis
  by the host from the returned reviews without an additional API call.
- Immediate consultation IDs, progress retrieval, per-member persistence, partial
  failures, timeouts, usage reporting, and explicit output-truncation flags.
- Local JSON history, dry runs, credential status, and a fully offline synthetic demo.
- Real PNG/JPEG image attachments for visual reviews, with immutable prepared copies,
  per-image hashes, labeled views, and explicit model vision capability checks.
- Explicit quick/deep profiles with separate models, output allowances and timeouts,
  preview cost estimates and profile/model history on every consultation.

## Install and configure

Requires Node.js 22+; the transfer was tested with **Node.js 24.19.0** and
**pnpm 11.25.0**, pinned in `.node-version` and `packageManager`. Install pnpm with
`npm install --global pnpm@11.25.0`. The official MCP SDK v1 maintenance line is pinned by
the lockfile for stdio client compatibility. Dependencies run no install scripts.

```powershell
pnpm install --frozen-lockfile --ignore-scripts
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Edit `.env` locally. Set the API key and an API model ID for each provider you want:

| Council member | API key variable | Model variable |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `COUNCIL_OPENAI_MODEL` |
| Claude | `ANTHROPIC_API_KEY` | `COUNCIL_CLAUDE_MODEL` |
| Gemini | `GEMINI_API_KEY` | `COUNCIL_GEMINI_MODEL` |
| Mistral | `MISTRAL_API_KEY` | `COUNCIL_MISTRAL_MODEL` |
| Meta (optional) | `META_API_KEY` | `COUNCIL_META_MODEL` |

Quick model IDs come from your environment settings. Deep defaults are documented API IDs
verified on 2026-09-18; choose overrides available to your API accounts as needed.
Use text-generating models supporting the endpoints below. This version does not
configure provider-specific reasoning settings. Some reasoning models may exhaust
the output cap before producing an answer; increase the cap if appropriate.
Chat application subscriptions and histories are not used as API credentials.
Do not put keys in tool arguments, project briefs, or chat messages.

The server loads `.env` next to this repository regardless of the launching working
directory. Existing process environment values take precedence. Restart the MCP
after changing configuration. Blank/unconfigured members are reported, never silently
substituted. A live request with any unconfigured selected member fails before sending
anything. You can explicitly select a subset of configured members.

### Add Meta Muse Spark standard tier

1. Sign in to [Meta Model API](https://dev.meta.ai/). In
   [Billing](https://dev.meta.ai/billing), add a payment method and your legal name/address.
   Meta bills accrued usage at payment thresholds or monthly; its documented flow
   is not a prepaid $50 credit purchase.
2. Set a spend alert in Billing. **An alert is not a hard cap:** Meta says usage can
   exceed it and remains payable. The council's output limits and cost previews
   also do not enforce a cumulative dollar budget.
3. In [API keys](https://dev.meta.ai/api-keys), create a key named `Supreme Council`.
   Paste it locally into `.env` as `META_API_KEY=...`; never paste it into chat.
4. Restart the MCP connection. `council_status` should report v0.4.0 and Meta configured.

Both profiles default Meta to `muse-spark-1.3` (standard tier), with their respective
output/time limits. Standard-tier prompts and completions are not used to train
Meta models. Requests go directly to `https://api.meta.ai/v1/responses`, with
`store: false`, text and native image inputs. No model fallback or automatic retry
is performed. Meta's documented non-streaming timeout can still cause a failed
long review; failures remain visible rather than triggering another paid request.

Meta is optional: omitting `providers` preserves the original four members. To run
an OpenAI/Claude/Meta deep review, explicitly pass
`providers: ["openai", "claude", "meta"]` to both preview and submission. To include
all five, pass `providers: ["openai", "claude", "gemini", "mistral", "meta"]`.
Each provider requires its own usable API quota; adding Meta does not change another account's quota.

For an isolated Meta image smoke test, first preview without network calls:

```powershell
node scripts/vision-smoke.js "C:\absolute\path\to\test.png" --profile deep --providers meta
```

After account setup, adding `--live` sends one image review to Meta only. The smoke
test caps output at 4,096 tokens in deep mode. Real inference/quota remains
unverified until that live test succeeds; offline tests verify the request format,
image bytes, five-member reviews, Meta synthesis, and failure handling.

Sources checked 2026-09-18: [pricing and standard-tier data use](https://dev.meta.ai/docs/pricing-rate-limits),
[billing setup](https://dev.meta.ai/help/billing/set-up-billing),
[billing schedule](https://dev.meta.ai/help/billing/api-bill),
[spend alerts](https://dev.meta.ai/help/billing/spend-limit-alert),
[Responses API](https://dev.meta.ai/docs/protocols/responses).

```powershell
node scripts/doctor.js
node --test test/*.test.js
node scripts/demo.js
```

The demo injects synthetic HTTP responses, uses no credentials, makes no network
requests, and writes clearly labeled illustrative data to `.council/demo/`.
It does not inspect the real the143rd project. Tests use temporary directories and
include an actual MCP client/server connection over stdio.

### Connect Codex

Run the registration command with absolute paths appropriate to your installation:

```powershell
codex mcp add supreme-council -- "C:\path\to\node.exe" "C:\path\to\Supreme council\src\server.js"
```

Alternatively, merge the table from `codex-config.example.toml` into your Codex MCP
configuration after updating its paths. Do not replace your existing configuration.
`scripts/install-codex.js` registers this checkout using the current Node executable;
it refuses to replace an existing server named `supreme-council`.

```powershell
node scripts/install-codex.js
```

Refresh/restart the MCP connection in Codex if tools do not appear. Start with
`council_status`. Then ask: “Use the Supreme Council to review the143rd's
Blender-to-Unreal pipeline. Gather relevant project context and prepare a briefing.”

## Tools and workflow

### Quick and deep profiles

Say “use the quick council” or “use the deep review council.” The host passes
`profile: "quick"` or `profile: "deep"` to both preview and live `consult_council`.
If omitted, `COUNCIL_DEFAULT_PROFILE` applies (`quick` by default).

| Member | Quick: example models (set explicitly in .env) | Deep: configured defaults |
| --- | --- | --- |
| OpenAI | GPT-4.1 mini (`gpt-4.1-mini`) | [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) (`gpt-6-astra`) |
| Claude | Haiku 4.5 (`claude-haiku-4-5-20251001`) | [Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview) (`claude-opus-5`) |
| Gemini | 3.5 Flash-Lite (`gemini-3.5-flash-lite`) | [3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) (`gemini-3.1-pro-preview`) |
| Mistral | Ministral 14B (`ministral-14b-latest`) | [Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04) (`mistral-medium-3-5`) |
| Meta (optional) | Muse Spark 1.3 standard (`muse-spark-1.3`) | Muse Spark 1.3 standard (`muse-spark-1.3`) |

Model IDs and documented image capability checked on 2026-09-18. This is a selected
review profile, not an assertion that each member is the provider's strongest model
for every task. Opus follows the requested Claude family. Gemini's Pro endpoint is a
preview; the preview response flags that explicitly. Mistral Medium 3.5 is a newer
frontier-class multimodal model despite the “Medium” name. Availability can change.

The profiles share API credentials but have separate model IDs, vision overrides,
output allowances and timeouts. Quick defaults to 4,096 output tokens / 60 seconds;
deep defaults to 16,384 tokens / 180 seconds per call. Native reasoning settings stay
at provider defaults. Reasoning can consume part of an output allowance; a larger
allowance does not guarantee a complete answer or better reasoning.

Legacy `COUNCIL_<PROVIDER>_MODEL` and `COUNCIL_<PROVIDER>_VISION` variables still
configure quick. Optional `COUNCIL_QUICK_<PROVIDER>_MODEL` / `_VISION` override them.
Use `COUNCIL_DEEP_<PROVIDER>_MODEL` / `_VISION` for deep. An explicitly blank model
disables that member. `COUNCIL_QUICK_MAX_OUTPUT_TOKENS` and
`COUNCIL_QUICK_TIMEOUT_MS` override the legacy quick limits;
`COUNCIL_DEEP_MAX_OUTPUT_TOKENS` and `COUNCIL_DEEP_TIMEOUT_MS` control deep independently.

`council_status` lists both profiles and the default, without secrets. “Configured”
means a key/model is present, not that inference access or quota is guaranteed.
Read-only account catalog checks are available via `node scripts/check-model-access.js deep`.
Catalog visibility alone does not verify generation quota or billing. Model defaults
and price tables were last checked on 2026-09-18; they are not a promise of current availability.

Every preview and saved consultation includes the selected profile, exact member
and synthesizer models, limits and `cost_estimate`. Each job snapshots its settings
before launching. A missing model/key stops submission; a provider error remains an
error for that member. Deep never silently falls back to quick. Older records show
`legacy` in history when no profile was recorded.

Cost previews use published standard paid rates dated 2026-09-18, approximate text
tokens (UTF-8 bytes / 3), and the full output allowance. Synthesis includes an extra
estimated input allowance for member reviews. They are planning estimates, not
quotes or enforced spending caps. Credits, free tiers, caching discounts and taxes
are not applied. Image input is **not** priced by this estimator: for image briefings
the total is null and only a clearly labeled text/output subtotal is shown. Unknown
model prices also produce a null total. Per-call rates and source links remain
visible so a partial estimate is never presented as a complete bill.

Example preview (submit the same profile with `dry_run: false` when authorized):

```json
{
  "briefing_id": "<returned UUID>",
  "profile": "deep",
  "providers": ["openai", "claude", "gemini", "mistral"],
  "synthesizer": null,
  "dry_run": true
}
```

After upgrading, restart the MCP connection so existing chats load the new tool
schema. `council_status` should report version `0.4.0` and both profiles.

| Tool | Purpose |
| --- | --- |
| `council_status` | Show model settings, key presence, limits, and record location; no secrets |
| `prepare_briefing` | Validate and save the original question, summary, assumptions, gaps, and selected evidence |
| `consult_council` | Preview a saved briefing or start a live consultation |
| `get_consultation` | Retrieve progress, individual reviews, synthesis, and their source briefing |
| `list_consultations` | List recent saved consultations |

The `council_review` MCP prompt accepts `project` and `question`. It guides the host
through collecting conversations, current local work, Git/GitHub state, and relevant
read-only Blender/Unreal inspection results using the host's existing tools.
This server has no direct access to ChatGPT history, GitHub, or other MCP servers.
Text source references are provenance labels, not paths/URLs it fetches. For image
attachments only, it reads the exact local files explicitly passed in `images`.
If chats are inaccessible, the host must use supplied excerpts or record that gap.
Screenshots are delivered as actual image content, not host-generated descriptions.
Other binary assets (such as .blend files) cannot be attached directly.
No project registry, automatic synchronization, or adoption of advice
as project memory is implemented yet.

Example source inside `prepare_briefing`:

```json
{
  "id": "pipeline_doc",
  "title": "Current export constraints",
  "kind": "file",
  "reference": "C:/projects/the143rd/docs/pipeline.md:42; commit <actual SHA>",
  "observed_at": "2026-09-18T12:00:00Z",
  "content": "Paste the actual relevant excerpt here."
}
```

Use the returned briefing ID to preview. `dry_run` defaults to `true`:

```json
{
  "briefing_id": "<returned UUID>",
  "profile": "quick",
  "providers": ["openai", "claude", "gemini", "mistral"],
  "synthesizer": null,
  "dry_run": true
}
```

Set `dry_run: false` to make an authorized paid consultation. Set `synthesizer` to a
configured provider for an additional synthesis call, or leave it null for the host
to synthesize the reviews. Synthesis requires at least two successful reviews.
The synthesizer receives the briefing and all review results, including failures.
For visual consultations, it also receives the same original image attachments.

### Visual reviews from Blender or Unreal

Capture useful views with the host's inspection MCP and save them as PNG or JPEG on
the machine running this server. Add an optional `images` array to `prepare_briefing`:

```json
{
  "images": [
    { "id": "front", "title": "Front orthographic, neutral solid shading", "path": "C:/captures/soldier-front.png" },
    { "id": "side", "title": "Side orthographic, neutral solid shading", "path": "C:/captures/soldier-side.png" }
  ]
}
```

This is an addition to the normal required project/question/summary/sources fields.
Source and image IDs must be unique across the briefing. A path in a text source
does not attach an image. The host must save screenshots first; the council cannot
capture Blender views itself or use an image that exists only inside another tool's response.

At preparation, the server validates file headers, dimensions and size, then snapshots
the exact bytes under `.council/images/`. Changes to the original file do not alter the
prepared evidence. Every preview/live call verifies the snapshots against their hashes.
The preview lists images, local snapshot paths, hashes, byte counts and unsupported
providers. Raw base64 is excluded from MCP output and JSON records. Live calls attach
the same labeled image bytes using each provider's native image format. Model-side
resizing/tokenization can differ; identical input does not guarantee identical perception.

`council_status` reports `server_version: "0.4.0"`, image support, and each model's
vision capability. Auto detection conservatively recognizes the models used in this
installation's quick and deep profiles
(see `src/images.js` for exact identifiers). Other model IDs require explicit operator
confirmation via `COUNCIL_QUICK_<PROVIDER>_VISION=true` or
`COUNCIL_DEEP_<PROVIDER>_VISION=true`; use `false` to disable visual use.
Do not set this merely to bypass a check: verify the chosen API model supports images.
An unverified/disabled selected member or synthesizer blocks the entire live call
before any provider is contacted. Select a supported subset explicitly if desired.
There is no silent text-only fallback or automatic model substitution.

Limits: eight images, 4 MiB per image, 10 MiB total, 8000 pixels per axis; PNG/JPEG only.
Oversized images must be resized/exported by the host before preparation. URL, UNC,
device and relative paths are rejected. Provider-specific limits may still apply.
Image input consumes API usage as well as text; output caps are not spending caps.

After upgrading, restart the `supreme-council` MCP connection in the consuming app so
the process and tool schema reload. Existing chats may retain the old schema until
their connection is refreshed. Check `council_status`, then confirm `prepare_briefing`
exposes `images`; reinstalling or changing API keys is unnecessary.

To verify delivery with a synthetic image (no paid calls without `--live`):

```powershell
node scripts/vision-smoke.js "C:\captures\test-card.png"
node scripts/vision-smoke.js "C:\captures\test-card.png" --live
```

The live test defaults explicitly to quick and uses four short responses (384 output
tokens each). `--profile deep` selects the deep models with a 4,096-token smoke-test
allowance to leave room for reasoning. This override applies only to the test process.
The script preserves the
consultation ID and results locally. Check whether the actual descriptions match the
image; successful HTTP responses alone do not establish accurate vision.

The live tool returns immediately. Keep its `consultation_id`; use
`get_consultation` with that ID after an appropriate interval. Completion states are
`complete`, `partial`, `failed`, and `interrupted`; `phase` shows reviews/synthesis/done.
Do not call `consult_council` repeatedly to poll. Each live submission creates a new
consultation and can incur new charges. There are no automatic retries or crash
resumptions. After a lost response, check `list_consultations` before resubmitting.
Run one server process per data directory. Up to two consultations can run at once
per process. Keep the MCP connection alive while jobs finish.

## Limits and storage

Quick defaults are 60 seconds per provider call and 4,096 output tokens per call;
deep uses 180 seconds and 16,384 output tokens. Both share the 60,000-character
briefing limit. An oversized briefing is rejected, never silently
truncated. Character limits are not exact token counts; the selected model may have a
smaller usable context window. Provider errors remain attached to that member's record.
Output caps do not enforce a dollar budget; configure spending limits at each provider.

`.env.example` documents the settings. A four-member consultation makes four API
requests, plus one if a synthesizer is selected and at least two reviews succeed.
Provider response text is advisory, and source citation correctness is not automatically
verified. Inspect the evidence and minority objections rather than treating votes as truth.

Records are stored in `.council/briefings/` and `.council/consultations/`, with image
snapshots in `.council/images/`, unless
`COUNCIL_DATA_DIR` points elsewhere. Briefings and reviews are sensitive project data:
they are plain local JSON, not encrypted by this application. `.env`, records, demo
outputs, and dependency caches are gitignored. Credentials are used only in provider
request headers and are not included in records or status output. Error responses do
not echo provider bodies. A live call transmits the briefing and attached images to each selected provider;
the optional synthesizer also receives member responses. No project changes are executed.

## Development and API references

`src/server.js` registers tools; `council.js` orchestrates and persists jobs;
`providers.js` handles wire formats; `schemas.js` validates inputs; `prompts.js`
contains the common review, synthesis, and host context-gathering instructions.

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [OpenAI text generation / Responses](https://developers.openai.com/api/docs/guides/text)
- [Anthropic API](https://platform.claude.com/docs/en/api/overview)
- [Gemini generateContent](https://ai.google.dev/api/generate-content)
- [Mistral chat completions](https://docs.mistral.ai/api/endpoint/chat)
- [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision)
- [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Gemini image inputs](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding)
- [Mistral vision](https://docs.mistral.ai/studio/conversations/vision)

Provider contracts are checked with fixtures. Real authentication, model availability,
provider behavior, and actual review quality still require a live smoke consultation
once keys and models are configured.

Offline fixtures establish request construction and result handling, not real model
quality. See the transfer verification report for the checks performed on this release.
