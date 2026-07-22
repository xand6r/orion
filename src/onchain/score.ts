import type {
  OnchainSentimentFlag,
  OnchainSentimentMetrics,
  OnchainSentimentScore,
} from "./types.js";

export function scoreOnchainSentiment(metrics: OnchainSentimentMetrics): OnchainSentimentScore {
  const breadth = ratioPoints(metrics.buyerSellerRatio, 0.5, 2, 25);
  const volumeBalance = ratioPoints(metrics.buySellVolumeRatio, 0.5, 2, 25);
  const netShare = normalizedNet(metrics.buyTokenVolume, metrics.sellTokenVolume);
  const netFlow = Math.round(((netShare + 1) / 2) * 20);
  const acceleration =
    metrics.buyerGrowth === null
      ? 0
      : Math.round(((clamp(metrics.buyerGrowth, -1, 1) + 1) / 2) * 15);
  const concentration = concentrationPoints(metrics.topFiveBuyerShare, 15);

  const washPenalty = washTradingPenalty(metrics);

  const total = clamp(
    Math.round(breadth + volumeBalance + netFlow + acceleration + concentration - washPenalty),
    0,
    100,
  );

  const confidence =
    metrics.analyzedSwaps < 5
      ? "insufficient"
      : metrics.analyzedSwaps < 20
        ? "provisional"
        : "normal";

  // A verdict is a claim about conviction; thin or incomplete data cannot back
  // a strong claim, whatever the arithmetic says.
  let verdict = verdictFor(total);
  if (confidence === "insufficient") {
    verdict = capVerdict(verdict, "NEUTRAL");
  } else if (confidence === "provisional" || metrics.truncated) {
    verdict = capVerdict(verdict, "CONSTRUCTIVE");
  }

  return {
    total,
    verdict,
    confidence,
    breadth,
    volumeBalance,
    netFlow,
    acceleration,
    concentration,
    flags: flagsFor(metrics, washPenalty),
  };
}

/**
 * Wallets buying and selling in the same window are counted, and when they make
 * up a meaningful share of participants the score is docked.
 */
function washTradingPenalty(metrics: OnchainSentimentMetrics): number {
  const participants =
    metrics.uniqueBuyers + metrics.uniqueSellers + metrics.selfTradingWallets;
  if (participants === 0 || metrics.selfTradingWallets === 0) return 0;
  const share = metrics.selfTradingWallets / participants;
  if (share < 0.2) return 0;
  return share >= 0.5 ? 20 : 10;
}

function ratioPoints(value: number | null, weak: number, strong: number, max: number): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.round(clamp((value - weak) / (strong - weak), 0, 1) * max);
}

function normalizedNet(buys: number, sells: number): number {
  const total = buys + sells;
  return total <= 0 ? -1 : clamp((buys - sells) / total, -1, 1);
}

function concentrationPoints(share: number | null, max: number): number {
  if (share === null) return 0;
  if (share <= 0.25) return max;
  if (share >= 0.8) return 0;
  return Math.round(((0.8 - share) / (0.8 - 0.25)) * max);
}

function flagsFor(metrics: OnchainSentimentMetrics, washPenalty: number): OnchainSentimentFlag[] {
  const flags: OnchainSentimentFlag[] = [];
  if ((metrics.buyerSellerRatio ?? 0) >= 1.5) {
    flags.push({ kind: "green", text: "Unique buyers materially exceed sellers" });
  } else if ((metrics.buyerSellerRatio ?? 1) < 0.75) {
    flags.push({ kind: "red", text: "Unique sellers exceed buyers" });
  }
  if ((metrics.buySellVolumeRatio ?? 0) >= 1.5) {
    flags.push({ kind: "green", text: "Estimated buy flow exceeds sell flow" });
  } else if ((metrics.buySellVolumeRatio ?? 1) < 0.75) {
    flags.push({ kind: "red", text: "Estimated sell flow exceeds buy flow" });
  }
  if ((metrics.buyerGrowth ?? 0) > 0.25) {
    flags.push({ kind: "green", text: "Unique buyer activity is accelerating" });
  } else if ((metrics.buyerGrowth ?? 0) < -0.25) {
    flags.push({ kind: "red", text: "Unique buyer activity is slowing" });
  }
  if (metrics.truncated) {
    flags.push({ kind: "info", text: "Window truncated; acceleration not scored" });
  }
  if (washPenalty > 0) {
    flags.push({ kind: "red", text: "Wallets trading both sides — possible wash activity" });
  }
  if (metrics.topFiveBuyerShare !== null && metrics.topFiveBuyerShare > 0.8) {
    flags.push({ kind: "red", text: "Buy volume is highly concentrated" });
  } else if (metrics.topFiveBuyerShare !== null && metrics.topFiveBuyerShare <= 0.4) {
    flags.push({ kind: "green", text: "Buy volume is broadly distributed" });
  }
  if (metrics.analyzedSwaps < 5) {
    flags.push({ kind: "info", text: "Too few swaps for a reliable signal" });
  }
  return flags.slice(0, 6);
}

const VERDICT_ORDER = ["WEAK", "NEUTRAL", "CONSTRUCTIVE", "STRONG"] as const;

function capVerdict(
  verdict: OnchainSentimentScore["verdict"],
  max: OnchainSentimentScore["verdict"],
): OnchainSentimentScore["verdict"] {
  return VERDICT_ORDER.indexOf(verdict) > VERDICT_ORDER.indexOf(max) ? max : verdict;
}

function verdictFor(total: number): OnchainSentimentScore["verdict"] {
  if (total < 40) return "WEAK";
  if (total < 60) return "NEUTRAL";
  if (total < 80) return "CONSTRUCTIVE";
  return "STRONG";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
