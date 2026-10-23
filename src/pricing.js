// Standard paid rates, USD per million tokens. Not an account/billing lookup.
// Sources and date are returned with every estimate; unknown models remain unpriced.
const verifiedAt = '2026-09-18';
const sources = {
  openai: 'https://developers.openai.com/api/docs/models/',
  claude: 'https://platform.claude.com/docs/en/about-claude/pricing',
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
  mistral: 'https://docs.mistral.ai/inference/pricing',
  meta: 'https://dev.meta.ai/docs/pricing-rate-limits',
};
const rates = {
  openai: { 'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1-mini-2025-04-14': [0.4, 1.6], 'gpt-6-astra': [10, 50] },
  claude: { 'claude-haiku-4-5-20251001': [1, 5], 'claude-haiku-4-5': [1, 5], 'claude-opus-5': [5, 25] },
  gemini: { 'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-3.1-pro-preview': [2, 12] },
  mistral: { 'ministral-14b-latest': [0.2, 0.2], 'ministral-14b-2512': [0.2, 0.2], 'mistral-medium-3-5': [1.5, 7.5] },
  meta: { 'muse-spark-1.3': [1.25, 4.25], 'muse-spark-1.2': [1.25, 4.25], 'muse-spark-1.1': [1.25, 4.25] },
};
const round = value => Math.round(value * 1e6) / 1e6;
const tokens = text => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);

export function estimateCost(config, members, synthesizer, payload, reviewInstructions, synthesisInstructions, imageCount) {
  const inputTokens = tokens(payload + reviewInstructions);
  const calls = members.map(provider => ({ provider, role: 'review', inputTokens }));
  if (synthesizer) calls.push({ provider: synthesizer, role: 'synthesis',
    inputTokens: tokens(payload + synthesisInstructions) + members.length * config.maxOutputTokens * 2 + 512 });
  const details = calls.map(({ provider, role, inputTokens }) => {
    const model = config.providers[provider].model;
    let rate = rates[provider]?.[model];
    // Long-context pricing tiers, based on the heuristic token estimate.
    if (rate && model === 'gpt-6-astra' && inputTokens > 272000) rate = [20, 75];
    if (rate && model === 'gemini-3.1-pro-preview' && inputTokens > 200000) rate = [4, 18];
    return { provider, role, model, estimated_text_input_tokens: inputTokens,
      output_token_allowance: config.maxOutputTokens,
      input_usd_per_million: rate?.[0] ?? null, output_usd_per_million: rate?.[1] ?? null,
      text_input_plus_output_allowance_usd: rate ? round((inputTokens * rate[0] + config.maxOutputTokens * rate[1]) / 1e6) : null,
      source: provider === 'openai' ? `${sources.openai}${model}/` : sources[provider] };
  });
  const complete = details.every(item => item.text_input_plus_output_allowance_usd !== null);
  const subtotal = round(details.reduce((sum, item) => sum + (item.text_input_plus_output_allowance_usd ?? 0), 0));
  return { currency: 'USD', rates_verified_at: verifiedAt, method: 'UTF-8 text bytes / 3 plus full output allowance; heuristic, not a quote or spend cap',
    calls: details, all_models_priced: complete,
    known_text_and_output_subtotal_usd: subtotal,
    estimated_total_usd: complete && !imageCount ? subtotal : null,
    image_input_included: false,
    notes: ['Assumes standard paid, uncached usage before credits, free tiers, taxes or discounts.',
      'Uses the full output allowance, including reasoning where the provider counts it there. Actual output often costs less.',
      'Synthesis reserves additional estimated input for member responses and may be skipped after failures.',
      ...(imageCount ? ['Image input charges are not estimated; the subtotal is NOT a total. Image tokens can also change pricing tiers.'] : []),
      ...(!complete ? ['One or more configured models have no verified rate; the subtotal is incomplete.'] : [])] };
}
