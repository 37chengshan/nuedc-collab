import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2) + '\n';
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(stableStringify(value), 'utf8');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function computeRevision(record: unknown): string {
  return sha256Hex(canonicalJsonBytes(record));
}

export function computeRequestHash(parts: {
  action: string;
  channel: string;
  expectedRevision?: string;
  payload: unknown;
}): string {
  return sha256Hex(
    canonicalJsonBytes({
      action: parts.action,
      channel: parts.channel,
      expectedRevision: parts.expectedRevision ?? null,
      payload: parts.payload,
    }),
  );
}
