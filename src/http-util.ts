/**
 * http-util.ts — Small HTTP primitives shared by the System One client and the
 * Harbor server. Both take bytes from a peer Harbor does not fully trust, so
 * the limits live in one place rather than being re-derived at each call site.
 */

/**
 * Read a body stream as UTF-8 text, refusing more than `max` bytes. Returns
 * `null` when the limit is exceeded — the stream is cancelled at that point, so
 * a hostile peer cannot make Harbor buffer an unbounded body.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null | undefined,
  max: number,
): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `Content-Length` as a finite number, else null. */
export function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * A per-key token bucket: `perMinute` requests per minute on average, with
 * bursts up to `perMinute`. In-memory and per-process — enough to stop one
 * runaway or hostile client from monopolising a node; it is not a billing meter.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(perMinute > 0)) throw new Error("rate limit must be positive");
  }

  take(key: string): TakeResult {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.perMinute, last: t };
      this.buckets.set(key, b);
    }
    const refill = ((t - b.last) / 60_000) * this.perMinute;
    b.tokens = Math.min(this.perMinute, b.tokens + Math.max(0, refill));
    b.last = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const secondsPerToken = 60 / this.perMinute;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) * secondsPerToken)) };
  }

  /** Drop buckets idle for `idleMs` (they would be full again anyway). */
  sweep(idleMs: number = 10 * 60_000): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.last > idleMs) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}
