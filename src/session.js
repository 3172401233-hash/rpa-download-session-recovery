import { TransportError, ErrorCode } from './errors.js';

export class SessionManager {
  constructor({
    transport,
    cookies = null,
    maxAgeMs = 30 * 60 * 1000,
    now = () => Date.now(),
  }) {
    this.transport = transport;
    this.cookies = cookies;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.refreshedAt = cookies ? now() : 0;
    this.refreshing = null;
    this.refreshCount = 0;
  }

  isStale() {
    return !this.cookies || this.now() - this.refreshedAt >= this.maxAgeMs;
  }

  async refresh() {
    if (!this.refreshing) {
      this.refreshing = Promise.resolve()
        .then(() => this.transport.refreshSession(this.cookies))
        .then((cookies) => {
          if (!cookies) {
            throw new TransportError('refreshSession returned no cookies', {
              code: ErrorCode.AUTH,
            });
          }
          this.cookies = cookies;
          this.refreshedAt = this.now();
          this.refreshCount += 1;
          return cookies;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  async getCookies() {
    if (this.isStale()) await this.refresh();
    return this.cookies;
  }

  async withSession(fn) {
    let cookies = await this.getCookies();
    try {
      return await fn(cookies);
    } catch (err) {
      if (err instanceof TransportError && err.code === ErrorCode.AUTH) {
        cookies = await this.refresh();
        return await fn(cookies);
      }
      throw err;
    }
  }
}
