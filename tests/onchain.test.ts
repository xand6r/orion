import { describe, expect, it } from "vitest";
import { analyzeSwaps } from "../src/onchain/analyze.js";
import { scoreOnchainSentiment } from "../src/onchain/score.js";
import { OnchainSentimentService } from "../src/onchain/service.js";
import {
  parseSwap,
  SolanaHeliusAdapter,
} from "../src/onchain/adapters/solana-helius.js";
import { createLogger } from "../src/logger.js";
import type { NormalizedSwap, OnchainAdapter } from "../src/onchain/types.js";

const TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE = "So11111111111111111111111111111111111111112";
const WALLET = "7YttLkHDoNj9wyDur5DoxXBbZyLcXfJ9vCqA91K9wttN";
const PAIR = "So11111111111111111111111111111111111111112";

function balance(mint: string, amount: number) {
  return {
    accountIndex: mint === TOKEN ? 1 : 2,
    mint,
    owner: WALLET,
    uiTokenAmount: {
      uiAmount: amount,
      uiAmountString: String(amount),
      amount: String(amount),
      decimals: 0,
    },
  };
}

function transaction(input: {
  signature?: string;
  targetPre: number;
  targetPost: number;
  quotePre?: number;
  quotePost?: number;
  blockTime?: number;
}) {
  const preTokenBalances = [balance(TOKEN, input.targetPre)];
  const postTokenBalances = [balance(TOKEN, input.targetPost)];
  if (input.quotePre !== undefined) preTokenBalances.push(balance(QUOTE, input.quotePre));
  if (input.quotePost !== undefined) postTokenBalances.push(balance(QUOTE, input.quotePost));
  return {
    blockTime: input.blockTime ?? 1_700_000_000,
    transaction: {
      signatures: [input.signature ?? "sig-1"],
      message: { accountKeys: [WALLET, "token-account", "quote-account"] },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000_000, 0, 0],
      postBalances: [999_995_000, 0, 0],
      preTokenBalances,
      postTokenBalances,
    },
  };
}

describe("Solana swap parsing", () => {
  it("recognizes opposite token balance changes as a buy", () => {
    const parsed = parseSwap(
      transaction({ targetPre: 0, targetPost: 100, quotePre: 200, quotePost: 100 }),
      TOKEN,
      0.5,
    );
    expect(parsed).toMatchObject({
      id: "sig-1",
      wallet: WALLET,
      side: "buy",
      tokenAmount: 100,
      usdValue: 50,
    });
  });

  it("does not mistake a simple token transfer for a swap", () => {
    const parsed = parseSwap(
      transaction({ targetPre: 0, targetPost: 100 }),
      TOKEN,
      0.5,
    );
    expect(parsed).toBeNull();
  });

  it("validates and parses Helius responses at the adapter boundary", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      expect(request.method).toBe("getTransactionsForAddress");
      expect(request.params[0]).toBe(PAIR);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "orion-onchain",
          result: {
            data: [
              transaction({
                targetPre: 0,
                targetPost: 100,
                quotePre: 200,
                quotePost: 100,
                blockTime: Math.floor(Date.now() / 1000),
              }),
            ],
            paginationToken: null,
          },
        }),
        { status: 200 },
      );
    };
    const adapter = new SolanaHeliusAdapter({
      apiKey: "test-key",
      rpcUrl: "https://example.test",
      timeoutMs: 1000,
      maxRetries: 0,
      maxTransactions: 100,
      fetchImpl,
      log: createLogger("error"),
    });
    const result = await adapter.getSwaps({
      address: TOKEN,
      marketAddress: PAIR,
      from: new Date(Date.now() - 60_000),
      to: new Date(),
      priceUsd: 0.5,
    });
    expect(result.swaps).toHaveLength(1);
    expect(result.inspectedTransactions).toBe(1);
    expect(result.truncated).toBe(false);
  });
});

describe("on-chain sentiment analysis", () => {
  it("deduplicates swaps and compares current with previous windows", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const swaps: NormalizedSwap[] = [
      swap("a", "buyer-1", "buy", 100, "2026-07-20T11:55:00.000Z"),
      swap("a", "buyer-1", "buy", 100, "2026-07-20T11:55:00.000Z"),
      swap("b", "buyer-2", "buy", 50, "2026-07-20T11:50:00.000Z"),
      swap("c", "seller-1", "sell", 25, "2026-07-20T11:48:00.000Z"),
      swap("d", "old-buyer", "buy", 20, "2026-07-20T11:40:00.000Z"),
    ];
    const metrics = analyzeSwaps({ swaps, now, windowMinutes: 15 });
    expect(metrics.analyzedSwaps).toBe(3);
    expect(metrics.uniqueBuyers).toBe(2);
    expect(metrics.uniqueSellers).toBe(1);
    expect(metrics.previousUniqueBuyers).toBe(1);
    expect(metrics.buyerGrowth).toBe(1);
    expect(metrics.netFlowUsd).toBe(125);
  });

  it("scores broad accelerating demand above concentrated selling", () => {
    const strong = scoreOnchainSentiment({
      ...baseMetrics(),
      uniqueBuyers: 20,
      uniqueSellers: 5,
      buyCount: 25,
      sellCount: 5,
      buyTokenVolume: 1_000,
      sellTokenVolume: 250,
      buyVolumeUsd: 1_000,
      sellVolumeUsd: 250,
      netFlowUsd: 750,
      buyerSellerRatio: 4,
      buySellVolumeRatio: 4,
      buyerGrowth: 1,
      previousUniqueBuyers: 10,
      topFiveBuyerShare: 0.2,
      analyzedSwaps: 30,
    });
    expect(strong.total).toBeGreaterThanOrEqual(80);
    expect(strong.verdict).toBe("STRONG");
    expect(strong.confidence).toBe("normal");
  });

  it("caps the verdict when swap count is too thin to trust", () => {
    const thin = scoreOnchainSentiment({
      ...baseMetrics(),
      uniqueBuyers: 3,
      buyCount: 3,
      buyTokenVolume: 300,
      buyerSellerRatio: 5,
      buySellVolumeRatio: 5,
      buyerGrowth: 1,
      topFiveBuyerShare: 0.2,
      analyzedSwaps: 3,
    });
    expect(thin.confidence).toBe("insufficient");
    expect(["WEAK", "NEUTRAL"]).toContain(thin.verdict);
  });

  it("does not score acceleration from a truncated window", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const swaps: NormalizedSwap[] = Array.from({ length: 6 }, (_, i) =>
      swap(`buy-${i}`, `buyer-${i}`, "buy", 10, "2026-07-20T11:55:00.000Z"),
    );
    const metrics = analyzeSwaps({ swaps, now, windowMinutes: 15, truncated: true });
    expect(metrics.buyerGrowth).toBeNull();
    const scored = scoreOnchainSentiment(metrics);
    expect(scored.acceleration).toBe(0);
    expect(scored.verdict).not.toBe("STRONG");
  });

  it("excludes self-trading wallets from breadth and penalizes wash patterns", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const swaps: NormalizedSwap[] = [
      swap("a", "washer", "buy", 100, "2026-07-20T11:55:00.000Z"),
      swap("b", "washer", "sell", 100, "2026-07-20T11:56:00.000Z"),
      swap("c", "buyer-1", "buy", 10, "2026-07-20T11:57:00.000Z"),
    ];
    const metrics = analyzeSwaps({ swaps, now, windowMinutes: 15 });
    expect(metrics.selfTradingWallets).toBe(1);
    expect(metrics.uniqueBuyers).toBe(1);
    expect(metrics.uniqueSellers).toBe(0);
    const scored = scoreOnchainSentiment(metrics);
    expect(scored.flags.some((f) => f.text.includes("wash"))).toBe(true);
  });

  it("caps one-sided flow ratios instead of returning Infinity", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const swaps: NormalizedSwap[] = [
      swap("a", "buyer-1", "buy", 100, "2026-07-20T11:55:00.000Z"),
      swap("b", "buyer-2", "buy", 50, "2026-07-20T11:56:00.000Z"),
    ];
    const metrics = analyzeSwaps({ swaps, now, windowMinutes: 15 });
    expect(metrics.buyerSellerRatio).toBe(5);
    expect(metrics.buySellVolumeRatio).toBe(5);
  });

  it("returns a traceable error for unsupported chains", async () => {
    const service = new OnchainSentimentService([], createLogger("error"));
    const outcome = await service.analyze({
      chain: "ethereum",
      address: "0x1234567890123456789012345678901234567890",
      windowMinutes: 15,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("UNSUPPORTED_CHAIN");
    expect(outcome.executionId).toHaveLength(36);
  });

  it("runs independently against a supplied chain adapter", async () => {
    const adapter: OnchainAdapter = {
      chain: "solana",
      validateAddress: () => true,
      getSwaps: async () => ({
        provider: "fixture",
        truncated: false,
        inspectedTransactions: 2,
        swaps: [
          swap("one", "buyer", "buy", 10, "2026-07-20T11:59:00.000Z"),
          swap("two", "seller", "sell", 2, "2026-07-20T11:58:00.000Z"),
        ],
      }),
    };
    const service = new OnchainSentimentService([adapter], createLogger("error"));
    const outcome = await service.analyze({
      chain: "sol",
      address: TOKEN,
      windowMinutes: 15,
      now: new Date("2026-07-20T12:00:00.000Z"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.provider).toBe("fixture");
    expect(outcome.metrics.uniqueBuyers).toBe(1);
  });
});

function swap(
  id: string,
  wallet: string,
  side: "buy" | "sell",
  amount: number,
  timestamp: string,
): NormalizedSwap {
  return {
    id,
    wallet,
    side,
    tokenAmount: amount,
    usdValue: amount,
    timestamp: new Date(timestamp),
  };
}

function baseMetrics() {
  return {
    windowMinutes: 15,
    uniqueBuyers: 0,
    uniqueSellers: 0,
    selfTradingWallets: 0,
    buyCount: 0,
    sellCount: 0,
    buyTokenVolume: 0,
    sellTokenVolume: 0,
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    netFlowUsd: null,
    buyerSellerRatio: null,
    buySellVolumeRatio: null,
    buyerGrowth: null,
    previousUniqueBuyers: 0,
    topFiveBuyerShare: null,
    analyzedSwaps: 0,
    truncated: false,
  };
}
