import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatFollowupNotification,
  formatOnchainSentimentReport,
  formatRank,
  formatScanReport,
  splitTelegram,
} from "../src/bot/format.js";
import type { DerivedMetrics } from "../src/metrics/derive.js";
import type { ScoreResult } from "../src/scoring/engine.js";

const metrics: DerivedMetrics = {
  pairAgeMinutes: 23,
  liquidityUsd: 34_000,
  marketCapUsd: 180_000,
  fdvUsd: 180_000,
  priceUsd: 0.01,
  volume1hUsd: 96_000,
  volume6hUsd: null,
  volume24hUsd: null,
  buys1h: 184,
  sells1h: 91,
  priceChange1hPct: 18,
  liquidityToMarketCap: 0.189,
  volume1hToLiquidity: 2.8,
  volume1hToMarketCap: 0.53,
  buySellRatio1h: 2,
  netBuys1h: 93,
  mentions15m: 4,
  mentions1h: 7,
  mentions6h: 10,
  mentions24h: 12,
  mentionVelocity15m: 1,
  mentionVelocity1h: 3,
  distinctSenders1h: 3,
  minutesSinceFirstMention: 40,
};

const score: ScoreResult = {
  configVersion: "scoring.v4",
  marketQuality: 16,
  marketActivity: 20,
  attention: 19,
  relativeValue: 13,
  penalties: 0,
  baseTotal: 68,
  sentimentAdjustment: 0,
  total: 68,
  verdict: "INVESTIGATE",
  provisional: true,
  cohort: "<1h",
  comparableCount: 5,
  flags: [
    { kind: "green", text: "Market momentum is strong vs capitalization" },
    { kind: "green", text: "Liquidity is 18.9% of market cap" },
    { kind: "red", text: "Holder/deployer/mint risk not checked" },
  ],
  dataQuality: "ok",
};

describe("telegram formatting", () => {
  it("escapes HTML", () => {
    expect(escapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("renders a clearer scan report", () => {
    const text = formatScanReport({
      symbol: "TOKEN",
      metrics,
      score,
      pair: {
        chainId: "solana",
        dexId: "raydium",
        pairAddress: "PairX",
        url: "https://dexscreener.com/solana/PairX",
        baseToken: { address: "t", name: "TOKEN", symbol: "TOKEN" },
        quoteToken: { address: "s", name: "SOL", symbol: "SOL" },
        priceUsd: "0.01",
      },
      firstSeenAt: "2026-07-20T14:32:00.000Z",
      recommendMinScore: 65,
    });
    expect(text).toContain("<b>ORION</b>  ·  $TOKEN");
    expect(text).toContain("<b>68</b>/100 ✅");
    expect(text).toContain("23m old");
    expect(text).toContain("✅ Recommended (≥65)");
    expect(text).toContain("LOOK");
    expect(text).toContain("Liq $34k");
    expect(text).toContain("Δ +18%");
    expect(text).toContain("Buys/Sells 184/91");
    expect(text).toContain("Vol/MC +53%");
    expect(text).toContain("Peers: provisional");
    expect(text).toContain("Quality 16/25");
    expect(text).toContain("Momentum 19/25");
    expect(text).toContain("<b>Blend</b>");
    expect(text).toContain("Final <b>68</b>/100");
    expect(text).toContain("First seen 14:32 UTC");
    expect(text).toContain("🔗");
    expect(text).not.toContain("Breadth");
  });

  it("shows sentiment blend on scan without full sentiment dump", () => {
    const text = formatScanReport({
      symbol: "TOKEN",
      metrics,
      score: { ...score, baseTotal: 68, sentimentAdjustment: 8, total: 76 },
      pair: null,
      recommendMinScore: 65,
    });
    expect(text).toContain("Market 68 → Final <b>76</b>/100");
    expect(text).toContain("sentiment +8");
    expect(text).not.toContain("Accel");
  });

  it("marks low scores as not recommended", () => {
    const text = formatScanReport({
      symbol: "BTC",
      metrics,
      score: { ...score, total: 29, verdict: "IGNORE" },
      pair: null,
      recommendMinScore: 65,
    });
    expect(text).toContain("<b>29</b>/100 ⛔");
    expect(text).toContain("⛔ Not recommended (need ≥65)");
    expect(text).toContain("SKIP");
  });

  it("formats large market caps as billions", () => {
    const text = formatScanReport({
      symbol: "USDC",
      metrics: { ...metrics, marketCapUsd: 60_938_530_000, fdvUsd: 9_348_620_000 },
      score,
      pair: null,
    });
    expect(text).toContain("MC $60.94B");
    expect(text).toContain("FDV $9.35B");
  });

  it("renders a presentable on-chain report", () => {
    const text = formatOnchainSentimentReport({
      ok: true,
      executionId: "12345678-1234-1234-1234-123456789abc",
      chain: "solana",
      address: "TokenAddress",
      marketAddress: "PairAddress",
      provider: "helius:getTransactionsForAddress",
      truncated: true,
      inspectedTransactions: 100,
      metrics: {
        windowMinutes: 15,
        uniqueBuyers: 12,
        uniqueSellers: 4,
        selfTradingWallets: 2,
        buyCount: 18,
        sellCount: 5,
        buyTokenVolume: 1_000,
        sellTokenVolume: 250,
        buyVolumeUsd: 500,
        sellVolumeUsd: 125,
        netFlowUsd: 375,
        buyerSellerRatio: 3,
        buySellVolumeRatio: 4,
        buyerGrowth: 0.5,
        previousUniqueBuyers: 8,
        topFiveBuyerShare: 0.35,
        analyzedSwaps: 23,
        truncated: true,
      },
      score: {
        total: 82,
        verdict: "STRONG",
        confidence: "normal",
        breadth: 22,
        volumeBalance: 22,
        netFlow: 17,
        acceleration: 11,
        concentration: 10,
        flags: [{ kind: "green", text: "Broad buyer participation" }],
      },
    });

    expect(text).toContain("<b>ORION SENTIMENT</b>  ·  <b>82</b>/100  ·  STRONG");
    expect(text).toContain("15m  ·  SOLANA  ·  OK");
    expect(text).toContain("Buy $500.00  ·  Sell $125.00  ·  Net +$375.00");
    expect(text).toContain("Buyers 12  ·  Sellers 4  ·  Self-traders 2");
    expect(text).toContain("Growth +50% (prev 8)  ·  Top5 35%");
    expect(text).toContain("Breadth 22/25");
    expect(text).toContain("✅ Broad buyer participation");
    expect(text).toContain("Window truncated");
    expect(text).toContain("Pool <code>PairAddress</code>");
    expect(text).toContain("id <code>12345678</code>");
  });

  it("renders a follow-up notification with return delta", () => {
    const text = formatFollowupNotification({
      symbol: "TOKEN",
      address: "TokenAddress111",
      horizon: "15m",
      status: "completed",
      returnPct: 24.6,
      baselineScore: 68,
      followupScore: 71,
      baselinePriceUsd: 0.01,
      followupPriceUsd: 0.01246,
      baselineMarketCapUsd: 180_000,
      followupMarketCapUsd: 224_000,
      baselineLiquidityUsd: 34_000,
      followupLiquidityUsd: 40_000,
      baselineSentiment: {
        score: 55,
        verdict: "NEUTRAL",
        confidence: "normal",
        breadth: 12,
        volumeBalance: 12,
        netFlow: 10,
        acceleration: 8,
        concentration: 13,
        uniqueBuyers: 10,
        uniqueSellers: 6,
        selfTradingWallets: 0,
        buyCount: 20,
        sellCount: 8,
        netFlowUsd: 100,
        buyerGrowth: 0.1,
        topFiveBuyerShare: 0.4,
        windowMinutes: 15,
        truncated: false,
        executionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
      followupSentiment: {
        score: 70,
        verdict: "CONSTRUCTIVE",
        confidence: "normal",
        breadth: 18,
        volumeBalance: 16,
        netFlow: 14,
        acceleration: 10,
        concentration: 12,
        uniqueBuyers: 18,
        uniqueSellers: 5,
        selfTradingWallets: 0,
        buyCount: 40,
        sellCount: 10,
        netFlowUsd: 400,
        buyerGrowth: 0.4,
        topFiveBuyerShare: 0.3,
        windowMinutes: 15,
        truncated: false,
        executionId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
      pairUrl: "https://dexscreener.com/solana/PairX",
    });
    expect(text).toContain("<b>ORION FOLLOW-UP</b>  ·  15m  ·  $TOKEN");
    expect(text).toContain("<b>Return +25%</b>");
    expect(text).toContain("📈");
    expect(text).toContain("<b>Deltas</b>");
    expect(text).toContain("Market 68 → 71 (+3)");
    expect(text).toContain("Sentiment 55 → 70 (+15)");
    expect(text).toContain("Buyers 10 → 18 (+8)");
    expect(text).toContain("Dexscreener");
  });

  it("renders rank and viable lists", () => {
    const rows = [
      {
        token_address: "AddrHigh",
        symbol: "HOT",
        score_total: 72,
        verdict: "INVESTIGATE",
        market_cap_usd: 200_000,
        liquidity_usd: 40_000,
        scanned_at: "2026-07-22T12:00:00.000Z",
      },
    ];
    expect(formatRank({ rows, mode: "rank" })).toContain("RANK");
    expect(formatRank({ rows, mode: "viable", minScore: 65 })).toContain("VIABLE (≥65)");
    expect(formatRank({ rows: [], mode: "viable", minScore: 65 })).toContain(
      "No tokens at/above the recommend threshold",
    );
  });

  it("splits oversized messages safely", () => {
    const big = "x".repeat(5000);
    const parts = splitTelegram(big, 4096);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    expect(parts.join("")).toBe(big);
  });
});
