import type { ScoringConfig } from "../config/scoring.js";
import type { Repository } from "../db/repo.js";
import type { Logger } from "../logger.js";
import { detectMarketChain, type MarketChain } from "../address/detect.js";
import { deriveMetrics, emptyMentions } from "../metrics/derive.js";
import {
  DexscreenerClient,
  DexscreenerError,
  quoteSymbolForToken,
  selectPrimaryPair,
  tokenMeta,
  type DexPair,
} from "../providers/dexscreener.js";
import {
  applyBirdeyeAdjustment,
  applyMintRiskAdjustment,
  applyRugCheckAdjustment,
  applySentimentAdjustment,
  scoreOpportunity,
  type ScoreResult,
} from "../scoring/engine.js";
import { scoreBondingCurve } from "../scoring/bonding.js";
import type { DerivedMetrics } from "../metrics/derive.js";
import type { ScanRow } from "../db/repo.js";
import type { OnchainSentimentService } from "../onchain/service.js";
import {
  toSentimentSnapshot,
  type SentimentSnapshot,
} from "../onchain/snapshot.js";
import type { MintRiskService, MintRiskSnapshot } from "../onchain/mintrisk.js";
import type { RugCheckService, RugCheckSnapshot } from "../onchain/rugcheck.js";
import type { BirdeyeService, BirdeyeSnapshot } from "../providers/birdeye.js";
import type { PumpFunService, PumpFunSnapshot } from "../onchain/pumpfun.js";

/** Who triggered the scan — affects follow-up scheduling and watchlist auto-add. */
export type ScanSource = "organic" | "manual_scan" | "followup";

export type ScanSuccess = {
  ok: true;
  tokenAddress: string;
  chain: MarketChain;
  scan: ScanRow;
  metrics: DerivedMetrics;
  score: ScoreResult;
  pair: DexPair | null;
  allPairAddresses: string[];
  selectionReason: string | null;
  sentiment: SentimentSnapshot | null;
  sentimentNote: string | null;
};

export type ScanFailure = {
  ok: false;
  tokenAddress: string;
  error: string;
};

export type ScanOutcome = ScanSuccess | ScanFailure;

/**
 * Core research pipeline for one token.
 *
 * Flow:
 *   lock → detect chain → Dex pairs → metrics → market score
 *        → on-chain sentiment → adjust score → save → follow-ups → unlock
 */
export class ScanService {
  constructor(
    private readonly deps: {
      repo: Repository;
      dex: DexscreenerClient;
      config: ScoringConfig;
      log: Logger;
      onchain?: OnchainSentimentService | null;
      sentimentWindowMinutes?: number;
      mintRisk?: MintRiskService | null;
      rugCheck?: RugCheckService | null;
      birdeye?: BirdeyeService | null;
      pumpFun?: PumpFunService | null;
    },
  ) { }

  async scanToken(input: {
    tokenAddress: string;
    source: ScanSource;
    scheduleFollowups?: boolean;
  }): Promise<ScanOutcome> {
    const { repo, dex, config, log } = this.deps;
    const tokenAddress = input.tokenAddress;
    const chain = detectMarketChain(tokenAddress);
    if (!chain) {
      return { ok: false, tokenAddress, error: "Unrecognized token address (Solana or EVM/Robinhood)" };
    }

    if (!repo.tryLockScan(tokenAddress)) {
      return { ok: false, tokenAddress, error: "Scan already in progress for this token" };
    }

    try {
      repo.upsertToken({ address: tokenAddress });

      let pairs: DexPair[];
      try {
        pairs = await dex.getTokenPairs(tokenAddress, chain);
      } catch (err) {
        const msg =
          err instanceof DexscreenerError ? err.message : "Market data provider failed";
        log.warn("dex_fetch_failed", { tokenAddress, chain, error: msg });
        return { ok: false, tokenAddress, error: msg };
      }

      const selected = selectPrimaryPair(tokenAddress, pairs, chain);
      const now = new Date();
      const mentions = emptyMentions();

      if (!selected) {
        let metrics = deriveMetrics({
          pair: emptyPair(tokenAddress, chain),
          now,
          mentions,
        });

        // No Dexscreener pair yet (fresh / pre-graduation token) — mint-level
        // checks don't need a market, so still worth running.
        let mintRisk: MintRiskSnapshot | null = null;
        let rugCheck: RugCheckSnapshot | null = null;
        let pumpFun: PumpFunSnapshot | null = null;
        if (chain === "solana") {
          if (this.deps.mintRisk) {
            mintRisk = await this.deps.mintRisk.checkSolanaMint(tokenAddress);
          }
          if (this.deps.rugCheck) {
            rugCheck = await this.deps.rugCheck.checkSolanaMint(tokenAddress);
          }
          if (this.deps.pumpFun) {
            pumpFun = await this.deps.pumpFun.checkMint(tokenAddress);
          }
        }

        let score: ScoreResult;
        if (pumpFun?.exists && pumpFun.metrics) {
          metrics = {
            ...metrics,
            bondingProgressPct: pumpFun.metrics.progressPct,
            bondingSolRaised: pumpFun.metrics.solRaised,
            bondingPriceSolPerToken: pumpFun.metrics.priceSolPerToken,
            bondingMarketCapSol: pumpFun.metrics.marketCapSol,
            bondingComplete: pumpFun.metrics.complete,
          };
          score = scoreBondingCurve({ metrics: pumpFun.metrics, config });
        } else {
          score = scoreOpportunity({
            metrics,
            config,
            comparableMetrics: repo.listBaselineMetrics(tokenAddress),
            hasPrimaryPair: false,
          });
        }
        score = applyMintRiskAdjustment(score, mintRisk ? { ...mintRisk } : null, config);
        score = applyRugCheckAdjustment(score, rugCheck, config);

        const scan = repo.insertScan({
          tokenAddress,
          source: input.source,
          metrics,
          score,
          rawPayload: { pairs, chain, mintRisk, rugCheck, pumpFun },
          sentiment: null,
        });

        return {
          ok: true,
          tokenAddress,
          chain,
          scan,
          metrics,
          score,
          pair: null,
          allPairAddresses: pairs.map((p) => p.pairAddress),
          selectionReason: null,
          sentiment: null,
          sentimentNote:
            pumpFun?.exists && pumpFun.metrics
              ? "Pre-graduation pump.fun token — sentiment engine needs a Dexscreener pair"
              : `No primary ${chain} pool — sentiment skipped`,
        };
      }

      const { pair, reason } = selected;
      const meta = tokenMeta(tokenAddress, pair);
      const quote = quoteSymbolForToken(tokenAddress, pair);

      repo.upsertToken({
        address: tokenAddress,
        name: meta.name,
        symbol: meta.symbol,
        pairAddress: pair.pairAddress,
        dexId: pair.dexId,
        quoteAsset: quote,
      });

      const metrics = deriveMetrics({ pair, now, mentions });
      let score = scoreOpportunity({
        metrics,
        config,
        comparableMetrics: repo.listBaselineMetrics(tokenAddress),
        hasPrimaryPair: true,
      });

      const { sentiment, sentimentNote } = await this.fetchSentiment({
        chain,
        tokenAddress,
        pairAddress: pair.pairAddress,
        priceUsd: metrics.priceUsd,
      });

      if (sentiment) {
        score = applySentimentAdjustment(
          score,
          {
            verdict: sentiment.verdict as "WEAK" | "NEUTRAL" | "CONSTRUCTIVE" | "STRONG",
            confidence: sentiment.confidence as "insufficient" | "provisional" | "normal",
          },
          config,
        );
      } else {
        score = applySentimentAdjustment(score, null, config);
      }

      let mintRisk: MintRiskSnapshot | null = null;
      let rugCheck: RugCheckSnapshot | null = null;
      let birdeye: BirdeyeSnapshot | null = null;
      if (chain === "solana") {
        if (this.deps.mintRisk) {
          mintRisk = await this.deps.mintRisk.checkSolanaMint(tokenAddress);
        }
        if (this.deps.rugCheck) {
          rugCheck = await this.deps.rugCheck.checkSolanaMint(tokenAddress);
        }
        // Birdeye's free tier has a tight monthly quota — spend it on the
        // baseline scan/watch only, not on every scheduled follow-up.
        if (this.deps.birdeye && input.source !== "followup") {
          birdeye = await this.deps.birdeye.checkSolanaToken(tokenAddress);
        }
      }
      score = applyMintRiskAdjustment(
        score,
        mintRisk ? { ...mintRisk } : null,
        config,
      );
      score = applyRugCheckAdjustment(score, rugCheck, config);
      score = applyBirdeyeAdjustment(score, birdeye, config);

      const scan = repo.insertScan({
        tokenAddress,
        source: input.source,
        pairAddress: pair.pairAddress,
        dexId: pair.dexId,
        quoteAsset: quote,
        pairUrl: pair.url,
        rawPayload: {
          pairs,
          chain,
          selectedPair: pair.pairAddress,
          selectionReason: reason,
          marketScore: score.baseTotal,
          sentimentAdjustment: score.sentimentAdjustment,
          mintRisk,
          rugCheck,
          birdeye,
        },
        metrics,
        score,
        sentiment,
      });

      if (input.scheduleFollowups !== false && input.source !== "followup") {
        repo.scheduleFollowups({
          tokenAddress,
          baselineScanId: scan.id,
          baselineAt: now,
          horizons: config.followupHorizons,
        });
      }

      if (
        input.source === "organic" &&
        score.total >= config.autoWatchMinScore &&
        score.dataQuality !== "critical"
      ) {
        repo.addWatch(tokenAddress);
      }

      return {
        ok: true,
        tokenAddress,
        chain,
        scan,
        metrics,
        score,
        pair,
        allPairAddresses: pairs.map((p) => p.pairAddress),
        selectionReason: reason,
        sentiment,
        sentimentNote,
      };
    } finally {
      repo.unlockScan(tokenAddress);
    }
  }

  private async fetchSentiment(input: {
    chain: MarketChain;
    tokenAddress: string;
    pairAddress: string;
    priceUsd: number | null;
  }): Promise<{ sentiment: SentimentSnapshot | null; sentimentNote: string | null }> {
    const onchain = this.deps.onchain;
    if (!onchain || !onchain.supportedChains().includes(input.chain)) {
      return {
        sentiment: null,
        sentimentNote: `On-chain sentiment not configured for ${input.chain}`,
      };
    }

    const windowMinutes = this.deps.sentimentWindowMinutes ?? 15;
    try {
      const outcome = await onchain.analyze({
        chain: input.chain,
        address: input.tokenAddress,
        windowMinutes,
        priceUsd: input.priceUsd,
        marketAddress: input.pairAddress,
      });
      if (!outcome.ok) {
        this.deps.log.info("scan_sentiment_skipped", {
          tokenAddress: input.tokenAddress,
          chain: input.chain,
          code: outcome.code,
          error: outcome.error,
        });
        return { sentiment: null, sentimentNote: outcome.error };
      }
      return { sentiment: toSentimentSnapshot(outcome), sentimentNote: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log.warn("scan_sentiment_failed", {
        tokenAddress: input.tokenAddress,
        chain: input.chain,
        error: msg,
      });
      return { sentiment: null, sentimentNote: "On-chain sentiment failed" };
    }
  }
}

function emptyPair(tokenAddress: string, chain: MarketChain): DexPair {
  return {
    chainId: chain,
    dexId: "unknown",
    pairAddress: "",
    url: "",
    baseToken: { address: tokenAddress, name: "UNKNOWN", symbol: "UNKNOWN" },
    quoteToken: { address: "", name: "", symbol: "" },
    priceUsd: null,
  };
}
