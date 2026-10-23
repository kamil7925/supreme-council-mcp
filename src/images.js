import { open, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const IMAGE_LIMITS = Object.freeze({ max_count: 8, max_bytes_each: 4 * 1024 * 1024,
  max_bytes_total: 10 * 1024 * 1024, max_dimension: 8000, formats: ['image/png', 'image/jpeg'] });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Deliberately conservative: an unknown model must be explicitly confirmed by its operator.
const knownVisionModels = {
  openai: new Set(['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-6-astra']),
  claude: new Set(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5']),
  gemini: new Set(['gemini-3.5-flash-lite', 'gemini-3.1-pro-preview']),
  mistral: new Set(['ministral-14b-latest', 'ministral-14b-2512', 'mistral-medium-3-5']),
  meta: new Set(['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1']),
};

export function visionSupport(name, provider) {
  const mode = provider.vision ?? 'auto';
  if (mode !== 'auto') return { supported: mode === 'true', basis: 'configuration' };
  const supported = knownVisionModels[name]?.has(provider.model) ?? false;
  return { supported, basis: supported ? 'known_model' : 'unverified_model' };
}

function localPath(value) {
  // Never interpret URLs, UNC paths, device paths, or drive-relative paths as image sources.
  if (!path.isAbsolute(value) || /^[\\/]{2}/.test(value) || value.includes('\0')
      || (process.platform === 'win32' && !/^[A-Za-z]:[\\/][^:]*$/.test(value))) {
    throw new Error('Image path must be an absolute local file path (no URLs or network/device paths).');
  }
  return value;
}

async function readBounded(file) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > IMAGE_LIMITS.max_bytes_each) throw new Error('Image must be a regular file of at most 4 MiB.');
    const buffer = Buffer.alloc(IMAGE_LIMITS.max_bytes_each + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > IMAGE_LIMITS.max_bytes_each) throw new Error('Image must contain between 1 byte and 4 MiB.');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

function imageInfo(bytes) {
  let info;
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
      && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) {
    info = { mime_type: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    const frames = new Set([0xc0, 0xc1, 0xc2]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (frames.has(marker) && length >= 8) {
        info = { mime_type: 'image/jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
        break;
      }
      offset += length;
    }
  }
  if (!info) throw new Error('Image must have valid PNG or JPEG headers. Export screenshots as PNG or JPEG.');
  if (!info.width || !info.height || Math.max(info.width, info.height) > IMAGE_LIMITS.max_dimension) {
    throw new Error('Image dimensions must be between 1 and 8000 pixels on each axis.');
  }
  return info;
}

export class ImageStore {
  constructor(root) { this.root = path.join(root, 'images'); }
  file(image) {
    if (!/^[a-f0-9]{64}$/.test(image.sha256) || !IMAGE_LIMITS.formats.includes(image.mime_type)) throw new Error('Invalid image manifest.');
    return path.join(this.root, `${image.sha256}.${image.mime_type === 'image/png' ? 'png' : 'jpg'}`);
  }
  async snapshot(inputs = []) {
    if (inputs.length > IMAGE_LIMITS.max_count) throw new Error('At most 8 images may be attached.');
    const loaded = [];
    let total = 0;
    for (const input of inputs) {
      const bytes = await readBounded(localPath(input.path));
      total += bytes.length;
      if (total > IMAGE_LIMITS.max_bytes_total) throw new Error('Combined image size exceeds 10 MiB.');
      loaded.push({ bytes, manifest: { id: input.id, title: input.title, original_path: input.path,
        ...imageInfo(bytes), bytes: bytes.length, sha256: hash(bytes) } });
    }
    if (loaded.length) await mkdir(this.root, { recursive: true });
    for (const { bytes, manifest } of loaded) {
      try { await writeFile(this.file(manifest), bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (hash(await readBounded(this.file(manifest))) !== manifest.sha256) throw new Error('Existing image snapshot failed integrity check.');
      }
    }
    return loaded.map(item => item.manifest);
  }
  async load(manifests = []) {
    let total = 0;
    const images = [];
    for (const manifest of manifests) {
      const bytes = await readBounded(this.file(manifest));
      const info = imageInfo(bytes);
      if (hash(bytes) !== manifest.sha256 || bytes.length !== manifest.bytes
          || Object.keys(info).some(key => info[key] !== manifest[key])) throw new Error('Image snapshot integrity check failed; prepare the briefing again.');
      total += bytes.length;
      if (total > IMAGE_LIMITS.max_bytes_total) throw new Error('Combined image size exceeds 10 MiB.');
      images.push({ ...manifest, data: bytes.toString('base64') });
    }
    return images;
  }
}
