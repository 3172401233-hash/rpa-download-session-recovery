import { createHash } from 'node:crypto';
import { TransportError, ErrorCode } from '../src/errors.js';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function makeFile(text) {
  const body = Buffer.from(text);
  return { body, size: body.length, digest: sha256(body) };
}

export const ERROR_PAGE = Buffer.from(
  '<!DOCTYPE html><html><body>error: request cannot be processed</body></html>',
);

export class FakeTransport {
  constructor() {
    this.pages = new Map();
    this.files = new Map();
    this.writes = new Map();
    this.quarantined = [];
    this.serverCookie = 'session-0';
    this.refreshSessionCalls = 0;
    this.downloadCalls = new Map();
    this.fetchPageCalls = 0;
    this.expireAfter = null;
    this.networkFlakes = new Map();
    this.pageErrors = new Map();
    this.expiredUrls = new Set();
    this.errorPageUrls = new Set();
    this.unknownCursorsAreInvalid = true;
    this.activeDownloads = 0;
    this.maxActiveDownloads = 0;
    this.authCalls = 0;
    this.rotations = 0;
  }

  addTask(key, pages) {
    this.pages.set(key, pages);
  }

  addFile(url, file) {
    this.files.set(url, file);
  }

  checkAuth(ctx) {
    if (ctx.cookies !== this.serverCookie) {
      throw new TransportError('session not valid', {
        code: ErrorCode.AUTH,
        status: 401,
      });
    }
    this.authCalls += 1;
    if (this.expireAfter != null && this.authCalls >= this.expireAfter) {
      this.rotations += 1;
      this.serverCookie = `rotated-${this.rotations}`;
      this.expireAfter = null;
    }
  }

  async refreshSession() {
    this.refreshSessionCalls += 1;
    this.rotations += 1;
    this.serverCookie = `session-${this.rotations}`;
    return this.serverCookie;
  }

  async fetchPage({ key, cursor }, ctx) {
    this.checkAuth(ctx);
    this.fetchPageCalls += 1;
    const pageErrors = this.pageErrors.get(cursor) ?? 0;
    if (pageErrors > 0) {
      this.pageErrors.set(cursor, pageErrors - 1);
      throw new Error('ECONNRESET');
    }
    const pages = this.pages.get(key);
    if (!pages) {
      throw new TransportError(`unknown task ${key}`, { code: ErrorCode.FATAL });
    }
    let index = 0;
    if (cursor != null) {
      index = pages.findIndex((page) => page.cursor === cursor);
      if (index === -1) {
        if (this.unknownCursorsAreInvalid) {
          throw new TransportError('cursor invalid', {
            code: ErrorCode.CURSOR_INVALID,
          });
        }
        index = 0;
      }
    }
    const page = pages[index];
    const next = pages[index + 1];
    return {
      status: 200,
      items: page.items.map((item) => ({ ...item })),
      nextCursor: next ? next.cursor : null,
    };
  }

  async download(url, ctx) {
    this.checkAuth(ctx);
    this.downloadCalls.set(url, (this.downloadCalls.get(url) ?? 0) + 1);
    const flakes = this.networkFlakes.get(url) ?? 0;
    if (flakes > 0) {
      this.networkFlakes.set(url, flakes - 1);
      throw new Error('ECONNRESET');
    }
    if (this.expiredUrls.has(url)) {
      return { status: 410, headers: {}, body: Buffer.from('gone') };
    }
    if (this.errorPageUrls.has(url)) {
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: ERROR_PAGE,
      };
    }
    const file = this.files.get(url);
    if (!file) {
      return { status: 404, headers: {}, body: Buffer.from('not found') };
    }
    this.activeDownloads += 1;
    this.maxActiveDownloads = Math.max(
      this.maxActiveDownloads,
      this.activeDownloads,
    );
    await new Promise((resolve) => setImmediate(resolve));
    this.activeDownloads -= 1;
    return {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(file.body.length),
      },
      body: file.body,
    };
  }

  async writeFile(name, body) {
    this.writes.set(name, Buffer.from(body));
  }

  async quarantine(name, body, meta) {
    this.quarantined.push({ name, body: Buffer.from(body), meta });
  }
}
