// Read-only catalog checks, no generation and no briefing/project content sent.
import { loadEnv, readConfig, selectProfile, PROVIDERS } from '../src/config.js';
loadEnv();
const config = selectProfile(readConfig(), process.argv[2] || 'deep');
const results = await Promise.all(PROVIDERS.map(async provider => {
  const { key, model } = config.providers[provider];
  const base = { provider, model };
  if (!key || !model) return { ...base, status: 'not_configured' };
  if (provider === 'meta') return { ...base, status: 'not_checked', note: 'Use the explicit Meta-only smoke test to verify inference; no catalog check is implemented.' };
  const id = encodeURIComponent(model);
  const urls = { openai: `https://api.openai.com/v1/models/${id}`, claude: `https://api.anthropic.com/v1/models/${id}`,
    gemini: `https://generativelanguage.googleapis.com/v1beta/models/${id}`, mistral: `https://api.mistral.ai/v1/models/${id}` };
  const headers = provider === 'claude' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : provider === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };
  try {
    const response = await fetch(urls[provider], { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) { await response.body?.cancel(); return { ...base, status: `http_${response.status}` }; }
    const card = await response.json();
    return { ...base, status: 'listed', returned_id: card.id || card.name || null };
  } catch { return { ...base, status: 'network_or_invalid_response' }; }
}));
console.log(JSON.stringify({ profile: config.profile, checks: results,
  note: 'Catalog visibility does not verify generation quota, billing, or successful inference.' }, null, 2));
