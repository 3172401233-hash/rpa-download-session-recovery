import { promises as fs } from 'node:fs';
import path from 'node:path';

export function initialCheckpoint() {
  return {
    version: 1,
    cookies: null,
    pages: {},
    files: {},
    completedDigests: {},
    updatedAt: null,
  };
}

export class MemoryCheckpointStore {
  constructor(initial = null) {
    this.state = initial;
  }

  async load() {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state) {
    this.state = structuredClone(state);
  }
}

export class FileCheckpointStore {
  constructor(filePath) {
    this.path = filePath;
    this.counter = 0;
  }

  async load() {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(state) {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    this.counter += 1;
    const tmp = `${this.path}.tmp-${process.pid}-${this.counter}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, this.path);
  }
}
