import { randomUUID } from "node:crypto";
import { errorFields, type Logger } from "../logger.js";
import { analyzeSwaps } from "./analyze.js";
import { scoreOnchainSentiment } from "./score.js";
import type {
  OnchainAdapter,
  OnchainSentimentOutcome,
} from "./types.js";

export class OnchainSentimentService {
  private readonly adapters = new Map<string, OnchainAdapter>();

  constructor(
    adapters: OnchainAdapter[],
    private readonly log: Logger,
  ) {
    for (const adapter of adapters) {
      this.adapters.set(normalizeChain(adapter.chain), adapter);
    }
  }

  supportedChains(): string[] {
    return [...this.adapters.keys()].sort();
  }

  async analyze(input: {
    chain: string;
    address: string;
    windowMinutes: number;
    priceUsd?: number | null;
    marketAddress?: string | null;
    now?: Date;
  }): Promise<OnchainSentimentOutcome> {
    const executionId = randomUUID();
    const startedAt = Date.now();
    const chain = normalizeChain(input.chain);
    const address = input.address.trim();
    const runLog = this.log.child({
      component: "onchain_sentiment",
      executionId,
      chain,
      address,
      windowMinutes: input.windowMinutes,
    });
    runLog.info("onchain_analysis_started");

    const adapter = this.adapters.get(chain);
    if (!adapter) {
      const supported = this.supportedChains();
      runLog.warn("onchain_chain_unsupported", { supportedChains: supported });
      return {
        ok: false,
        executionId,
        chain,
        address,
        code: "UNSUPPORTED_CHAIN",
        error: supported.length
          ? `Unsupported chain. Available: ${supported.join(", ")}`
          : "No on-chain adapters are configured",
      };
    }

    if (!adapter.validateAddress(address)) {
      runLog.warn("onchain_address_invalid");
      return {
        ok: false,
        executionId,
        chain,
        address,
        code: "INVALID_ADDRESS",
        error: `Invalid ${chain} address`,
      };
    }

    const now = input.now ?? new Date();
    const from = new Date(now.getTime() - input.windowMinutes * 2 * 60_000);

    try {
      const batch = await adapter.getSwaps({
        address,
        marketAddress: input.marketAddress ?? undefined,
        from,
        to: now,
        priceUsd: input.priceUsd,
      });
      runLog.info("onchain_swaps_fetched", {
        provider: batch.provider,
        swapCount: batch.swaps.length,
        inspectedTransactions: batch.inspectedTransactions,
        truncated: batch.truncated,
        durationMs: Date.now() - startedAt,
      });

      if (batch.swaps.length === 0) {
        runLog.info("onchain_analysis_no_data", { durationMs: Date.now() - startedAt });
        return {
          ok: false,
          executionId,
          chain,
          address,
          code: "NO_DATA",
          error: "No qualifying swaps found in the requested period",
        };
      }

      const metrics = analyzeSwaps({
        swaps: batch.swaps,
        now,
        windowMinutes: input.windowMinutes,
        truncated: batch.truncated,
      });
      const score = scoreOnchainSentiment(metrics);
      runLog.info("onchain_analysis_completed", {
        provider: batch.provider,
        score: score.total,
        verdict: score.verdict,
        confidence: score.confidence,
        uniqueBuyers: metrics.uniqueBuyers,
        uniqueSellers: metrics.uniqueSellers,
        analyzedSwaps: metrics.analyzedSwaps,
        durationMs: Date.now() - startedAt,
      });

      return {
        ok: true,
        executionId,
        chain,
        address,
        marketAddress: input.marketAddress ?? null,
        provider: batch.provider,
        truncated: batch.truncated,
        inspectedTransactions: batch.inspectedTransactions,
        metrics,
        score,
      };
    } catch (error) {
      runLog.error("onchain_analysis_failed", {
        ...errorFields(error),
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: false,
        executionId,
        chain,
        address,
        code: "PROVIDER_ERROR",
        error: "On-chain data provider failed; check the execution ID in logs",
      };
    }
  }
}

export function normalizeChain(chain: string): string {
  const normalized = chain.trim().toLowerCase();
  if (normalized === "sol") return "solana";
  if (normalized === "rh" || normalized === "robinhood-chain") return "robinhood";
  return normalized;
}
