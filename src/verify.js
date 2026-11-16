import { createHash } from 'node:crypto';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function looksHtmlish(body) {
  const prefix = body.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  return (
    prefix.startsWith('<!doctype') ||
    prefix.startsWith('<html') ||
    prefix.startsWith('<?xml') ||
    prefix.startsWith('<')
  );
}

export function looksLikeErrorPage({
  headers = {},
  body,
  expectedSize = null,
  minFileBytes = 256,
}) {
  const type = String(headers['content-type'] || '').toLowerCase();
  if (type.includes('text/html')) return true;
  if (expectedSize != null && body.length < expectedSize) {
    return looksHtmlish(body);
  }
  if (expectedSize == null && body.length < minFileBytes) {
    return looksHtmlish(body);
  }
  return false;
}

export function verifyFile({ body, expectedSize = null, expectedDigest = null }) {
  if (expectedSize != null && body.length !== expectedSize) {
    return {
      ok: false,
      reason: `size mismatch: expected ${expectedSize}, got ${body.length}`,
    };
  }
  const digest = sha256(body);
  if (expectedDigest && digest !== expectedDigest.toLowerCase()) {
    return { ok: false, reason: 'digest mismatch', actual: digest };
  }
  return { ok: true, digest };
}
