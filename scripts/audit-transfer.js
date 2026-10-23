// Local, redacted audit of publishable files and ALL local Git objects.
// This is a heuristic check, not a guarantee that arbitrary sensitive prose is absent.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

function git(args, input) {
  const result = spawnSync('git', args, { encoding: 'utf8', input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git audit failed: ${args[0]}`);
  return result.stdout;
}
const forbidden = /(^|\/)(?:node_modules|\.pnpm-store|\.council|\.tools|\.codex|\.agents|\.aws|\.ssh)(\/|$)|(^|\/)\.env(?!\.example$)(?:\.|$)|\.(?:log|pem|key|p12|pfx|zip|bak)$/i;
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['provider-token', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['aws-access-id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/],
  ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['literal-secret-assignment', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][A-Za-z0-9_+\/-]{24,}["']/i],
];
// Compare local configured secrets in memory; never emit them or save them in a report.
const localEnv = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const known = [...new Set(Object.entries({ ...localEnv, ...process.env })
  .filter(([name, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && value?.length >= 12)
  .map(([,value]) => value))];
const variants = [...new Set(known.flatMap(value => [value, Buffer.from(value).toString('base64'), encodeURIComponent(value)]))];
const findings = [];
function scan(label, text) {
  for (const [rule, regex] of patterns) if (regex.test(text)) findings.push({ location: label, rule });
  if (variants.some(value => text.includes(value))) findings.push({ location: label, rule: 'known-local-secret' });
}
const paths = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
for (const file of paths) {
  if (forbidden.test(file)) findings.push({ location: file, rule: 'excluded-file' });
  if (existsSync(file)) scan(`worktree:${file}`, readFileSync(file, 'utf8'));
}
const staged = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
for (const entry of staged) {
  const match = entry.match(/^\d+ ([a-f0-9]+) \d\t([\s\S]+)$/);
  if (match) scan(`index:${match[2]}`, git(['cat-file', 'blob', match[1]]));
}
const objects = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim().split(/\r?\n/).filter(Boolean);
let blobs = 0, metadata = 0, trees = 0;
for (const entry of objects) {
  const [oid, type] = entry.split(' ');
  if (['blob', 'commit', 'tag'].includes(type)) {
    scan(`git-${type}:${oid}`, git(['cat-file', type, oid]));
    if (type === 'blob') blobs++; else metadata++;
  } else if (type === 'tree') {
    trees++;
    for (const file of git(['ls-tree', '-r', '--name-only', '-z', oid]).split('\0').filter(Boolean)) {
      if (forbidden.test(file)) findings.push({ location: `git-tree:${oid}:${file}`, rule: 'excluded-historical-file' });
    }
  }
}
console.log(JSON.stringify({ files_checked: paths.length, staged_files_checked: staged.length,
  git_blobs_checked: blobs, git_metadata_checked: metadata, git_trees_checked: trees,
  known_secret_comparison_enabled: known.length > 0,
  findings: [...new Map(findings.map(f => [JSON.stringify(f),f])).values()],
  limitations: 'Pattern and exact-known-secret checks cannot detect all credentials or private prose; manually review the file inventory. Includes unreachable objects and checkpoint refs locally; push only the intended branch.' }, null, 2));
if (findings.length) process.exitCode = 1;
