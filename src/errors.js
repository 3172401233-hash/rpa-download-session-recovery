export const ErrorCode = Object.freeze({
  AUTH: 'AUTH',
  EXPIRED_URL: 'EXPIRED_URL',
  CURSOR_INVALID: 'CURSOR_INVALID',
  TRANSIENT: 'TRANSIENT',
  FATAL: 'FATAL',
});

export class TransportError extends Error {
  constructor(message, { code = ErrorCode.FATAL, status = null, cause } = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export function isRetryable(err) {
  return err instanceof TransportError && err.code === ErrorCode.TRANSIENT;
}
