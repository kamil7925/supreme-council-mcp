import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Council } from '../src/council.js';
import { ImageStore, IMAGE_LIMITS } from '../src/images.js';
import { publicConfig, readConfig } from '../src/config.js';
import { sampleBriefing, testConfig, mockFetch, providerFromUrl } from './fixtures.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
async function setup(t, fetchImpl = mockFetch) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'council-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = testConfig(dir);
  for (const provider of Object.values(config.providers)) provider.vision = 'true';
  const file = path.join(dir, 'view.png');
  await writeFile(file, png);
  return { dir, file, config, council: new Council(config, { fetchImpl }),
    briefing: { ...sampleBriefing, images: [{ id: 'front', title: 'Front view', path: file }] } };
}
function attached(name, body) {
  if (name === 'openai') return body.input[0].content.filter(p => p.type === 'input_image').map(p => p.image_url.split(',')[1]);
  if (name === 'claude') return body.messages.at(-1).content.filter(p => p.type === 'image').map(p => p.source.data);
  if (name === 'gemini') return body.contents[0].parts.filter(p => p.inlineData).map(p => p.inlineData.data);
  return body.messages.at(-1).content.filter(p => p.type === 'image_url').map(p => p.image_url.split(',')[1]);
}
function promptText(name, body) {
  if (name === 'openai') return body.input[0].content.at(-1).text;
  if (name === 'gemini') return body.contents[0].parts.at(-1).text;
  return body.messages.at(-1).content.at(-1).text;
}

test('screenshots survive source deletion and restart; every provider and synthesizer receives identical bytes', async t => {
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ name: providerFromUrl(url), body: JSON.parse(options.body) }); return mockFetch(url); };
  const { file, council, config, briefing } = await setup(t, fetchImpl);
  const saved = await council.prepare(briefing);
  await unlink(file);
  const restarted = new Council(config, { fetchImpl });
  const preview = await restarted.consult({ briefing_id: saved.briefing_id, synthesizer: 'claude' });
  assert.equal(preview.image_count, 1);
  assert.equal(preview.image_bytes, png.length);
  assert.equal(requests.length, 0);
  assert.ok(!JSON.stringify(preview).includes(png.toString('base64')));
  const start = await restarted.consult({ briefing_id: saved.briefing_id, dry_run: false, synthesizer: 'claude' });
  await restarted.jobs.get(start.consultation_id);
  const result = await restarted.get(start.consultation_id);
  assert.equal(result.status, 'complete');
  assert.equal(requests.length, 5);
  for (const { name, body } of requests) assert.deepEqual(attached(name, body), [png.toString('base64')]);
  assert.equal(new Set(requests.slice(0, 4).map(({ name, body }) => promptText(name, body))).size, 1);
  assert.equal(JSON.parse(promptText(requests[4].name, requests[4].body)).reviews.length, 4);
  for (const review of [...result.reviews, result.synthesis]) {
    assert.deepEqual(review.images_attached, [{ id: 'front', sha256: saved.briefing.images[0].sha256 }]);
  }
  assert.ok(!JSON.stringify(result).includes(png.toString('base64')));
});

test('image order and labels remain aligned in all four wire formats', async t => {
  const requests = [];
  const { council, briefing, file } = await setup(t, async (url, options) => {
    requests.push({ name: providerFromUrl(url), body: JSON.parse(options.body) }); return mockFetch(url);
  });
  briefing.images.push({ id: 'side', title: 'Side view', path: file });
  const saved = await council.prepare(briefing);
  const start = await council.consult({ briefing_id: saved.briefing_id, dry_run: false });
  await council.jobs.get(start.consultation_id);
  for (const { name, body } of requests) {
    assert.equal(attached(name, body).length, 2);
    const content = name === 'openai' ? body.input[0].content : name === 'gemini' ? body.contents[0].parts : body.messages.at(-1).content;
    assert.equal(content[0].text, 'Attached image [front]: Front view');
    assert.equal(content[2].text, 'Attached image [side]: Side view');
  }
});

test('unverified or disabled visual members including the synthesizer stop all calls; explicit subset works', async t => {
  let calls = 0;
  const { council, config, briefing } = await setup(t, async url => { calls++; return mockFetch(url); });
  config.providers.mistral.vision = 'auto';
  const saved = await council.prepare(briefing);
  const preview = await council.consult({ briefing_id: saved.briefing_id });
  assert.deepEqual(preview.unsupported_image_providers, ['mistral']);
  await assert.rejects(council.consult({ briefing_id: saved.briefing_id, dry_run: false }), /No requests were sent/);
  await assert.rejects(council.consult({ briefing_id: saved.briefing_id, providers: ['openai', 'claude'], synthesizer: 'mistral', dry_run: false }), /mistral/);
  assert.equal(calls, 0);
  const start = await council.consult({ briefing_id: saved.briefing_id, providers: ['openai'], dry_run: false });
  await council.jobs.get(start.consultation_id);
  assert.equal(calls, 1);
  config.providers.openai.vision = 'false';
  await assert.rejects(council.consult({ briefing_id: saved.briefing_id, providers: ['openai'], dry_run: false }), /openai/);
});

test('altered or missing stored image fails before any network call', async t => {
  let calls = 0;
  const { council, briefing } = await setup(t, async url => { calls++; return mockFetch(url); });
  const saved = await council.prepare(briefing);
  const snapshot = council.images.file(saved.briefing.images[0]);
  const changed = Buffer.from(png); changed[45] ^= 1;
  await writeFile(snapshot, changed);
  await assert.rejects(council.consult({ briefing_id: saved.briefing_id, dry_run: false }), /integrity/);
  await unlink(snapshot);
  await assert.rejects(council.consult({ briefing_id: saved.briefing_id, dry_run: false }), /ENOENT/);
  assert.equal(calls, 0);
});

test('rejects invalid files, unsafe paths, oversized input, dimensions, and duplicate evidence IDs', async t => {
  const { council, briefing, file, dir } = await setup(t);
  for (const value of ['relative.png', 'https://example.com/img.png', '//server/share.png', '\\\\server\\share.png']) {
    await assert.rejects(council.prepare({ ...briefing, images: [{ ...briefing.images[0], path: value }] }), /absolute local/);
  }
  await assert.rejects(council.prepare({ ...briefing, images: [{ ...briefing.images[0], id: 'fixture' }] }), /unique/);
  await assert.rejects(council.prepare({ ...briefing, images: Array.from({ length: 9 }, (_, n) => ({ ...briefing.images[0], id: `v${n}` })) }), /8/);
  await writeFile(file, 'this is text pretending to be a PNG');
  await assert.rejects(council.prepare(briefing), /PNG or JPEG/);
  await writeFile(file, Buffer.alloc(IMAGE_LIMITS.max_bytes_each + 1));
  await assert.rejects(council.prepare(briefing), /4 MiB/);
  const hugeDimensions = Buffer.from(png); hugeDimensions.writeUInt32BE(8001, 16);
  await writeFile(file, hugeDimensions);
  await assert.rejects(council.prepare(briefing), /8000/);
  const padded = Buffer.concat([png.subarray(0, -12), Buffer.alloc(4 * 1024 * 1024 - png.length), png.subarray(-12)]);
  await writeFile(file, padded);
  await assert.rejects(council.prepare({ ...briefing, images: ['a', 'b', 'c'].map(id => ({ id, title: id, path: file })) }), /10 MiB/);
  await assert.rejects(new ImageStore(dir).snapshot([{ id: 'dir', title: 'dir', path: dir }]), /regular file/);
});

test('status reports capability conservatively and validates explicit overrides', () => {
  const config = readConfig({ COUNCIL_OPENAI_MODEL: 'gpt-4.1-mini', COUNCIL_CLAUDE_MODEL: 'unknown', COUNCIL_MISTRAL_VISION: 'false' });
  const status = publicConfig(config);
  assert.equal(status.image_attachments.supported, true);
  assert.equal(status.providers.openai.vision.supported, true);
  assert.equal(status.providers.claude.vision.supported, false);
  assert.equal(status.providers.mistral.vision.supported, false);
  assert.throws(() => readConfig({ COUNCIL_OPENAI_VISION: 'yes' }), /auto, true, or false/);
});
