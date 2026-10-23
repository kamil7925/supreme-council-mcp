import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/config.js';

// Set the real Codex home in the child environment only. This also works when the
// parent shell lacks Windows home variables, as some sandboxed shells do.
const index = process.argv.indexOf('--codex-home');
const codexHome = index >= 0 ? process.argv[index + 1] : process.env.CODEX_HOME || path.join(homedir(), '.codex');
if (!codexHome || !path.isAbsolute(codexHome)) throw new Error('Provide an absolute --codex-home directory');
mkdirSync(codexHome, { recursive: true });
const env = { ...process.env, CODEX_HOME: codexHome };
const run = args => spawnSync('codex', args, { encoding: 'utf8', env, windowsHide: true });
const existing = run(['mcp', 'list', '--json']);
if (existing.status !== 0) {
  console.error('Could not inspect existing Codex MCP configuration. Check Codex CLI availability and --codex-home.');
  process.exitCode = 1;
} else if (JSON.parse(existing.stdout).some(server => server.name === 'supreme-council')) {
  console.error('A supreme-council MCP is already registered. Existing configuration was left intact.');
  process.exitCode = 1;
} else {
  const installed = run(['mcp', 'add', 'supreme-council', '--', process.execPath, path.join(ROOT, 'src/server.js')]);
  if (installed.status !== 0) {
    console.error('Codex registration failed. Use codex-config.example.toml to register the server manually.');
    process.exitCode = 1;
  } else {
    console.log('Registered supreme-council in Codex. Refresh the MCP connection to load its tools.');
  }
}
