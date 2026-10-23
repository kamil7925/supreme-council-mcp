# Transfer verification — 2026-10-22

Verified on the source Windows computer with Node **24.19.0** and pnpm
**11.25.0**, using a separate clean copy of the publishable files. That copy had
an empty-key `.env` created from `.env.example` and freshly installed dependencies.
No live model requests were made during this transfer preparation.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | Passed; 92 packages installed from the existing lockfile. |
| `pnpm run check` | Passed; server version 0.4.0, all five API keys reported absent in the clean copy. |
| `pnpm test` | **28/28 passed**, including actual local MCP stdio transport and synthetic provider/image/profile tests. |
| `pnpm run demo` | Passed; four mocked member responses completed. No provider traffic. |
| `pnpm run example` | Passed; spawned the real server, prepared synthetic evidence and returned a dry-run plan. |
| `node scripts/install-codex.js --codex-home <isolated-absolute-directory>` | Passed with an isolated Codex configuration; generated the destination-specific Node and server paths. A second run refused to overwrite the entry. |
| Source installation preservation | Original `.env`, dependency installation manifest and user Codex configuration matched their pre-work SHA-256 hashes. |

The registration helper was corrected to create a missing Codex home directory
before inspecting its configuration. It was then exercised successfully in the
isolated setup. The real user configuration was not modified.

The initial sandbox runs encountered Windows permission errors creating pnpm
links and renaming test temporary files. The same installation/test commands
passed with normal host permissions. A destination must allow writing its checkout,
package cache and temporary directories; administrator rights are not an inherent
service requirement.

## Publication security scope

The existing local repository had no branch commits or remote, but did contain
local Codex checkpoint tree objects. The transfer audit scans working files,
staged contents, and all local Git blobs, trees, commit/tag metadata, including
checkpoint and unreachable objects. It compares credential patterns and configured
local secrets (including common encodings) in memory, without printing them.
The pre-publication audit found no matches. The file inventory was also reviewed
for private records and machine-specific paths.

Only the new `main` branch is intended for publication. Local checkpoint refs and
unreachable objects are not part of that branch's history and must not be mirrored.
The repository excludes `.env`, `.council`, logs, credentials, private runtime
records, `node_modules`, local tooling and user configuration. Fixture evidence is
synthetic. Pattern scans cannot guarantee detection of every possible secret or
private passage; rerun `pnpm run audit:transfer` after future changes.

## Not tested during this preparation

- Installation on a second physical computer, macOS/Linux, or Node 22.
- Global installation of pnpm via npm; pnpm was already available on this host.
- Destination Codex sign-in, app UI refresh and an end-to-end chat invocation.
- Live provider authentication, current model availability, billing, quota or
  paid text/image inference. Model defaults and estimates were not refreshed.
- Migration of existing private consultation history or source project assets.

The actual stdio entry point was exercised by the example and transport tests.
The interactive `pnpm start` wrapper was not separately exercised; it invokes the
same `node src/server.js` entry point.

Follow [TRANSFER.md](TRANSFER.md) for installation, separate secure provisioning
of API keys, optional encrypted history transfer and destination verification.
