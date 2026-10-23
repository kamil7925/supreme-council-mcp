# Architecture and application integration

Supreme Council v0.4.0 is a **local Node.js ESM process exposing MCP over stdio**.
It has no HTTP endpoint, listening port, web UI, database service, or scheduler.
The client launches `node /absolute/path/to/src/server.js` and keeps the pipes open.

## Members and decision-making

| Member ID | Hosted API | Credential variable |
| --- | --- | --- |
| `openai` | OpenAI Responses | `OPENAI_API_KEY` |
| `claude` | Anthropic Messages | `ANTHROPIC_API_KEY` |
| `gemini` | Google generateContent | `GEMINI_API_KEY` |
| `mistral` | Mistral chat completions | `MISTRAL_API_KEY` |
| `meta` | Meta Responses, Muse Spark standard by default | `META_API_KEY` |

`quick` and `deep` select independent model/output/time settings, sharing credentials.
Check `council_status` for the actual configured models. Omitted `providers` selects
the original four members; **Meta must be explicitly included**. Choose a subset
when only some accounts are configured. No model or provider is silently replaced.

Members independently receive the same sourced briefing and optional image bytes.
They do not see each other's first responses. There is **no voting algorithm, majority
rule, iterative debate, automatic truth check, or automatic project modification**.
With `synthesizer: null`, the calling app/host interprets the returned opinions.
An optional synthesizer makes one extra provider call after at least two reviews
succeed, using the briefing, images and member responses. Its instructions preserve
disagreement, minority objections and evidence gaps; agreement is not proof.

## Application protocol

1. Connect an MCP client and discover tools with `listTools`.
2. Call `council_status` (no network). Key presence does not establish usable quota.
3. Call `prepare_briefing` with `project`, the original `question`, a `summary`, and
   at least one source `{id,title,reference,kind,observed_at,content}`. Optional fields
   include `clarified_question`, `assumptions`, `missing_context` and `images`.
   This writes a local immutable-by-hash evidence record and returns `briefing_id`.
4. Call `consult_council` with that ID, explicit `profile`/`providers`,
   `synthesizer: null` (or a selected provider), and `dry_run: true`. Review the exact
   inputs, model IDs, limits, missing configuration and qualified cost estimate.
5. Only for an authorized live request, submit **the same arguments** with
   `dry_run: false`. It starts concurrent reviews and promptly returns `consultation_id`.
6. Poll `get_consultation` with `{consultation_id}` until `status` is no longer
   `running`. Keep the server process alive. Do not resubmit to poll.

MCP results contain JSON in `content[0].text`; check `isError` before parsing.
Validation/configuration failures return a tool error. Per-provider network/quota
failures appear in persisted review entries. Final status is `complete`, `partial`,
`failed`, or `interrupted`. Truncated answers make a run partial. Records expose
individual text, model identity, usage, elapsed time and error/truncation metadata.
`list_consultations` recovers recent IDs after a lost acknowledgement.

### Runnable external-app example

`scripts/example-client.js` uses the installed MCP SDK to spawn the server, prepare
synthetic evidence and preview it. It works without Codex or API credentials:

```sh
node scripts/example-client.js
```

After configuring keys, this explicit paid command adds submission and polling:

```sh
node scripts/example-client.js --profile deep --providers openai,claude,meta --live
```

Adapt the example's briefing to the caller's input and use an absolute server path
when the caller lives elsewhere. The package is private; another Node application
can install its own compatible `@modelcontextprotocol/sdk`, while other languages
can use an MCP stdio client. There is no REST `POST /task` endpoint to call.

## Evidence, storage and process boundaries

- The host gathers context. The service cannot read ChatGPT history, GitHub files,
  arbitrary source-reference paths, or invoke Blender/Unreal MCPs itself.
- Explicit image paths are the exception: absolute local PNG/JPEG paths are read
  and copied to content-addressed storage. URLs/UNC/relative paths are rejected.
  Limits: 8 images, 4 MiB each, 10 MiB combined, 8000 pixels per axis. Header checks
  are not a full image decoder. A video must first be sampled outside the service.
- `.council/briefings`, `.council/consultations` and `.council/images` hold sensitive
  local records, unencrypted. `COUNCIL_DATA_DIR` can relocate them. Use one server
  process per data directory: job tracking and the two-job limit are in memory,
  not coordinated between processes. Separate clients should use separate data
  directories or a deliberately shared long-lived host, not concurrent writers.
- Stopping the process interrupts unfinished work. Completed responses persist;
  interrupted requests are not retried or resumed automatically. A request may
  have incurred usage even if its response was lost.
- Live requests disclose the selected evidence to the selected providers.
  Credentials are header-only; status does not emit them, and provider error
  bodies are discarded. Treat model output and source text as untrusted.
- There is no MCP OAuth/login layer here: access to local process pipes is the
  boundary. Do not expose it remotely without separately designing authentication.

## Code map

| File | Responsibility |
| --- | --- |
| `src/server.js` | MCP tools and context-gathering prompt |
| `src/config.js`, `src/schemas.js` | Environment/profile loading and input validation |
| `src/council.js` | Concurrent jobs, persistence and optional synthesis |
| `src/providers.js` | Native HTTP payloads, timeouts and response normalization |
| `src/images.js`, `src/store.js` | Evidence snapshots and local records |
| `src/prompts.js`, `src/pricing.js` | Review instructions and dated heuristic estimates |
| `test/` | Synthetic provider fixtures and real local stdio transport checks |
