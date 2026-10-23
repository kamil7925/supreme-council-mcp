// Self-contained application example. No provider calls unless --live is explicit.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { consultationSchema } from '../src/schemas.js';

const live = process.argv.includes('--live');
const profileIndex = process.argv.indexOf('--profile');
const providersIndex = process.argv.indexOf('--providers');
const profile = profileIndex < 0 ? 'quick' : process.argv[profileIndex + 1];
const providers = providersIndex < 0 ? ['openai'] : (process.argv[providersIndex + 1] || '').split(',');
// Validate flags before starting a child or writing records.
consultationSchema.parse({ briefing_id: '00000000-0000-4000-8000-000000000000', profile, providers });
const client = new Client({ name: 'council-application-example', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(ROOT, 'src/server.js')],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
  stderr: 'pipe' });
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
try {
  await client.connect(transport);
  const saved = await call('prepare_briefing', {
    project: 'Synthetic application example',
    question: 'Is this proposed release ready?',
    summary: 'Illustrative evidence only: unit tests passed, deployment recovery is untested.',
    sources: [{ id: 'example', title: 'Synthetic release note', kind: 'note',
      reference: 'scripts/example-client.js (synthetic)', observed_at: new Date().toISOString(),
      content: 'Unit tests passed. A deployment recovery drill has not been performed.' }],
  });
  const args = { briefing_id: saved.briefing_id, profile, providers, synthesizer: null };
  const plan = await call('consult_council', { ...args, dry_run: true });
  console.log(JSON.stringify(plan, null, 2));
  if (live) {
    const started = await call('consult_council', { ...args, dry_run: false });
    console.log(JSON.stringify({ consultation_id: started.consultation_id }));
    let result;
    do {
      await delay(2000);
      result = await call('get_consultation', { consultation_id: started.consultation_id });
    } while (result.status === 'running');
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'complete') process.exitCode = 1;
  }
} finally { await client.close(); }
