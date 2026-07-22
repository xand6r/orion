import type { ScoringConfig } from "../config/scoring.js";
import type { DerivedMetrics } from "../metrics/derive.js";

export type Verdict = "IGNORE" | "WATCH" | "INVESTIGATE" | "HIGH ATTENTION";

export type ScoreFlag = {
  kind: "green" | "red";
  text: string;
};

export type ScoreResult = {
  configVersion: string;
  marketQuality: number;
  marketActivity: number;
  attention: number;
  relativeValue: number;
  penalties: number;
  /** Market-only total before on-chain sentiment adjustment. */
  baseTotal: number;
  /** Points added/subtracted from sentiment (0 when missing/insufficient). */
  sentimentAdjustment: number;
  total: number;
  verdict: Verdict;
  provisional: boolean;
  cohort: string;
  comparableCount: number;
  flags: ScoreFlag[];
  dataQuality: "ok" | "incomplete" | "critical";
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Linear ramp: 0 points at or below `min`, full `weight` at or above `good`.
 * Below-usable inputs earn nothing — no partial credit for junk.
 */
function ramp(value: number | null, min: number, good: number, weight: number): number {
  if (value === null || value <= min) return 0;
  if (value >= good) return weight;
  return weight * ((value - min) / (good - min));
}

function cohortId(pairAgeMinutes: number | null, config: ScoringConfig): string {
  if (pairAgeMinutes === null) return "unknown";
  for (const c of config.cohorts) {
    if (c.maxAgeMinutes === null) return c.id;
    if (pairAgeMinutes < c.maxAgeMinutes) return c.id;
  }
  return config.cohorts[config.cohorts.length - 1]?.id ?? "unknown";
}

export function scoreOpportunity(input: {
  metrics: DerivedMetrics;
  config: ScoringConfig;
  comparableMetrics: DerivedMetrics[];
  hasPrimaryPair: boolean;
}): ScoreResult {
  const { metrics: m, config, comparableMetrics, hasPrimaryPair } = input;
  const flags: ScoreFlag[] = [];
  let penalties = 0;
  let dataQuality: ScoreResult["dataQuality"] = "ok";

  // --- Market quality: is there enough real liquidity to enter and exit? ---
  let marketQuality = 0;
  if (!hasPrimaryPair) {
    dataQuality = "critical";
    flags.push({ kind: "red", text: "No usable market pair found" });
  } else {
    marketQuality += ramp(
      m.liquidityUsd,
      0,
      config.marketQuality.goodLiquidityUsd,
      12,
    );
    marketQuality += ramp(
      m.liquidityToMarketCap,
      config.marketQuality.minLiquidityToMcap,
      config.marketQuality.goodLiquidityToMcap,
      8,
    );
    marketQuality += ramp(
      m.pairAgeMinutes,
      config.marketQuality.minPairAgeMinutes,
      config.marketQuality.maturePairAgeMinutes,
      5,
    );
    marketQuality = clamp(marketQuality, 0, config.weights.marketQuality);

    if (
      m.liquidityToMarketCap !== null &&
      m.liquidityToMarketCap >= config.marketQuality.goodLiquidityToMcap
    ) {
      flags.push({
        kind: "green",
        text: `Liquidity is ${(m.liquidityToMarketCap * 100).toFixed(1)}% of market cap`,
      });
    }
  }

  // --- Market activity: are trades actually happening right now? ---
  const txns1h = m.buys1h !== null && m.sells1h !== null ? m.buys1h + m.sells1h : null;

  let marketActivity = 0;
  marketActivity += ramp(
    txns1h,
    config.marketActivity.minTxns1h,
    config.marketActivity.goodTxns1h,
    10,
  );
  marketActivity += ramp(
    m.buySellRatio1h,
    config.marketActivity.minBuySellRatio,
    config.marketActivity.goodBuySellRatio,
    8,
  );
  marketActivity += ramp(
    m.volume1hToLiquidity,
    config.marketActivity.minVolumeToLiquidity,
    config.marketActivity.goodVolumeToLiquidity,
    7,
  );
  marketActivity = clamp(marketActivity, 0, config.weights.marketActivity);

  if (
    m.volume1hToLiquidity !== null &&
    m.volume1hToLiquidity >= config.marketActivity.goodVolumeToLiquidity
  ) {
    flags.push({ kind: "green", text: "Volume and flow look active vs liquidity" });
  }

  // --- Momentum: is money flowing in relative to size? (stored in the attention column) ---
  // Deliberately does not re-count txns or buy/sell ratio — those live in activity.
  let attention = 0;
  attention += ramp(
    m.volume1hToMarketCap,
    config.momentum.minVolumeToMcap1h,
    config.momentum.goodVolumeToMcap1h,
    18,
  );
  if (m.priceChange1hPct !== null && m.priceChange1hPct > 0) {
    attention += Math.min(7, m.priceChange1hPct / 10);
  }
  attention = clamp(attention, 0, config.weights.attention);

  if (
    m.volume1hToMarketCap !== null &&
    m.volume1hToMarketCap >= config.momentum.goodVolumeToMcap1h &&
    (m.priceChange1hPct ?? 0) > 0
  ) {
    flags.push({ kind: "green", text: "Market momentum is strong vs capitalization" });
  }

  // --- Relative value: how does this token rank inside its age cohort? ---
  const cohort = cohortId(m.pairAgeMinutes, config);
  const cohortComparables = comparableMetrics.filter(
    (candidate) =>
      cohortId(candidate.pairAgeMinutes, config) === cohort &&
      candidate.volume1hToMarketCap !== null,
  );
  const provisional =
    cohortComparables.length < config.relativeValue.provisionalUntilComparableScans;

  let relativeValue = 0;
  relativeValue += ramp(
    m.volume1hToMarketCap,
    0,
    config.relativeValue.goodVolumeToMcap1h,
    15,
  );
  if (!provisional) {
    const volumeRank = percentileRank(
      m.volume1hToMarketCap,
      cohortComparables.map((candidate) => candidate.volume1hToMarketCap as number),
    );
    if (volumeRank !== null) relativeValue += volumeRank * 10;
  }
  relativeValue = clamp(relativeValue, 0, config.weights.relativeValue);

  // --- Penalties / warnings ---
  if (m.liquidityUsd !== null && m.liquidityUsd < config.marketQuality.minLiquidityUsd) {
    penalties += config.penalties.lowLiquidity;
    flags.push({ kind: "red", text: "Liquidity below usable threshold" });
  }

  if (
    m.priceChange1hPct !== null &&
    m.priceChange1hPct >= config.marketActivity.extremePriceChange1hPct
  ) {
    penalties += config.penalties.extremePriceExpansion;
    flags.push({ kind: "red", text: "Price has already expanded recently" });
  }

  if (m.pairAgeMinutes !== null && m.pairAgeMinutes < config.marketQuality.minPairAgeMinutes) {
    penalties += config.penalties.veryYoungPair;
    flags.push({ kind: "red", text: "Pair is very young — data is thin" });
  }

  if (m.buySellRatio1h !== null && m.buySellRatio1h < 0.7) {
    penalties += config.penalties.sellImbalance;
    flags.push({ kind: "red", text: "Sell imbalance in the last hour" });
  }

  if (m.volume1hToLiquidity !== null && m.volume1hToLiquidity > 8) {
    penalties += config.penalties.extremeVolumeToLiquidity;
    flags.push({ kind: "red", text: "Volume extreme vs liquidity — treat carefully" });
  }

  const missingCore =
    !hasPrimaryPair ||
    m.liquidityUsd === null ||
    m.marketCapUsd === null ||
    m.priceUsd === null ||
    m.volume1hUsd === null;

  if (missingCore) {
    penalties += config.penalties.incompleteMarketData;
    if (dataQuality !== "critical") dataQuality = "incomplete";
    flags.push({ kind: "red", text: "Incomplete market data" });
  }

  // Always remind: holder/deployer checks are out of POC scope.
  flags.push({
    kind: "red",
    text: "Holder/deployer/mint risk not checked",
  });

  const raw = marketQuality + marketActivity + attention + relativeValue - penalties;
  const baseTotal = clamp(Math.round(raw), 0, 100);

  // Verdict caps: a score is only actionable when the data and exit path exist.
  // Critical data or sub-usable liquidity → never above WATCH.
  // Incomplete data → never above INVESTIGATE.
  let verdict = verdictFor(baseTotal, config);
  const liquidityUnusable =
    m.liquidityUsd === null || m.liquidityUsd < config.marketQuality.minLiquidityUsd;
  if (dataQuality === "critical" || liquidityUnusable) {
    verdict = capVerdict(verdict, "WATCH");
  } else if (dataQuality === "incomplete") {
    verdict = capVerdict(verdict, "INVESTIGATE");
  }

  return {
    configVersion: config.version,
    marketQuality: Math.round(marketQuality),
    marketActivity: Math.round(marketActivity),
    attention: Math.round(attention),
    relativeValue: Math.round(relativeValue),
    penalties: Math.round(penalties),
    baseTotal,
    sentimentAdjustment: 0,
    total: baseTotal,
    verdict,
    provisional,
    cohort,
    comparableCount: cohortComparables.length,
    flags: dedupeFlags(flags).slice(0, 6),
    dataQuality,
  };
}

export type SentimentAdjustmentInput = {
  verdict: "WEAK" | "NEUTRAL" | "CONSTRUCTIVE" | "STRONG";
  confidence: "insufficient" | "provisional" | "normal";
};

/**
 * Apply on-chain sentiment as a capped adjustment to the market score.
 * Missing/insufficient → no change. Provisional → tiny clamp. Critical market
 * data never receives a positive boost.
 */
export function applySentimentAdjustment(
  score: ScoreResult,
  sentiment: SentimentAdjustmentInput | null,
  config: ScoringConfig,
): ScoreResult {
  const cfg = config.sentimentAdjustment;
  if (!cfg || !sentiment) {
    return { ...score, baseTotal: score.baseTotal ?? score.total, sentimentAdjustment: 0, total: score.total };
  }

  let adj =
    sentiment.verdict === "STRONG"
      ? cfg.strong
      : sentiment.verdict === "CONSTRUCTIVE"
        ? cfg.constructive
        : sentiment.verdict === "WEAK"
          ? cfg.weak
          : cfg.neutral;

  if (sentiment.confidence === "insufficient") {
    adj = clamp(adj, -cfg.insufficientMaxAbs, cfg.insufficientMaxAbs);
  } else if (sentiment.confidence === "provisional") {
    adj = clamp(adj, -cfg.provisionalMaxAbs, cfg.provisionalMaxAbs);
  }

  if (score.dataQuality === "critical" || score.dataQuality === "incomplete") {
    adj = Math.min(adj, 0);
  }

  const baseTotal = score.baseTotal ?? score.total;
  const total = clamp(baseTotal + adj, 0, 100);
  let verdict = verdictFor(total, config);
  if (score.dataQuality === "critical") {
    verdict = capVerdict(verdict, "WATCH");
  } else if (score.dataQuality === "incomplete") {
    verdict = capVerdict(verdict, "INVESTIGATE");
  }

  const flags = [...score.flags];
  if (adj !== 0) {
    flags.unshift({
      kind: adj > 0 ? "green" : "red",
      text: `Sentiment ${sentiment.verdict.toLowerCase()} adjusted score by ${adj > 0 ? "+" : ""}${adj}`,
    });
  }

  return {
    ...score,
    baseTotal,
    sentimentAdjustment: adj,
    total,
    verdict,
    flags: dedupeFlags(flags).slice(0, 6),
  };
}

const VERDICT_ORDER: Verdict[] = ["IGNORE", "WATCH", "INVESTIGATE", "HIGH ATTENTION"];

function capVerdict(verdict: Verdict, max: Verdict): Verdict {
  return VERDICT_ORDER.indexOf(verdict) > VERDICT_ORDER.indexOf(max) ? max : verdict;
}

function percentileRank(value: number | null, samples: number[]): number | null {
  if (value === null || samples.length === 0) return null;
  const atOrBelow = samples.filter((sample) => sample <= value).length;
  return atOrBelow / samples.length;
}

function verdictFor(total: number, config: ScoringConfig): Verdict {
  if (total <= config.verdicts.ignoreMax) return "IGNORE";
  if (total <= config.verdicts.watchMax) return "WATCH";
  if (total <= config.verdicts.investigateMax) return "INVESTIGATE";
  return "HIGH ATTENTION";
}

function dedupeFlags(flags: ScoreFlag[]): ScoreFlag[] {
  const seen = new Set<string>();
  const out: ScoreFlag[] = [];
  for (const f of flags) {
    const key = `${f.kind}:${f.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function cohortForAge(pairAgeMinutes: number | null, config: ScoringConfig): string {
  return cohortId(pairAgeMinutes, config);
}
