import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';

const DATA_FILE = 'board.json';

const emptyBoard = () => ({ columns: [], tasks: [] });

export const createId = () =>
  `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${randomInt(1e6).toString(36)}`;

export class Store {
  #dataDir;
  #state = emptyBoard();
  #dirty = null;
  #flushTimer = null;

  constructor(dataDir) {
    this.#dataDir = dataDir;
  }

  async load() {
    try {
      const raw = await readFile(join(this.#dataDir, DATA_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      this.#state = {
        columns: Array.isArray(parsed.columns) ? parsed.columns : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[store] failed to load data, starting with empty board:', err.message);
      }
      this.#state = emptyBoard();
    }
    return this.snapshot();
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.#state));
  }

  async mutate(fn) {
    const result = fn(this.#state, createId);
    this.#scheduleFlush();
    return result;
  }

  #scheduleFlush() {
    // 既存タイマーがあれば延長（高頻度更新時の書き込みを間引く）
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#dirty = true;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flush();
    }, 200);
  }

  async #flush() {
    if (!this.#dirty) return;
    this.#dirty = false;
    try {
      await mkdir(dirname(join(this.#dataDir, DATA_FILE)), { recursive: true });
      const tmp = join(this.#dataDir, `${DATA_FILE}.tmp`);
      await writeFile(tmp, JSON.stringify(this.#state, null, 2), 'utf8');
      await rename(tmp, join(this.#dataDir, DATA_FILE));
    } catch (err) {
      this.#dirty = true;
      console.error('[store] failed to persist data:', err.message);
    }
  }

  async close() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.#flush();
  }

  get columns() { return this.#state.columns; }
  get tasks() { return this.#state.tasks; }
}
