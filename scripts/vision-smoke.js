// Uses the actual MCP transport. Defaults to a local preview; --live calls selected members.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, loadEnv, readConfig, PROFILES, DEFAULT_PROVIDERS } from '../src/config.js';
import { consultationSchema } from '../src/schemas.js';

const file = process.argv[2];
if (!file || file.startsWith('--') || !path.isAbsolute(file)) {
  throw new Error('Usage: node scripts/vision-smoke.js <absolute PNG/JPEG path> [--profile quick|deep] [--providers meta,openai,claude] [--live]');
}
const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex === -1 ? 'quick' : process.argv[profileIndex + 1];
if (!PROFILES.includes(profile)) throw new Error('--profile must be quick or deep');
const providersIndex = process.argv.indexOf('--providers');
const providers = providersIndex === -1 ? DEFAULT_PROVIDERS : (process.argv[providersIndex + 1] || '').split(',');
consultationSchema.parse({ briefing_id: '00000000-0000-4000-8000-000000000000', providers });
loadEnv();
const config = readConfig();
const client = new Client({ name: 'council-vision-smoke', version: '0.4.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src/server.js')],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
    COUNCIL_QUICK_MAX_OUTPUT_TOKENS: '384', COUNCIL_DEEP_MAX_OUTPUT_TOKENS: '4096' }, stderr: 'pipe' });
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content[0].text);
  return JSON.parse(response.content[0].text);
};
try {
  await client.connect(transport);
  const saved = await call('prepare_briefing', {
    project: 'Supreme Council visual transport smoke test',
    question: 'Describe the visible shapes, colors, and relative positions in the attached image.',
    clarified_question: 'In at most 60 words, describe the shapes, colors, and relative positions visible in the attached image. Base the answer solely on actual pixels. If no image is available, say so. Do not add other review sections.',
    summary: 'A synthetic test image for checking actual image delivery, not a project asset review.',
    sources: [{ id: 'test_context', title: 'Test purpose', kind: 'note', reference: 'scripts/vision-smoke.js',
      observed_at: new Date().toISOString(), content: 'This checks image attachment delivery. The expected visual answer is intentionally not provided in text.' }],
    images: [{ id: 'test_image', title: 'Test image', path: file }],
  });
  const plan = await call('consult_council', { briefing_id: saved.briefing_id, profile, providers, dry_run: true });
  console.log(JSON.stringify({ briefing_id: saved.briefing_id, profile: plan.profile, members: plan.members, cost_estimate: plan.cost_estimate,
    image_count: plan.image_count, image_bytes: plan.image_bytes,
    unsupported_image_providers: plan.unsupported_image_providers, missing_configuration: plan.missing_configuration, dry_run: true }));
  if (process.argv.includes('--live')) {
    const started = await call('consult_council', { briefing_id: saved.briefing_id, profile, providers, dry_run: false });
    console.log(JSON.stringify({ consultation_id: started.consultation_id }));
    await writeFile(path.join(config.dataDir, 'vision-smoke-last-id.json'), JSON.stringify({ consultation_id: started.consultation_id }));
    let result;
    do {
      await delay(2000);
      result = await call('get_consultation', { consultation_id: started.consultation_id });
    } while (result.status === 'running');
    console.log(JSON.stringify({ status: result.status, file: result.file, reviews: result.reviews }));
    if (result.status !== 'complete') process.exitCode = 1;
  }
} finally { await client.close(); }
