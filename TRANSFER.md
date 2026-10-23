# Transfer and installation

Transfer source through the private repository; provision credentials separately.
Never copy the working directory wholesale or push `--mirror`/`--all`: it contains
ignored private records and may contain local Codex checkpoint refs.

## Requirements and exact commands

- **Node.js >=22**; recommended/tested **24.19.0** (`.node-version`). Native ESM,
  `fetch`, `process.loadEnvFile`, and the built-in Node test runner are used.
- **pnpm 11.25.0**, pinned in `package.json`; `pnpm-lock.yaml` is the dependency
  lockfile. Use a frozen install. No build/transpile step or native addon is required.
- Git and access to the private repository for cloning. GitHub authentication is
  independent of the provider API credentials and is not needed to run the service.

Install Node first; then these commands work from PowerShell or a normal shell:

```sh
npm install --global pnpm@11.25.0
git clone https://github.com/kamil7925/supreme-council-mcp.git
cd supreme-council-mcp
node --version
pnpm --version
pnpm install --frozen-lockfile --ignore-scripts
```

Create a local configuration without overwriting an existing one:

```powershell
# Windows PowerShell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
```

```sh
# macOS / Linux
test -f .env || cp .env.example .env
chmod 600 .env
```

Empty API-key entries in `.env.example` are deliberate placeholders. Set only the
keys and quick/deep API model IDs you need. API subscriptions/quotas must support
the selected model; a ChatGPT/Claude chat subscription is not an API credential.
Do not paste keys into chat, command arguments, the repository, or screenshots.
Use local filesystem permissions on Windows to restrict `.env` and runtime data.

Run the offline checks (no API keys or paid calls required):

```sh
pnpm run check
pnpm test
pnpm run demo
pnpm run example
```

`check` prints configuration and key presence, never values. `test` uses synthetic
transports. `demo` makes mocked consultations under `.council/demo`. `example`
launches the actual MCP server and previews synthetic evidence without submission.

Startup:

```sh
pnpm start
# Equivalent direct entry point, preferred for an MCP client's command/args:
node src/server.js
```

The server speaks stdio, not HTTP: a quiet terminal waiting for input is expected.
Stop a manual launch with Ctrl+C. Normally the calling application starts and stops
the child automatically. Do not separately run a daemon alongside that child using
the same data directory. Keep the MCP connection alive until consultations finish.

## Register in Codex on the destination

Install/sign in to the destination's Codex application/CLI separately. First check
`codex mcp list` for an existing `supreme-council` entry. If absent, from this checkout:

```sh
node scripts/install-codex.js
codex mcp list
```

The helper resolves the destination checkout and the Node executable running it;
it refuses to overwrite an existing integration. For a non-default Codex home:

```powershell
node scripts/install-codex.js --codex-home 'C:\Users\YOUR_NAME\.codex'
```

Alternatively use explicit destination paths:

```powershell
codex mcp add supreme-council -- 'C:\Program Files\nodejs\node.exe' 'C:\Dev\supreme-council-mcp\src\server.js'
```

On macOS/Linux replace both with actual absolute paths (find Node with
`command -v node`). Paths are arguments, not one shell command string. If the
Codex CLI is unavailable, merge and edit `codex-config.example.toml` into your
destination's `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Preserve its
other settings. Never copy the old computer's whole Codex configuration/auth files.
An existing entry needs its two paths updated, not a duplicate registration.

Restart the consuming app/MCP connection to reload code and schemas. Ask it to call
`council_status`: expect `server_version: 0.4.0`, both profiles and all five supported
provider IDs. With a configured key, that member should show `configured: true`.
This is a local stdio service, so `codex mcp login supreme-council` is unnecessary.

Official registration reference, checked 2026-10-22:
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Computer-specific dependencies and paths

| Dependency | Destination action |
| --- | --- |
| Current Node comes from the app-managed runtime cache | Install regular Node and regenerate the MCP entry; the cache path is not portable. |
| Current repository is under a user Documents/ChatGPT folder | Clone anywhere writable; `ROOT` is derived from source location. No username or source computer path is hardcoded in runtime code. |
| `.env` is loaded beside the repository | Create a destination-local file. Existing process environment wins over `.env`; restart stale clients after changes. |
| `COUNCIL_DATA_DIR` may be an absolute custom directory | Choose a writable destination path, preferably absolute. If omitted it is `<checkout>/.council`. Relative values resolve against launch working directory. |
| Prepared images store original absolute paths | New tasks must use destination-local image paths. See optional history transfer below. |
| Source references can contain project paths, commits or conversation IDs | They are labels, not auto-fetched dependencies. The caller must supply excerpts and regain access to source projects separately. |
| Hosted model APIs | HTTPS access to `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `api.mistral.ai`, and `api.meta.ai` for selected members. Configure destination firewall/proxy/trust policy normally. |
| npm registry | Needed for installation unless a trusted offline pnpm cache is provisioned. |
| Codex/GitHub/ChatGPT/Blender/Unreal context tools | Optional host integrations, separately installed and authenticated. Not dependencies of the council process or offline tests. |
| Local models, GPU, Python, FFmpeg, Blender, Unreal, external DB, container or background service | None required by this Node service. Media capture/decoding is the host's separate responsibility. |

Provider model defaults and price estimates retain the 2026-09-18 configuration;
they were not refreshed during transfer. They are not guaranteed current. Verify
availability and pricing before paid use. Token allowances are not dollar caps;
provider budget alerts may not enforce spending limits.

## Secure transfer outside Git

**Required for live use:** provision or securely transfer the five relevant API
keys (only those used), plus desired nonsecret model/profile settings. Prefer new
destination-specific keys in a password manager or encrypted transfer. Authenticate
GitHub and Codex anew; do not move credential caches, session tokens or SSH private
keys through this repository. This task does not purchase credits or change billing.

**Optional:** `.council/` and any custom `COUNCIL_DATA_DIR` contain private briefings,
reviews, images and paths. They are excluded. For a history migration, stop all
writers after jobs finish, encrypt the transfer, and preserve the full directory
layout (including content-addressed images). Existing record hashes remain valid
only if the JSON stays unchanged. Original image path labels will still refer to
the old machine; saved snapshots are loaded from the new data root. To change
paths/evidence, prepare a new briefing instead of editing hashed records. Interrupted
jobs will not resume. Project documents, videos and asset files referenced by a
briefing require their own separate transfer if wanted for future tasks.

Do not transfer `node_modules`, package caches, `.tools`, `.git` checkpoint objects,
logs, private chats or unrelated user configuration. Reinstall dependencies from
the lockfile. The original installation and its ignored data can remain intact.

## Verification and troubleshooting

See [TRANSFER_VERIFICATION.md](TRANSFER_VERIFICATION.md). After destination setup,
repeat the offline commands before an explicitly authorized live smoke test:

```sh
node scripts/example-client.js --profile deep --providers meta --live
# Optional vision test with your own destination-local PNG/JPEG:
node scripts/vision-smoke.js /absolute/path/test.png --profile deep --providers meta --live
```

Omit `--live` for previews only. Windows image arguments should be quoted absolute
drive paths. A 429 is a provider quota/rate failure; changing computers does not
fix the account quota. Catalog checks in `scripts/check-model-access.js` do not
establish inference access; Meta has no catalog check in that helper.

For future publication checks run `pnpm run audit:transfer` from the repository
root after staging. It checks working/staged files, known local secrets in memory,
credential patterns and all local Git objects (including checkpoint/unreachable
objects). Output is redacted. Manually inspect the inventory too: no heuristic
scanner guarantees detection of arbitrary credentials or sensitive prose. Push
only the intended branch after review; do not force-add ignored files.
