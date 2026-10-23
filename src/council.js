import { randomUUID, createHash } from 'node:crypto';
import { briefingSchema, storedBriefingSchema, consultationSchema } from './schemas.js';
import { Store } from './store.js';
import { callProvider } from './providers.js';
import { REVIEW_INSTRUCTIONS, SYNTHESIS_INSTRUCTIONS } from './prompts.js';
import { ImageStore, visionSupport } from './images.js';
import { selectProfile } from './config.js';
import { estimateCost } from './pricing.js';

const timestamp = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');

export class Council {
  constructor(config, { fetchImpl = fetch, store = new Store(config.dataDir) } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.store = store;
    this.images = new ImageStore(config.dataDir);
    this.jobs = new Map();
  }

  async prepare(input) {
    let briefing = briefingSchema.parse(input);
    if (briefing.images) briefing.images = await this.images.snapshot(briefing.images);
    briefing = storedBriefingSchema.parse(briefing);
    const payload = JSON.stringify(briefing, null, 2);
    if (payload.length > this.config.maxBriefingChars) {
      throw new Error(`Briefing exceeds ${this.config.maxBriefingChars} characters; select narrower evidence. Nothing was truncated.`);
    }
    const record = { id: randomUUID(), created_at: timestamp(), sha256: digest(payload), briefing };
    const file = await this.store.save('briefings', record);
    return { briefing_id: record.id, sha256: record.sha256, characters: payload.length, file,
      briefing, note: 'Saved locally. No provider has been contacted.' };
  }

  async consult(input) {
    const args = consultationSchema.parse(input);
    const config = selectProfile(this.config, args.profile);
    const briefing = await this.store.get('briefings', args.briefing_id);
    const payload = JSON.stringify(storedBriefingSchema.parse(briefing.briefing), null, 2);
    if (digest(payload) !== briefing.sha256) throw new Error('Briefing integrity check failed; prepare it again');
    if (payload.length > this.config.maxBriefingChars) throw new Error('Briefing exceeds current configured limit');
    const requested = [...new Set([...args.providers, ...(args.synthesizer ? [args.synthesizer] : [])])];
    const missing = requested.filter(name => !config.providers[name].key || !config.providers[name].model);
    // Load and verify the prepared copies before any request, including a paid synthesis.
    const images = await this.images.load(briefing.briefing.images);
    const unsupported = images.length ? requested.filter(name => !visionSupport(name, config.providers[name]).supported) : [];
    const plan = {
      profile: config.profile, profile_label: config.label,
      briefing_id: briefing.id, briefing_sha256: briefing.sha256,
      members: args.providers.map(name => ({ provider: name, model: config.providers[name].model || null })),
      synthesizer: args.synthesizer, max_calls: args.providers.length + (args.synthesizer ? 1 : 0),
      synthesizer_model: args.synthesizer ? config.providers[args.synthesizer].model : null,
      max_output_tokens_per_call: config.maxOutputTokens, timeout_ms: config.timeoutMs,
      cost_estimate: estimateCost(config, args.providers, args.synthesizer, payload, REVIEW_INSTRUCTIONS, SYNTHESIS_INSTRUCTIONS, images.length),
      model_notes: requested.filter(name => config.providers[name].model.includes('preview')).map(name => `${name}: ${config.providers[name].model} is a preview model; availability and behavior may change.`),
      missing_configuration: missing,
      images: (briefing.briefing.images || []).map(image => ({ ...image, snapshot_path: this.images.file(image) })),
      image_count: images.length, image_bytes: images.reduce((sum, image) => sum + image.bytes, 0),
      unsupported_image_providers: unsupported,
    };
    if (args.dry_run) return { dry_run: true, ...plan, instructions: REVIEW_INSTRUCTIONS,
      shared_input: payload, synthesis_instructions: args.synthesizer ? SYNTHESIS_INSTRUCTIONS : null,
      disclosure: 'A live call sends this briefing and the listed image bytes to every selected member. The synthesizer, if selected, receives the same images and all member responses. Records and image snapshots are stored locally. Base64 is omitted from this preview.' };
    if (missing.length) throw new Error(`Configure API key and model for: ${missing.join(', ')}. No requests were sent.`);
    if (unsupported.length) throw new Error(`Image input is unverified or disabled for: ${unsupported.join(', ')} in profile ${config.profile}. Select confirmed vision models or set COUNCIL_${config.profile.toUpperCase()}_<PROVIDER>_VISION=true only after verifying support. No requests were sent; images were not dropped.`);
    if (this.jobs.size >= 2) throw new Error('Two consultations are already active; retrieve their results before starting another');
    const record = { id: randomUUID(), created_at: timestamp(), status: 'running', phase: 'reviews',
      prompt_version: '2', review_instructions: REVIEW_INSTRUCTIONS,
      synthesis_instructions: args.synthesizer ? SYNTHESIS_INSTRUCTIONS : null,
      ...plan, briefing: briefing.briefing, reviews: [], synthesis: null };
    // Reserve a slot before the asynchronous save so concurrent tool calls obey the limit.
    this.jobs.set(record.id, null);
    try { await this.store.save('consultations', record); }
    catch (error) { this.jobs.delete(record.id); throw error; }
    const job = this.run(record, payload, images, config).catch(async () => {
      record.status = 'failed'; record.error = 'internal_or_storage_error'; record.completed_at = timestamp();
      try { await this.store.save('consultations', record); } catch { /* get() reports interrupted if persistence fails */ }
    }).finally(() => this.jobs.delete(record.id));
    this.jobs.set(record.id, job);
    return { consultation_id: record.id, status: 'running', ...plan,
      next: 'Call get_consultation with this ID. Do not submit again to poll.' };
  }

  async run(record, payload, images, config) {
    // Persist each finished response. Serialize writes so a slower write cannot replace
    // a newer snapshot, and await all workers even if local storage encounters an error.
    let saves = Promise.resolve();
    let storageError;
    await Promise.all(record.members.map(async ({ provider }) => {
      const review = await callProvider(provider, config, REVIEW_INSTRUCTIONS, payload, this.fetchImpl, images);
      record.reviews.push(review);
      saves = saves.then(() => this.store.save('consultations', record)).catch(error => { storageError = error; });
      await saves;
    }));
    if (storageError) throw storageError;
    record.reviews.sort((a, b) => record.members.findIndex(member => member.provider === a.provider)
      - record.members.findIndex(member => member.provider === b.provider));
    const successful = record.reviews.filter(review => review.status === 'ok');
    record.phase = 'synthesis';
    await this.store.save('consultations', record);
    if (record.synthesizer && successful.length >= 2) {
      const input = JSON.stringify({ briefing: record.briefing, reviews: record.reviews });
      record.synthesis = await callProvider(record.synthesizer, config, SYNTHESIS_INSTRUCTIONS, input, this.fetchImpl, images);
    } else if (record.synthesizer) {
      record.synthesis = { status: 'skipped', reason: 'Fewer than two successful reviews' };
    }
    record.status = successful.length === 0 ? 'failed'
      : successful.length !== record.members.length || successful.some(review => review.truncated)
        || (record.synthesizer && (record.synthesis?.status !== 'ok' || record.synthesis.truncated)) ? 'partial' : 'complete';
    record.phase = 'done';
    record.completed_at = timestamp();
    await this.store.save('consultations', record);
  }

  async get(id) {
    const record = await this.store.get('consultations', id);
    if (record.status === 'running' && !this.jobs.has(id)) {
      return { ...record, status: 'interrupted', note: 'The server stopped before completion. Saved results are retained. Nothing is automatically retried; a new consultation may incur new charges.' };
    }
    return { ...record, file: this.store.file('consultations', id) };
  }

  async list(limit = 20) {
    const records = await this.store.list('consultations', limit);
    return records.map(record => ({ consultation_id: record.id, project: record.briefing.project,
      profile: record.profile || 'legacy',
      question: record.briefing.question, created_at: record.created_at,
      status: record.status === 'running' && !this.jobs.has(record.id) ? 'interrupted' : record.status }));
  }
}
