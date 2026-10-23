import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig, selectProfile, publicConfig, PROVIDERS, DEFAULT_PROVIDERS } from '../src/config.js';
import { Council } from '../src/council.js';
import { callProvider, makeRequest, parseResponse } from '../src/providers.js';
import { sampleBriefing, testConfig, mockFetch, responseBody } from './fixtures.js';

test('Meta is standard tier in both profiles, optional by default, and secrets stay private', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'council-meta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = readConfig({ COUNCIL_DATA_DIR: dir });
  const council = new Council(config, { fetchImpl: () => assert.fail('Must not contact providers') });
  const saved = await council.prepare(sampleBriefing);
  assert.deepEqual((await council.consult({ briefing_id: saved.briefing_id })).members.map(m => m.provider), DEFAULT_PROVIDERS);
  for (const profile of ['quick', 'deep']) {
    const plan = await council.consult({ briefing_id: saved.briefing_id, profile, providers: ['meta'] });
    assert.equal(plan.members[0].model, 'muse-spark-1.3');
    assert.deepEqual(plan.missing_configuration, ['meta']);
    assert.equal(plan.cost_estimate.calls[0].input_usd_per_million, 1.25);
    assert.equal(plan.cost_estimate.calls[0].output_usd_per_million, 4.25);
    await assert.rejects(council.consult({ briefing_id: saved.briefing_id, profile, providers: ['meta'], dry_run: false }), /meta/);
  }
  const keyed = readConfig({ META_API_KEY: 'meta-fixture-key' });
  assert.equal(publicConfig(keyed).profiles.deep.providers.meta.configured, true);
  assert.ok(!JSON.stringify(publicConfig(keyed)).includes('meta-fixture-key'));
  assert.equal(readConfig({ COUNCIL_DEEP_META_MODEL: '' }).profiles.deep.providers.meta.model, '');
});

test('five-member image reviews and Meta synthesis preserve evidence, auth and model identity', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'council-meta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = testConfig(dir);
  config.profiles.deep.providers.meta.key = 'meta-fixture-key';
  const requests = [];
  const council = new Council(config, { fetchImpl: async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return mockFetch(url);
  } });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const file = path.join(dir, 'front.png');
  await writeFile(file, png);
  const saved = await council.prepare({ ...sampleBriefing, images: [{ id: 'front', title: 'Front view', path: file }] });
  const args = { briefing_id: saved.briefing_id, profile: 'deep', providers: PROVIDERS, synthesizer: 'meta' };
  const preview = await council.consult(args);
  assert.equal(preview.max_calls, 6);
  assert.deepEqual(preview.missing_configuration, []);
  assert.deepEqual(preview.unsupported_image_providers, []);
  assert.equal(preview.cost_estimate.estimated_total_usd, null);
  const start = await council.consult({ ...args, dry_run: false });
  await council.jobs.get(start.consultation_id);
  const result = await council.get(start.consultation_id);
  assert.equal(result.status, 'complete');
  assert.equal(result.reviews.length, 5);
  assert.equal(result.synthesis.model, 'muse-spark-1.3');
  const meta = requests.filter(r => r.url === 'https://api.meta.ai/v1/responses');
  assert.equal(meta.length, 2);
  for (const request of meta) {
    assert.equal(request.headers.Authorization, 'Bearer meta-fixture-key');
    assert.equal(request.body.model, 'muse-spark-1.3');
    assert.equal(request.body.store, false);
    assert.equal(request.body.max_output_tokens, 16384);
    assert.equal(request.body.input[0].content[0].text, 'Attached image [front]: Front view');
    assert.equal(request.body.input[0].content[1].image_url, `data:image/png;base64,${png.toString('base64')}`);
  }
  assert.deepEqual(JSON.parse(meta[0].body.input[0].content.at(-1).text), saved.briefing);
  assert.equal(JSON.parse(meta[1].body.input[0].content.at(-1).text).reviews.length, 5);
  assert.deepEqual(result.reviews.at(-1).images_attached, [{ id: 'front', sha256: saved.briefing.images[0].sha256 }]);
  assert.ok(!JSON.stringify(result).includes('meta-fixture-key'));
});

test('Meta parses usage and truncation, keeps reasoning private, and never retries or substitutes a model', async () => {
  const config = selectProfile(readConfig({ META_API_KEY: 'meta-fixture-key' }), 'deep');
  const request = makeRequest('meta', config, 'system', 'plain text');
  assert.equal(request.body.input, 'plain text');
  const fixture = responseBody('meta');
  fixture.output.unshift({ type: 'reasoning', summary: [{ text: 'private' }], encrypted_content: 'secret' });
  fixture.status = 'incomplete';
  const parsed = parseResponse('meta', fixture);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.usage.output_tokens, 20);
  assert.ok(!parsed.text.includes('private'));
  let calls = 0;
  const error = await callProvider('meta', config, 'system', 'plain text', async () => {
    calls++;
    return new Response('private error body', { status: 429 });
  });
  assert.equal(calls, 1);
  assert.equal(error.error, 'http_429');
  assert.equal(error.model, 'muse-spark-1.3');
  assert.ok(!JSON.stringify(error).includes('private'));
});
