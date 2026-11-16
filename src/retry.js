const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetries(
  fn,
  {
    retries = 3,
    baseDelayMs = 100,
    sleep = defaultSleep,
    shouldRetry = () => true,
    onRetry = null,
  } = {},
) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      if (onRetry) onRetry(err, attempt + 1, delay);
      await sleep(delay);
      attempt += 1;
    }
  }
}
