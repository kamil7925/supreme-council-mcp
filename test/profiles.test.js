import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig, publicConfig, DEEP_MODELS } from '../src/config.js';
import { Council } from '../src/council.js';
import { sampleBriefing, testConfig, mockFetch, providerFromUrl } from './fixtures.js';

async function setup(t, fetchImpl = mockFetch) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'council-profiles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = testConfig(dir);
  return { dir, config, council: new Council(config, { fetchImpl }) };
}

test('legacy quick settings persist, explicit overrides win, deep remains independent, and status is secret-free', () => {
  const config = readConfig({ OPENAI_API_KEY: 'secret-fixture', COUNCIL_OPENAI_MODEL: 'old-quick',
    COUNCIL_QUICK_OPENAI_MODEL: 'explicit-quick', COUNCIL_OPENAI_VISION: 'false',
    COUNCIL_MAX_OUTPUT_TOKENS: '512', COUNCIL_TIMEOUT_MS: '1500', COUNCIL_DEFAULT_PROFILE: 'deep' });
  assert.equal(config.profiles.quick.providers.openai.model, 'explicit-quick');
  assert.equal(config.profiles.quick.maxOutputTokens, 512);
  assert.equal(config.profiles.deep.maxOutputTokens, 16384);
  assert.equal(config.profiles.deep.providers.openai.model, DEEP_MODELS.openai);
  assert.equal(config.profiles.deep.providers.openai.vision, 'auto');
  const status = publicConfig(config);
  assert.equal(status.default_profile, 'deep');
  assert.equal(status.providers.openai.model, DEEP_MODELS.openai);
  assert.ok(!JSON.stringify(status).includes('secret-fixture'));
  assert.throws(() => readConfig({ COUNCIL_DEFAULT_PROFILE: 'expensive' }), /quick or deep/);
  assert.throws(() => readConfig({ COUNCIL_DEEP_TIMEOUT_MS: '0' }), /integer/);
  assert.throws(() => readConfig({ COUNCIL_DEEP_OPENAI_VISION: 'yes' }), /auto, true, or false/);
  assert.equal(readConfig({ COUNCIL_DEEP_OPENAI_MODEL: '' }).profiles.deep.providers.openai.model, '');
});

test('profile previews reuse the same briefing, show costs and exact synthesizer, and make no API requests', async t => {
  let calls = 0;
  const { council, config } = await setup(t, async url => { calls++; return mockFetch(url); });
  config.profiles.quick.providers.openai.model = 'gpt-4.1-mini';
  const saved = await council.prepare(sampleBriefing);
  const quick = await council.consult({ briefing_id: saved.briefing_id, providers: ['openai'] });
  const deep = await council.consult({ briefing_id: saved.briefing_id, profile: 'deep', synthesizer: 'claude' });
  assert.equal(quick.profile, 'quick');
  assert.equal(deep.profile, 'deep');
  assert.equal(deep.shared_input, quick.shared_input);
  assert.equal(deep.briefing_sha256, quick.briefing_sha256);
  assert.equal(deep.synthesizer_model, 'claude-opus-5');
  assert.equal(deep.cost_estimate.calls.length, 5);
  assert.ok(deep.cost_estimate.estimated_total_usd > quick.cost_estimate.estimated_total_usd);
  const withoutSynthesis = await council.consult({ briefing_id: saved.briefing_id, profile: 'deep' });
  assert.ok(deep.cost_estimate.estimated_total_usd > withoutSynthesis.cost_estimate.estimated_total_usd);
  assert.ok(deep.model_notes.some(note => note.includes('preview')));
  config.defaultProfile = 'deep';
  assert.equal((await council.consult({ briefing_id: saved.briefing_id })).profile, 'deep');
  await assert.rejects(council.consult({ briefing_id: saved.briefing_id, profile: 'typo', dry_run: false }));
  assert.equal(calls, 0);
});

test('concurrent quick/deep jobs snapshot models and budgets through paid synthesis and preserve audit records', async t => {
  const requests = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { council, config } = await setup(t, async (url, options) => {
    requests.push({ provider: providerFromUrl(url), body: JSON.parse(options.body) });
    await barrier;
    return mockFetch(url);
  });
  const saved = await council.prepare(sampleBriefing);
  const starts = await Promise.all(['quick', 'deep'].map(profile => council.consult({ briefing_id: saved.briefing_id,
    profile, dry_run: false, synthesizer: 'claude' })));
  try {
    assert.equal(requests.length, 8);
    config.profiles.deep.providers.claude.model = 'mutated-after-submission';
    config.profiles.quick.providers.claude.model = 'mutated-quick';
    config.profiles.deep.maxOutputTokens = 256;
  } finally { release(); }
  await Promise.all(starts.map(start => council.jobs.get(start.consultation_id)));
  assert.equal(requests.length, 10);
  for (const start of starts) {
    const record = await council.get(start.consultation_id);
    assert.equal(record.status, 'complete');
    assert.equal(record.profile, start.profile);
    const expected = start.profile === 'deep' ? 'claude-opus-5' : 'test-claude';
    assert.equal(record.synthesis.model, expected);
    const matching = requests.filter(item => item.body.model === expected);
    assert.equal(matching.length, 2);
    for (const request of matching) assert.equal(request.body.max_tokens, start.profile === 'deep' ? 16384 : 4096);
    assert.ok(!JSON.stringify(record).includes('fixture-key'));
  }
  const restarted = new Council(config);
  assert.deepEqual(new Set((await restarted.list()).map(record => record.profile)), new Set(['quick', 'deep']));
});

test('missing deep model blocks requests; runtime unavailability stays a failure without quick fallback', async t => {
  const requests = [];
  const { council, config } = await setup(t, async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(providerFromUrl(url) === 'gemini' ? decodeURIComponent(url.split('/models/')[1].split(':')[0]) : body.model);
    return providerFromUrl(url) === 'claude' ? new Response('', { status: 404 }) : mockFetch(url);
  });
  const saved = await council.prepare(sampleBriefing);
  config.profiles.deep.providers.claude.model = '';
  await assert.rejects(council.consult({ briefing_id: saved.briefing_id, profile: 'deep', dry_run: false }), /claude/);
  assert.equal(requests.length, 0);
  config.profiles.deep.providers.claude.model = 'claude-opus-5';
  const start = await council.consult({ briefing_id: saved.briefing_id, profile: 'deep', dry_run: false });
  await council.jobs.get(start.consultation_id);
  const result = await council.get(start.consultation_id);
  assert.equal(result.status, 'partial');
  assert.equal(result.reviews.find(review => review.provider === 'claude').error, 'http_404');
  assert.equal(requests.length, 4);
  assert.deepEqual(new Set(requests), new Set(['openai', 'claude', 'gemini', 'mistral'].map(name => DEEP_MODELS[name])));
});

test('images reach deep models; image and unknown-model estimates never masquerade as a total', async t => {
  const requests = [];
  const { dir, council, config } = await setup(t, async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ provider: providerFromUrl(url), model: providerFromUrl(url) === 'gemini'
      ? decodeURIComponent(url.split('/models/')[1].split(':')[0]) : body.model }); return mockFetch(url);
  });
  const imagePath = path.join(dir, 'view.png');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
  const saved = await council.prepare({ ...sampleBriefing, images: [{ id: 'front', title: 'Front', path: imagePath }] });
  const preview = await council.consult({ briefing_id: saved.briefing_id, profile: 'deep' });
  assert.deepEqual(preview.unsupported_image_providers, []);
  assert.equal(preview.cost_estimate.estimated_total_usd, null);
  assert.equal(preview.cost_estimate.image_input_included, false);
  const start = await council.consult({ briefing_id: saved.briefing_id, profile: 'deep', dry_run: false });
  await council.jobs.get(start.consultation_id);
  const result = await council.get(start.consultation_id);
  assert.equal(result.status, 'complete');
  for (const review of result.reviews) assert.equal(review.images_attached.length, 1);
  for (const { provider, model } of requests) assert.equal(model, DEEP_MODELS[provider]);
  config.profiles.deep.providers.openai.model = 'unknown-new-model';
  const text = await council.prepare(sampleBriefing);
  const unknown = await council.consult({ briefing_id: text.briefing_id, profile: 'deep' });
  assert.equal(unknown.cost_estimate.all_models_priced, false);
  assert.equal(unknown.cost_estimate.estimated_total_usd, null);
  assert.equal(unknown.cost_estimate.calls[0].text_input_plus_output_allowance_usd, null);
});
