import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoringConfigSchema } from "../src/config/scoring.js";
import { deriveMetrics, emptyMentions } from "../src/metrics/derive.js";
import { applySentimentAdjustment, scoreOpportunity } from "../src/scoring/engine.js";
import type { DexPair } from "../src/providers/dexscreener.js";

const config = scoringConfigSchema.parse(
  JSON.parse(readFileSync(new URL("../config/scoring.v4.json", import.meta.url), "utf8")),
);

function clampTotal(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function basePair(overrides: Partial<DexPair> = {}): DexPair {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "Pair111111111111111111111111111111111111111",
    url: "https://dexscreener.com/solana/pair",
    baseToken: { address: "Tok", name: "Tok", symbol: "TOK" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
    priceUsd: "0.01",
    liquidity: { usd: 34_000 },
    marketCap: 180_000,
    fdv: 180_000,
    pairCreatedAt: Date.now() - 23 * 60_000,
    volume: { h1: 96_000 },
    priceChange: { h1: 18 },
    txns: { h1: { buys: 184, sells: 91 } },
    ...overrides,
  };
}

describe("metrics", () => {
  it("keeps missing values null instead of zero", () => {
    const m = deriveMetrics({
      pair: basePair({
        liquidity: undefined,
        marketCap: undefined,
        fdv: undefined,
        volume: undefined,
        txns: undefined,
        priceChange: undefined,
        priceUsd: null,
        pairCreatedAt: undefined,
      }),
      now: new Date(),
      mentions: emptyMentions(),
    });
    expect(m.liquidityUsd).toBeNull();
    expect(m.marketCapUsd).toBeNull();
    expect(m.volume1hUsd).toBeNull();
    expect(m.buySellRatio1h).toBeNull();
    expect(m.liquidityToMarketCap).toBeNull();
    expect(m.priceUsd).toBeNull();
  });

  it("keeps FDV separate when circulating market cap is unavailable", () => {
    const m = deriveMetrics({
      pair: basePair({ marketCap: undefined, fdv: 900_000 }),
      now: new Date(),
      mentions: emptyMentions(),
    });
    expect(m.marketCapUsd).toBeNull();
    expect(m.fdvUsd).toBe(900_000);
    expect(m.volume1hToMarketCap).toBeNull();
  });

  it("computes ratios when inputs exist", () => {
    const m = deriveMetrics({
      pair: basePair(),
      now: new Date(),
      mentions: {
        ...emptyMentions(),
        m15: 4,
        h1: 7,
        prevH1: 2,
        firstMentionAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      },
    });
    expect(m.liquidityToMarketCap).toBeCloseTo(34000 / 180000, 5);
    expect(m.buySellRatio1h).toBeCloseTo(184 / 91, 5);
    expect(m.mentionVelocity1h).toBe(5);
    expect(m.pairAgeMinutes).toBeGreaterThan(20);
  });
});

describe("scoring", () => {
  it("is deterministic for a fixed config version", () => {
    const metrics = deriveMetrics({
      pair: basePair(),
      now: new Date("2026-07-20T12:00:00.000Z"),
      mentions: {
        ...emptyMentions(),
        m15: 4,
        h1: 7,
        prevH1: 2,
        distinctSenders1h: 3,
        firstMentionAt: "2026-07-20T11:00:00.000Z",
      },
    });

    const a = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: Array.from({ length: 5 }, () => metrics),
      hasPrimaryPair: true,
    });
    const b = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: Array.from({ length: 5 }, () => metrics),
      hasPrimaryPair: true,
    });

    expect(a).toEqual(b);
    expect(a.configVersion).toBe("scoring.v4");
    expect(a.baseTotal).toBe(a.total);
    expect(a.sentimentAdjustment).toBe(0);
    expect(a.provisional).toBe(true);
    expect(a.total).toBeGreaterThanOrEqual(0);
    expect(a.total).toBeLessThanOrEqual(100);
    expect(["IGNORE", "WATCH", "INVESTIGATE", "HIGH ATTENTION"]).toContain(a.verdict);
  });

  it("applies capped sentiment adjustments", () => {
    const metrics = deriveMetrics({
      pair: basePair(),
      now: new Date("2026-07-20T12:00:00.000Z"),
      mentions: emptyMentions(),
    });
    const base = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: [],
      hasPrimaryPair: true,
    });
    const boosted = applySentimentAdjustment(
      base,
      { verdict: "STRONG", confidence: "normal" },
      config,
    );
    const crushed = applySentimentAdjustment(
      base,
      { verdict: "WEAK", confidence: "normal" },
      config,
    );
    const provisional = applySentimentAdjustment(
      base,
      { verdict: "STRONG", confidence: "provisional" },
      config,
    );

    expect(boosted.total).toBe(clampTotal(base.baseTotal + 8));
    expect(boosted.sentimentAdjustment).toBe(8);
    expect(crushed.total).toBe(clampTotal(base.baseTotal - 12));
    expect(provisional.sentimentAdjustment).toBeLessThanOrEqual(2);
  });

  it("does not use Telegram mention fields in scoring", () => {
    const withoutMentions = deriveMetrics({
      pair: basePair(),
      now: new Date("2026-07-20T12:00:00.000Z"),
      mentions: emptyMentions(),
    });
    const withMentions = {
      ...withoutMentions,
      mentions15m: 1_000,
      mentions1h: 1_000,
      mentions6h: 1_000,
      mentions24h: 1_000,
      mentionVelocity15m: 1_000,
      mentionVelocity1h: 1_000,
      distinctSenders1h: 1_000,
      minutesSinceFirstMention: 1,
    };
    const baseline = scoreOpportunity({
      metrics: withoutMentions,
      config,
      comparableMetrics: [],
      hasPrimaryPair: true,
    });
    const mentioned = scoreOpportunity({
      metrics: withMentions,
      config,
      comparableMetrics: [],
      hasPrimaryPair: true,
    });

    expect(mentioned).toEqual(baseline);
  });

  it("caps verdict when pair is missing / critically illiquid", () => {
    const metrics = deriveMetrics({
      pair: basePair({ liquidity: { usd: 100 }, marketCap: 1_000_000 }),
      now: new Date(),
      mentions: { ...emptyMentions(), h1: 50, prevH1: 1, distinctSenders1h: 10 },
    });
    const scored = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: Array.from({ length: 100 }, () => metrics),
      hasPrimaryPair: true,
    });
    expect(scored.verdict).not.toBe("HIGH ATTENTION");
  });

  it("applies incomplete-data penalty", () => {
    const metrics = deriveMetrics({
      pair: basePair({ priceUsd: null, volume: undefined, liquidity: undefined }),
      now: new Date(),
      mentions: emptyMentions(),
    });
    const scored = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: Array.from({ length: 100 }, () => metrics),
      hasPrimaryPair: true,
    });
    expect(scored.penalties).toBeGreaterThan(0);
    expect(scored.dataQuality).not.toBe("ok");
  });

  it("uses only same-age comparables for relative-value confidence", () => {
    const metrics = deriveMetrics({
      pair: basePair(),
      now: new Date(),
      mentions: { ...emptyMentions(), h1: 7 },
    });
    const older = { ...metrics, pairAgeMinutes: 500 };
    const sameCohort = {
      ...metrics,
      mentions1h: 1,
      volume1hToMarketCap: 0.05,
    };

    const provisional = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: [sameCohort, ...Array.from({ length: 50 }, () => older)],
      hasPrimaryPair: true,
    });
    const ranked = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: Array.from({ length: 30 }, () => sameCohort),
      hasPrimaryPair: true,
    });

    expect(provisional.provisional).toBe(true);
    expect(provisional.comparableCount).toBe(1);
    expect(ranked.provisional).toBe(false);
    expect(ranked.comparableCount).toBe(30);
    expect(ranked.relativeValue).toBeGreaterThan(provisional.relativeValue);
  });
});
