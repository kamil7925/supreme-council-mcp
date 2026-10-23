import { readConfig } from '../src/config.js';

export const sampleBriefing = {
  project: 'the143rd — illustrative fixture',
  question: 'Is this Blender-to-Unreal pipeline ready for a larger scene?',
  clarified_question: 'Assess readiness based only on the supplied illustrative evidence. Identify missing validation.',
  summary: 'Synthetic example, not an inspection of the real project. Export works for one small scene; scaling is unverified.',
  assumptions: ['A larger scene will contain more assets than the existing test.'],
  missing_context: ['No measured performance or failure-recovery results.'],
  sources: [{ id: 'fixture', title: 'Synthetic pipeline note', kind: 'note',
    reference: 'test fixture; not real project evidence', observed_at: '2026-09-18T00:00:00Z',
    content: 'A small scene export was successful. Larger scenes have not been tested.' }],
};

export function testConfig(directory) {
  return readConfig({ COUNCIL_DATA_DIR: directory, COUNCIL_TIMEOUT_MS: '1000',
    ...Object.fromEntries(['OPENAI', 'CLAUDE', 'GEMINI', 'MISTRAL'].map(name => [`COUNCIL_${name}_MODEL`, `test-${name.toLowerCase()}`])),
    OPENAI_API_KEY: 'fixture-key', ANTHROPIC_API_KEY: 'fixture-key', GEMINI_API_KEY: 'fixture-key', MISTRAL_API_KEY: 'fixture-key' });
}

export function responseBody(name, text = 'Synthetic review: validate larger scenes before proceeding. [fixture]') {
  if (name === 'openai' || name === 'meta') return { status: 'completed', model: `test-${name}`, usage: { input_tokens: 10, output_tokens: 20 },
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text }] }] };
  if (name === 'claude') return { model: 'test-claude', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 } };
  if (name === 'gemini') return { modelVersion: 'test-gemini', candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } };
  return { model: 'test-mistral', choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } };
}

export function providerFromUrl(url) {
  if (url.includes('api.meta.ai')) return 'meta';
  if (url.includes('openai.com')) return 'openai';
  if (url.includes('anthropic.com')) return 'claude';
  if (url.includes('googleapis.com')) return 'gemini';
  return 'mistral';
}

export async function mockFetch(url) { return Response.json(responseBody(providerFromUrl(url))); }
