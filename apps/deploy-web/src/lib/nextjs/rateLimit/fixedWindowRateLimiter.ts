import type { NextApiRequest } from "next";

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller's window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

interface FixedWindowRateLimiterOptions {
  /** Requests allowed per key within one window. */
  limit: number;
  windowMs: number;
  /**
   * Upper bound on tracked keys, so spoofed or rotating client keys cannot grow memory without
   * bound. Once full (after dropping expired windows), unseen keys are rejected until windows expire.
   */
  maxKeys?: number;
  now?: () => number;
}

/**
 * In-memory fixed-window limiter. State is per process: with several replicas each one enforces
 * its own budget, which is acceptable for coarse abuse protection of a single endpoint.
 */
export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitDecision {
    const now = this.#now();
    const current = this.#windows.get(key);

    if (!current || current.resetAt <= now) {
      if (!current && this.#windows.size >= this.#maxKeys) {
        this.#dropExpired(now);
        if (this.#windows.size >= this.#maxKeys) return { allowed: false, retryAfterSeconds: Math.ceil(this.#windowMs / 1000) };
      }
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= this.#limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }

    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  #dropExpired(now: number) {
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
  }
}

/**
 * Client key for rate limiting. Behind the nginx reverse proxy (docs/deploy/nginx-akash-console.conf)
 * X-Real-IP is overwritten with $remote_addr, so it cannot be spoofed by the client; when the app is
 * reached directly the header is client-controlled, and maxKeys bounds the damage.
 */
export function getClientKey(req: Pick<NextApiRequest, "headers" | "socket">): string {
  const realIp = req.headers?.["x-real-ip"];
  const value = Array.isArray(realIp) ? realIp[0] : realIp;
  return value?.trim() || req.socket?.remoteAddress || "unknown";
}
