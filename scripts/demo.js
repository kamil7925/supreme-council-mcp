import path from 'node:path';
import { ROOT } from '../src/config.js';
import { Council } from '../src/council.js';
import { sampleBriefing, testConfig, mockFetch } from '../test/fixtures.js';

// Deliberately inject a synthetic transport: this script NEVER uses network credentials.
const council = new Council(testConfig(path.join(ROOT, '.council', 'demo')), { fetchImpl: mockFetch });
const prepared = await council.prepare(sampleBriefing);
const started = await council.consult({ briefing_id: prepared.briefing_id, dry_run: false, synthesizer: 'openai' });
await council.jobs.get(started.consultation_id);
const record = await council.get(started.consultation_id);
console.log(JSON.stringify({ warning: 'SYNTHETIC DEMO: no provider calls, no real project inspection.',
  consultation_id: record.id, status: record.status, members: record.reviews.map(({ provider, status }) => ({ provider, status })), file: record.file }, null, 2));
