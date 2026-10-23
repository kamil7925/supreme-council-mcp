import { mkdir, writeFile, rename, readFile, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { idSchema } from './schemas.js';

export class Store {
  constructor(root) { this.root = root; }
  file(kind, id) {
    if (!['briefings', 'consultations'].includes(kind)) throw new Error('Invalid record type');
    idSchema.parse(id);
    return path.join(this.root, kind, `${id}.json`);
  }
  async save(kind, record) {
    const file = this.file(kind, record.id);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    // Windows can briefly deny replacement while a polling reader/virus scanner
    // holds the destination open. Retry only the local rename, never a model call.
    try {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, file); break; }
        catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error;
          await delay(10 * (2 ** attempt));
        }
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return file;
  }
  async get(kind, id) {
    try { return JSON.parse(await readFile(this.file(kind, id), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`${kind} record not found`);
      throw error;
    }
  }
  async list(kind, limit = 20) {
    const directory = path.dirname(this.file(kind, randomUUID()));
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
      .map(name => this.get(kind, name.slice(0, -5))));
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }
}
