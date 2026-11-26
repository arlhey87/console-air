import type { NextApiRequest } from "next";
import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter, getClientKey } from "./fixedWindowRateLimiter";

describe(FixedWindowRateLimiter.name, () => {
  it("allows requests up to the limit within a window", () => {
    const { limiter } = setup({ limit: 2 });

    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("rejects requests over the limit with the seconds left in the window", () => {
    const { limiter, clock } = setup({ limit: 1, windowMs: 60_000 });
    limiter.consume("a");
    clock.now += 20_000;

    expect(limiter.consume("a")).toEqual({ allowed: false, retryAfterSeconds: 40 });
  });

  it("tracks each key independently", () => {
    const { limiter } = setup({ limit: 1 });
    limiter.consume("a");

    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("starts a fresh window once the previous one expires", () => {
    const { limiter, clock } = setup({ limit: 1, windowMs: 60_000 });
    limiter.consume("a");
    clock.now += 60_000;

    expect(limiter.consume("a").allowed).toBe(true);
  });

  describe("when the tracked-key capacity is reached", () => {
    it("rejects unseen keys while every tracked window is still active", () => {
      const { limiter } = setup({ limit: 5, maxKeys: 2 });
      limiter.consume("a");
      limiter.consume("b");

      expect(limiter.consume("c").allowed).toBe(false);
      expect(limiter.consume("a").allowed).toBe(true);
    });

    it("admits unseen keys after expired windows are dropped", () => {
      const { limiter, clock } = setup({ limit: 5, windowMs: 60_000, maxKeys: 2 });
      limiter.consume("a");
      limiter.consume("b");
      clock.now += 60_000;

      expect(limiter.consume("c").allowed).toBe(true);
    });
  });

  function setup(input: { limit: number; windowMs?: number; maxKeys?: number }) {
    const clock = { now: 1_000_000 };
    const limiter = new FixedWindowRateLimiter({
      limit: input.limit,
      windowMs: input.windowMs ?? 60_000,
      maxKeys: input.maxKeys,
      now: () => clock.now
    });
    return { limiter, clock };
  }
});

describe(getClientKey.name, () => {
  it("uses the X-Real-IP header set by the reverse proxy", () => {
    const req = { headers: { "x-real-ip": " 203.0.113.7 " }, socket: { remoteAddress: "10.0.0.1" } } as unknown as NextApiRequest;

    expect(getClientKey(req)).toBe("203.0.113.7");
  });

  it("falls back to the socket address when X-Real-IP is absent", () => {
    const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" } } as unknown as NextApiRequest;

    expect(getClientKey(req)).toBe("10.0.0.1");
  });

  it("returns a constant key when neither source is available", () => {
    const req = { headers: {} } as unknown as NextApiRequest;

    expect(getClientKey(req)).toBe("unknown");
  });
});
