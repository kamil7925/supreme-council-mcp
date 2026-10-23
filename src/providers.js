// Native HTTP adapters keep billing, model selection, and provider errors explicit.
// No automatic retry: an ambiguous network failure may already have incurred a charge.
import { visionSupport } from './images.js';

export function makeRequest(name, config, instructions, input, images = []) {
  const { key, model } = config.providers[name];
  if (images.length && !visionSupport(name, config.providers[name]).supported) throw new Error(`Image input is not confirmed for ${name}/${model}. No text-only fallback is allowed.`);
  const cap = config.maxOutputTokens;
  const headers = { 'Content-Type': 'application/json' };
  const label = image => `Attached image [${image.id}]: ${image.title}`;
  const dataUrl = image => `data:${image.mime_type};base64,${image.data}`;
  const openaiInput = images.length ? [{ role: 'user', content: [
    ...images.flatMap(image => [{ type: 'input_text', text: label(image) },
      { type: 'input_image', image_url: dataUrl(image), detail: 'high' }]),
    { type: 'input_text', text: input },
  ] }] : input;
  switch (name) {
    case 'meta':
    case 'openai': return {
      url: name === 'meta' ? 'https://api.meta.ai/v1/responses' : 'https://api.openai.com/v1/responses',
      headers: { ...headers, Authorization: `Bearer ${key}` },
      body: { model, instructions, input: openaiInput, max_output_tokens: cap, store: false },
    };
    case 'claude': return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { ...headers, 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model, system: instructions, messages: [{ role: 'user', content: images.length ? [
        ...images.flatMap(image => [{ type: 'text', text: label(image) },
          { type: 'image', source: { type: 'base64', media_type: image.mime_type, data: image.data } }]),
        { type: 'text', text: input },
      ] : input }], max_tokens: cap },
    };
    case 'gemini': return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { ...headers, 'x-goog-api-key': key },
      body: { systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: 'user', parts: [
          ...images.flatMap(image => [{ text: label(image) }, { inlineData: { mimeType: image.mime_type, data: image.data } }]),
          { text: input },
        ] }], generationConfig: { maxOutputTokens: cap } },
    };
    case 'mistral': return {
      url: 'https://api.mistral.ai/v1/chat/completions',
      headers: { ...headers, Authorization: `Bearer ${key}` },
      body: { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: images.length ? [
        ...images.flatMap(image => [{ type: 'text', text: label(image) }, { type: 'image_url', image_url: dataUrl(image) }]),
        { type: 'text', text: input },
      ] : input }], max_tokens: cap },
    };
    default: throw new Error('Unknown provider');
  }
}

export function parseResponse(name, data) {
  let text, finish, usage, returnedModel;
  if (name === 'openai' || name === 'meta') {
    text = (data.output || []).filter(item => item.type === 'message')
      .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
    finish = data.status;
    usage = data.usage;
    returnedModel = data.model;
  } else if (name === 'claude') {
    text = (data.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    finish = data.stop_reason;
    usage = data.usage;
    returnedModel = data.model;
  } else if (name === 'gemini') {
    const candidate = data.candidates?.[0];
    text = (candidate?.content?.parts || []).filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('\n');
    finish = candidate?.finishReason;
    usage = data.usageMetadata;
    returnedModel = data.modelVersion;
  } else {
    const content = data.choices?.[0]?.message?.content;
    text = typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    finish = data.choices?.[0]?.finish_reason;
    usage = data.usage;
    returnedModel = data.model;
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty_response');
  return { text: text.trim(), finish_reason: finish || null, usage: usage || null,
    returned_model: returnedModel || null,
    truncated: ['incomplete', 'max_tokens', 'MAX_TOKENS', 'length'].includes(finish) };
}

export async function callProvider(name, config, instructions, input, fetchImpl = fetch, images = []) {
  const started = Date.now();
  const base = { provider: name, model: config.providers[name].model,
    images_attached: images.map(image => ({ id: image.id, sha256: image.sha256 })) };
  const request = makeRequest(name, config, instructions, input, images);
  const controller = new AbortController();
  let timeout;
  try {
    // Race also covers response-body reads and test transports that ignore AbortSignal.
    const result = await Promise.race([
      (async () => {
        const response = await fetchImpl(request.url, { method: 'POST', headers: request.headers,
          body: JSON.stringify(request.body), signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
          // Never log provider response bodies: they can echo prompts or credentials.
          await response.body?.cancel();
          const limits = {};
          for (const [key, value] of response.headers || []) {
            if ((key === 'retry-after' || /^x-ratelimit-(limit|remaining|reset)/.test(key)) && /^\d+(\.\d+)?$/.test(value)) {
              limits[key] = value;
            }
          }
          return { ...base, status: 'error', error: `http_${response.status}`, limits };
        }
        return { ...base, status: 'ok', ...parseResponse(name, await response.json()) };
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, config.timeoutMs);
      }),
    ]);
    return { ...result, elapsed_ms: Date.now() - started };
  } catch (error) {
    const code = ['timeout', 'empty_response'].includes(error.message) ? error.message : 'network_or_invalid_response';
    return { ...base, status: 'error', error: code, elapsed_ms: Date.now() - started };
  } finally { clearTimeout(timeout); }
}
