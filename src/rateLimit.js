const lastApply = new Map();
const WINDOW_SEC = 600;

export function checkApplyRateLimit(email) {
  const key = email.toLowerCase().trim();
  const now = Date.now();
  const prev = lastApply.get(key);
  if (prev != null) {
    const delta = (now - prev) / 1000;
    if (delta < WINDOW_SEC) {
      const wait = Math.ceil(WINDOW_SEC - delta);
      const err = new Error(`Повторная заявка возможна через ${wait} сек.`);
      err.statusCode = 429;
      throw err;
    }
  }
  lastApply.set(key, now);
}
