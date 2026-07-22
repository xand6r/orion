import type {
  OnchainSentimentSuccess,
  OnchainSentimentScore,
  OnchainSentimentMetrics,
} from "./types.js";

/** Compact persisted sentiment for scans / follow-ups / Telegram. */
export type SentimentSnapshot = {
  score: number;
  verdict: string;
  confidence: string;
  breadth: number;
  volumeBalance: number;
  netFlow: number;
  acceleration: number;
  concentration: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  selfTradingWallets: number;
  buyCount: number;
  sellCount: number;
  netFlowUsd: number | null;
  buyerGrowth: number | null;
  topFiveBuyerShare: number | null;
  windowMinutes: number;
  truncated: boolean;
  executionId: string;
};

export function toSentimentSnapshot(result: OnchainSentimentSuccess): SentimentSnapshot {
  return {
    score: result.score.total,
    verdict: result.score.verdict,
    confidence: result.score.confidence,
    breadth: result.score.breadth,
    volumeBalance: result.score.volumeBalance,
    netFlow: result.score.netFlow,
    acceleration: result.score.acceleration,
    concentration: result.score.concentration,
    uniqueBuyers: result.metrics.uniqueBuyers,
    uniqueSellers: result.metrics.uniqueSellers,
    selfTradingWallets: result.metrics.selfTradingWallets,
    buyCount: result.metrics.buyCount,
    sellCount: result.metrics.sellCount,
    netFlowUsd: result.metrics.netFlowUsd,
    buyerGrowth: result.metrics.buyerGrowth,
    topFiveBuyerShare: result.metrics.topFiveBuyerShare,
    windowMinutes: result.metrics.windowMinutes,
    truncated: result.truncated,
    executionId: result.executionId,
  };
}

export function parseSentimentSnapshot(raw: string | null | undefined): SentimentSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SentimentSnapshot;
    if (typeof parsed?.score !== "number" || typeof parsed?.verdict !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Rebuild enough of the full report types when needed (e.g. deep format). */
export function snapshotToScoreParts(s: SentimentSnapshot): Pick<
  OnchainSentimentScore,
  "total" | "verdict" | "confidence" | "breadth" | "volumeBalance" | "netFlow" | "acceleration" | "concentration"
> {
  return {
    total: s.score,
    verdict: s.verdict as OnchainSentimentScore["verdict"],
    confidence: s.confidence as OnchainSentimentScore["confidence"],
    breadth: s.breadth,
    volumeBalance: s.volumeBalance,
    netFlow: s.netFlow,
    acceleration: s.acceleration,
    concentration: s.concentration,
  };
}

export function snapshotMetricsSummary(s: SentimentSnapshot): Pick<
  OnchainSentimentMetrics,
  | "uniqueBuyers"
  | "uniqueSellers"
  | "selfTradingWallets"
  | "buyCount"
  | "sellCount"
  | "netFlowUsd"
  | "buyerGrowth"
  | "topFiveBuyerShare"
  | "windowMinutes"
  | "truncated"
> {
  return {
    uniqueBuyers: s.uniqueBuyers,
    uniqueSellers: s.uniqueSellers,
    selfTradingWallets: s.selfTradingWallets,
    buyCount: s.buyCount,
    sellCount: s.sellCount,
    netFlowUsd: s.netFlowUsd,
    buyerGrowth: s.buyerGrowth,
    topFiveBuyerShare: s.topFiveBuyerShare,
    windowMinutes: s.windowMinutes,
    truncated: s.truncated,
  };
}
