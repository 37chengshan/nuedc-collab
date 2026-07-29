const SAFE = /^[A-Za-z0-9._:-]{16,128}$/;

export function createIdempotencyKey(prefix = "ui"): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const key = `${prefix}-${rand}`.slice(0, 128);
  if (!SAFE.test(key)) {
    const fallback = `ui-${Date.now()}${Math.random().toString(36).slice(2, 10)}`.padEnd(16, "0");
    return fallback.slice(0, 128);
  }
  return key;
}

export function assertIdempotencyKey(key: string): void {
  if (!SAFE.test(key)) {
    throw new Error("idempotencyKey 必须是 16—128 个合法 ASCII 字符");
  }
}
