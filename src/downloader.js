import { EventEmitter } from 'node:events';
import { SessionManager } from './session.js';
import { MemoryCheckpointStore, initialCheckpoint } from './checkpoint.js';
import { TransportError, ErrorCode, isRetryable } from './errors.js';
import { looksLikeErrorPage, verifyFile } from './verify.js';
import { withRetries } from './retry.js';

class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  next() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export class RpaDownloader {
  constructor({
    transport,
    checkpointStore = new MemoryCheckpointStore(),
    concurrency = 3,
    retries = 3,
    baseDelayMs = 100,
    sleep,
    sessionMaxAgeMs = 30 * 60 * 1000,
    minFileBytes = 256,
    maxRelocateHops = 50,
    now,
  } = {}) {
    if (!transport) throw new Error('transport is required');
    this.transport = transport;
    this.store = checkpointStore;
    this.concurrency = Math.max(1, concurrency);
    this.retries = retries;
    this.baseDelayMs = baseDelayMs;
    this.sleep = sleep;
    this.minFileBytes = minFileBytes;
    this.maxRelocateHops = maxRelocateHops;
    this.session = new SessionManager({
      transport,
      maxAgeMs: sessionMaxAgeMs,
      now,
    });
    this.state = null;
    this.enqueued = new Set();
    this.inFlight = new Map();
    this.inFlightDigests = new Map();
    this.itemOrigins = new Map();
    this.events = new EventEmitter();
  }

  async loadCheckpoint() {
    this.state = (await this.store.load()) ?? initialCheckpoint();
    if (this.state.cookies) {
      this.session.cookies = this.state.cookies;
      this.session.refreshedAt = this.session.now();
    }
    return this.state;
  }

  async saveCheckpoint() {
    this.state.cookies = this.session.cookies;
    this.state.updatedAt = new Date().toISOString();
    await this.store.save(this.state);
  }

  emit(type, payload) {
    this.events.emit(type, payload);
  }

  async run(tasks) {
    await this.loadCheckpoint();
    const queue = new AsyncQueue();
    const enqueue = (item, origin) => {
      if (origin) this.itemOrigins.set(item.id, origin);
      if (this.enqueued.has(item.id)) return;
      const status = this.state.files[item.id]?.status;
      if (status === 'done' || status === 'quarantined') return;
      this.enqueued.add(item.id);
      queue.push(item);
    };
    const workers = Array.from({ length: this.concurrency }, async () => {
      for (;;) {
        const job = await queue.next();
        if (job == null) return;
        await this.processFile(job).catch((err) => this.recordFailure(job, err));
      }
    });
    let walkError = null;
    try {
      for (const file of Object.values(this.state.files)) {
        if (file.status === 'failed' && file.item) {
          enqueue(file.item, file.origin ?? null);
        }
      }
      for (const task of tasks) {
        await this.walkTask(task, (item, origin) => enqueue(item, origin));
      }
    } catch (err) {
      walkError = err;
    } finally {
      queue.close();
    }
    await Promise.all(workers);
    await this.saveCheckpoint();
    if (walkError) throw walkError;
    return this.summary();
  }

  summary() {
    const counts = { done: 0, quarantined: 0, failed: 0 };
    for (const file of Object.values(this.state.files)) {
      if (file.status === 'done') counts.done += 1;
      else if (file.status === 'quarantined') counts.quarantined += 1;
      else if (file.status === 'failed') counts.failed += 1;
    }
    return { ...counts, sessionRefreshes: this.session.refreshCount };
  }

  async walkTask(task, emit) {
    const pageState = this.state.pages[task.key];
    if (pageState?.done) return;
    let cursor = pageState ? pageState.cursor : (task.startCursor ?? null);
    for (;;) {
      let page;
      try {
        page = await this.fetchPage(task, cursor);
      } catch (err) {
        if (err instanceof TransportError && err.code === ErrorCode.CURSOR_INVALID) {
          this.emit('cursor-invalid', { taskKey: task.key, cursor });
          cursor = task.startCursor ?? null;
          page = await this.fetchPage(task, cursor);
        } else {
          throw err;
        }
      }
      for (const item of page.items) {
        emit(item, { taskKey: task.key, cursor });
      }
      const done = !page.nextCursor;
      this.state.pages[task.key] = { cursor: page.nextCursor ?? null, done };
      await this.saveCheckpoint();
      if (done) break;
      cursor = page.nextCursor;
    }
  }

  async fetchPage(task, cursor) {
    const res = await this.session.withSession((cookies) =>
      withRetries(
        async () => {
          const page = await this.transport.fetchPage(
            { key: task.key, cursor },
            { cookies },
          ).catch((err) => {
            throw this.normalizeThrown(err);
          });
          this.classify(page, 'page');
          return page;
        },
        {
          retries: this.retries,
          baseDelayMs: this.baseDelayMs,
          sleep: this.sleep,
          shouldRetry: isRetryable,
        },
      ),
    );
    return { items: res.items ?? [], nextCursor: res.nextCursor ?? null };
  }

  classify(res, kind) {
    const status = res?.status ?? 200;
    if (status === 401) {
      throw new TransportError('session expired or unauthorized', {
        code: ErrorCode.AUTH,
        status,
      });
    }
    if (status === 403 || status === 410) {
      if (kind === 'download') {
        throw new TransportError('signed url expired', {
          code: ErrorCode.EXPIRED_URL,
          status,
        });
      }
      throw new TransportError('forbidden', { code: ErrorCode.AUTH, status });
    }
    if (status >= 500) {
      throw new TransportError(`server error ${status}`, {
        code: ErrorCode.TRANSIENT,
        status,
      });
    }
    if (status >= 400) {
      throw new TransportError(`unexpected status ${status}`, {
        code: ErrorCode.FATAL,
        status,
      });
    }
  }

  normalizeThrown(err) {
    if (err instanceof TransportError) return err;
    return new TransportError(`network error: ${err.message}`, {
      code: ErrorCode.TRANSIENT,
      cause: err,
    });
  }

  async processFile(item) {
    const existing = this.state.files[item.id];
    if (existing?.status === 'done' || existing?.status === 'quarantined') return;
    if (this.inFlight.has(item.id)) return this.inFlight.get(item.id);
    const promise = this.downloadAndStore(item).finally(() =>
      this.inFlight.delete(item.id),
    );
    this.inFlight.set(item.id, promise);
    return promise;
  }

  async downloadAndStore(item) {
    if (item.digest) {
      const markDuplicate = async (duplicateOf) => {
        await this.markDone(item, { digest: item.digest, duplicateOf });
        this.emit('duplicate', { id: item.id, digest: item.digest });
      };
      const completed = this.state.completedDigests[item.digest];
      if (completed) {
        await markDuplicate(completed);
        return;
      }
      const pending = this.inFlightDigests.get(item.digest);
      if (pending) {
        await pending.catch(() => {});
        const nowCompleted = this.state.completedDigests[item.digest];
        if (nowCompleted) {
          await markDuplicate(nowCompleted);
          return;
        }
      }
    }

    const downloadPromise = this.performDownload(item);
    if (item.digest) this.inFlightDigests.set(item.digest, downloadPromise);
    try {
      await downloadPromise;
    } finally {
      if (this.inFlightDigests.get(item.digest) === downloadPromise) {
        this.inFlightDigests.delete(item.digest);
      }
    }
  }

  async performDownload(item) {
    let current = item;
    let result;
    try {
      result = await withRetries(
        async () => {
          let res;
          try {
            res = await this.session.withSession((cookies) =>
              this.transport.download(current.url, { cookies }),
            );
          } catch (err) {
            throw this.normalizeThrown(err);
          }
          try {
            this.classify(res, 'download');
          } catch (err) {
            if (
              err instanceof TransportError &&
              err.code === ErrorCode.EXPIRED_URL
            ) {
              this.emit('url-expired', { id: current.id, url: current.url });
              current = await this.relocateItem(current);
              throw new TransportError('retrying with refreshed url', {
                code: ErrorCode.TRANSIENT,
              });
            }
            throw err;
          }
          const headers = res.headers ?? {};
          const body = res.body;
          if (
            looksLikeErrorPage({
              headers,
              body,
              expectedSize: current.size ?? null,
              minFileBytes: this.minFileBytes,
            })
          ) {
            return { errorPage: true, body };
          }
          const check = verifyFile({
            body,
            expectedSize: current.size ?? null,
            expectedDigest: current.digest ?? null,
          });
          if (!check.ok) {
            throw new TransportError(`verification failed: ${check.reason}`, {
              code: ErrorCode.TRANSIENT,
            });
          }
          return { body, digest: check.digest };
        },
        {
          retries: this.retries,
          baseDelayMs: this.baseDelayMs,
          sleep: this.sleep,
          shouldRetry: isRetryable,
        },
      );
    } catch (err) {
      if (isRetryable(err)) {
        await this.markFailed(item, err.message);
        this.emit('failed', { id: item.id, error: err.message });
        return;
      }
      throw err;
    }

    if (result.errorPage) {
      await this.quarantine(current, result.body, 'error-page');
      this.emit('quarantined', { id: current.id, reason: 'error-page' });
      return;
    }

    await this.transport.writeFile(current.name, result.body);
    await this.markDone(current, { digest: result.digest });
    this.emit('downloaded', { id: current.id, name: current.name });
  }

  async relocateItem(item) {
    const origin = this.itemOrigins.get(item.id);
    if (!origin) {
      throw new TransportError(`cannot relocate ${item.id}: unknown origin`, {
        code: ErrorCode.FATAL,
      });
    }
    const task = { key: origin.taskKey };
    const starts = [origin.cursor, task.startCursor ?? null];
    for (const start of starts) {
      let cursor = start;
      for (let hop = 0; hop < this.maxRelocateHops; hop += 1) {
        let page;
        try {
          page = await this.fetchPage(task, cursor);
        } catch (err) {
          if (
            err instanceof TransportError &&
            err.code === ErrorCode.CURSOR_INVALID
          ) {
            break;
          }
          throw err;
        }
        const found = page.items.find((candidate) => candidate.id === item.id);
        if (found) {
          this.itemOrigins.set(item.id, { taskKey: task.key, cursor });
          return found;
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }
    throw new TransportError(`item ${item.id} no longer listed`, {
      code: ErrorCode.FATAL,
    });
  }

  async markDone(item, { digest = null, duplicateOf = null } = {}) {
    this.state.files[item.id] = {
      status: 'done',
      name: item.name,
      digest,
      duplicateOf,
      completedAt: new Date().toISOString(),
    };
    if (digest) this.state.completedDigests[digest] = item.id;
    await this.saveCheckpoint();
  }

  async markFailed(item, reason) {
    this.state.files[item.id] = {
      status: 'failed',
      name: item.name,
      reason,
      item: { ...item },
      origin: this.itemOrigins.get(item.id) ?? null,
      failedAt: new Date().toISOString(),
    };
    await this.saveCheckpoint();
  }

  async quarantine(item, body, reason) {
    if (typeof this.transport.quarantine === 'function') {
      await this.transport.quarantine(item.name, body, { reason, item });
    }
    this.state.files[item.id] = {
      status: 'quarantined',
      name: item.name,
      reason,
      quarantinedAt: new Date().toISOString(),
    };
    await this.saveCheckpoint();
  }

  async recordFailure(item, err) {
    await this.markFailed(item, err.message);
    this.emit('failed', { id: item.id, error: err.message });
  }
}
