import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Council } from '../src/council.js';
import { callProvider, makeRequest, parseResponse } from '../src/providers.js';
import { readConfig, publicConfig, PROVIDERS } from '../src/config.js';
import { sampleBriefing, testConfig, mockFetch, responseBody, providerFromUrl } from './fixtures.js';

async function setup(t, fetchImpl = mockFetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'council-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = testConfig(directory);
  return { config, council: new Council(config, { fetchImpl }) };
}

test('dry run preserves original evidence, hash, and makes no network calls', async t => {
  let calls = 0;
  const { council } = await setup(t, async () => { calls++; throw new Error('unexpected network'); });
  const prepared = await council.prepare(sampleBriefing);
  const plan = await council.consult({ briefing_id: prepared.briefing_id, synthesizer: 'openai' });
  assert.equal(plan.max_calls, 5);
  assert.equal(plan.briefing_sha256, prepared.sha256);
  assert.deepEqual(JSON.parse(plan.shared_input), sampleBriefing);
  assert.equal(calls, 0);
  assert.deepEqual(await council.list(), []);
});

test('reviews start concurrently with identical input, synthesis runs afterward, and records survive restart', async t => {
  const requests = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { council, config } = await setup(t, async (url, options) => {
    requests.push({ name: providerFromUrl(url), body: JSON.parse(options.body) });
    if (requests.length === 4) release();
    await barrier;
    return mockFetch(url);
  });
  const prepared = await council.prepare(sampleBriefing);
  const started = await council.consult({ briefing_id: prepared.briefing_id, dry_run: false, synthesizer: 'openai' });
  await council.jobs.get(started.consultation_id);
  const record = await council.get(started.consultation_id);
  assert.equal(record.status, 'complete');
  assert.equal(record.reviews.length, 4);
  assert.equal(record.synthesis.status, 'ok');
  assert.equal(requests.length, 5);
  const inputs = requests.slice(0, 4).map(({ name, body }) => name === 'openai' ? body.input
    : name === 'gemini' ? body.contents[0].parts[0].text : body.messages.at(-1).content);
  assert.equal(new Set(inputs).size, 1);
  assert.equal(JSON.parse(requests[4].body.input).reviews.length, 4);
  const restarted = new Council(config);
  assert.equal((await restarted.get(record.id)).status, 'complete');
  assert.equal((await restarted.list())[0].consultation_id, record.id);
});

test('missing configuration fails before any paid request', async t => {
  let calls = 0;
  const { council, config } = await setup(t, async () => { calls++; return mockFetch('openai.com'); });
  config.providers.claude.key = '';
  const prepared = await council.prepare(sampleBriefing);
  await assert.rejects(council.consult({ briefing_id: prepared.briefing_id, dry_run: false }), /claude/);
  assert.equal(calls, 0);
});

test('provider failure preserves other opinions and does not expose the error body', async t => {
  const { council } = await setup(t, async url => providerFromUrl(url) === 'claude'
    ? new Response('secret fixture-key sensitive prompt', { status: 429 }) : mockFetch(url));
  const prepared = await council.prepare(sampleBriefing);
  const started = await council.consult({ briefing_id: prepared.briefing_id, dry_run: false });
  await council.jobs.get(started.consultation_id);
  const record = await council.get(started.consultation_id);
  assert.equal(record.status, 'partial');
  assert.equal(record.reviews.filter(review => review.status === 'ok').length, 3);
  assert.equal(record.reviews.find(review => review.provider === 'claude').error, 'http_429');
  assert.ok(!JSON.stringify(record).includes('fixture-key'));
});

test('finished members are saved while another member is still running', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { council } = await setup(t, async url => {
    if (providerFromUrl(url) === 'claude') await barrier;
    return mockFetch(url);
  });
  const prepared = await council.prepare(sampleBriefing);
  const started = await council.consult({ briefing_id: prepared.briefing_id, dry_run: false });
  try {
    let record;
    for (let attempt = 0; attempt < 100; attempt++) {
      record = await council.get(started.consultation_id);
      if (record.reviews.length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(record.status, 'running');
    assert.equal(record.reviews.length, 3);
  } finally {
    release();
    await council.jobs.get(started.consultation_id);
  }
});

test('simultaneous submissions enforce the two-job limit before making excess requests', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const { council } = await setup(t, async url => { requests++; await barrier; return mockFetch(url); });
  const prepared = await council.prepare(sampleBriefing);
  const submitted = await Promise.allSettled(Array.from({ length: 3 }, () => council.consult({
    briefing_id: prepared.briefing_id, providers: ['openai'], dry_run: false,
  })));
  try {
    assert.equal(submitted.filter(item => item.status === 'fulfilled').length, 2);
    assert.equal(submitted.filter(item => item.status === 'rejected').length, 1);
    assert.equal(requests, 2);
  } finally {
    release();
    await Promise.all([...council.jobs.values()]);
  }
});

test('failed council skips synthesis instead of inventing consensus', async t => {
  let calls = 0;
  const { council } = await setup(t, async () => { calls++; return new Response('', { status: 503 }); });
  const prepared = await council.prepare(sampleBriefing);
  const started = await council.consult({ briefing_id: prepared.briefing_id, dry_run: false, synthesizer: 'mistral' });
  await council.jobs.get(started.consultation_id);
  const record = await council.get(started.consultation_id);
  assert.equal(record.status, 'failed');
  assert.equal(record.synthesis.status, 'skipped');
  assert.equal(calls, 4);
});

test('synthesis failure keeps independent reviews', async t => {
  let calls = 0;
  const { council } = await setup(t, async url => ++calls === 5 ? new Response('', { status: 500 }) : mockFetch(url));
  const prepared = await council.prepare(sampleBriefing);
  const started = await council.consult({ briefing_id: prepared.briefing_id, dry_run: false, synthesizer: 'openai' });
  await council.jobs.get(started.consultation_id);
  const record = await council.get(started.consultation_id);
  assert.equal(record.status, 'partial');
  assert.equal(record.reviews.filter(review => review.status === 'ok').length, 4);
  assert.equal(record.synthesis.status, 'error');
});

test('validation prevents duplicate members, ambiguous sources, oversized briefs, tampering, and path traversal', async t => {
  const { council, config } = await setup(t);
  await assert.rejects(council.prepare({ ...sampleBriefing, sources: [...sampleBriefing.sources, ...sampleBriefing.sources] }), /unique/);
  const prepared = await council.prepare(sampleBriefing);
  await assert.rejects(council.consult({ briefing_id: prepared.briefing_id, providers: ['openai', 'openai'] }), /unique/);
  await assert.rejects(council.get('../../.env'));
  const record = await council.store.get('briefings', prepared.briefing_id);
  record.briefing.question = 'Tampered';
  await council.store.save('briefings', record);
  await assert.rejects(council.consult({ briefing_id: prepared.briefing_id }), /integrity/);
  config.maxBriefingChars = 10;
  await assert.rejects(council.prepare(sampleBriefing), /Nothing was truncated/);
});

test('interrupted records are reported without resubmitting', async t => {
  const { council } = await setup(t);
  const id = 'b2ff1d6e-5fd0-4d7e-9e0f-1046d6978fc1';
  await council.store.save('consultations', { id, status: 'running', created_at: new Date().toISOString(), briefing: sampleBriefing });
  assert.equal((await council.get(id)).status, 'interrupted');
});

test('adapter deadlines cover stalled requests and bodies', async t => {
  const { config } = await setup(t);
  config.timeoutMs = 20;
  const result = await callProvider('openai', config, 'system', 'user', () => new Promise(() => {}));
  assert.equal(result.error, 'timeout');
  const body = await callProvider('claude', config, 'system', 'user', async () => ({ ok: true, json: () => new Promise(() => {}) }));
  assert.equal(body.error, 'timeout');
});

test('rate-limit diagnostics retain numeric limits without leaking arbitrary headers', async t => {
  const { config } = await setup(t);
  const result = await callProvider('mistral', config, 'system', 'user', async () => new Response('sensitive body', {
    status: 429, headers: { 'x-ratelimit-limit-req-minute': '0', 'retry-after': '60',
      'x-ratelimit-reset-sensitive': 'fixture-key', 'authorization': 'fixture-key' },
  }));
  assert.equal(result.error, 'http_429');
  assert.deepEqual(result.limits, { 'retry-after': '60', 'x-ratelimit-limit-req-minute': '0' });
  assert.ok(!JSON.stringify(result).includes('fixture-key'));
  assert.ok(!JSON.stringify(result).includes('sensitive body'));
});

test('provider wire formats, auth, usage, and truncation are normalized', () => {
  const config = testConfig('.');
  for (const name of PROVIDERS) {
    const request = makeRequest(name, config, 'system', 'user');
    assert.ok(request.url.startsWith('https://'));
    assert.ok(!request.url.includes('fixture-key'));
    const parsed = parseResponse(name, responseBody(name));
    assert.ok(parsed.text.includes('[fixture]'));
    assert.ok(parsed.usage);
    assert.equal(parsed.truncated, false);
    assert.throws(() => parseResponse(name, {}), /empty_response/);
  }
  assert.equal(makeRequest('openai', config, '', '').body.store, false);
  assert.equal(makeRequest('claude', config, '', '').headers['anthropic-version'], '2023-06-01');
  assert.equal(makeRequest('gemini', config, '', '').headers['x-goog-api-key'], 'fixture-key');
  assert.equal(parseResponse('openai', { ...responseBody('openai'), status: 'incomplete' }).truncated, true);
  const gemini = responseBody('gemini');
  gemini.candidates[0].content.parts.unshift({ thought: true, text: 'private reasoning' });
  assert.ok(!parseResponse('gemini', gemini).text.includes('private reasoning'));
  assert.ok(!JSON.stringify(publicConfig(config)).includes('fixture-key'));
  assert.throws(() => readConfig({ COUNCIL_TIMEOUT_MS: '-1' }), /integer/);
});
