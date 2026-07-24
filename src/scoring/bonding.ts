import type { ScoringConfig } from "../config/scoring.js";
import type { BondingCurveMetrics } from "../onchain/pumpfun.js";
import {
  capVerdict,
  clamp,
  dedupeFlags,
  verdictFor,
  type ScoreFlag,
  type ScoreResult,
} from "./engine.js";

/**
 * Pre-graduation pump.fun tokens have no Dexscreener pair, no liquidity/mcap,
 * and no scan history to compare against — the entire market-quality/
 * activity/relative-value engine in engine.ts doesn't apply. This is a
 * deliberately narrow, separate scorer: bonding progress (sweet-spot band,
 * not too early/unproven, not too late/already-priced-in) + SOL raised as a
 * demand signal. `dataQuality: "critical"` is used on purpose so the shared
 * applyMintRiskAdjustment/applyRugCheckAdjustment/applyBirdeyeAdjustment
 * pipeline automatically caps the verdict at WATCH downstream, same as any
 * other critically-thin scan.
 */
export function scoreBondingCurve(input: {
  metrics: BondingCurveMetrics;
  config: ScoringConfig;
}): ScoreResult {
  const { metrics, config } = input;
  const cfg = config.bondingCurve;

  const flags: ScoreFlag[] = [
    {
      kind: "red",
      text: "Pre-graduation pump.fun token — provisional bonding-curve score, no scan history",
    },
  ];
  if (metrics.complete) {
    flags.unshift({
      kind: "green",
      text: "Bonding curve shows complete — should have a Raydium/Dexscreener pair shortly",
    });
  }

  const base: ScoreResult = {
    configVersion: config.version,
    marketQuality: 0,
    marketActivity: 0,
    attention: 0,
    relativeValue: 0,
    penalties: 0,
    baseTotal: 0,
    sentimentAdjustment: 0,
    total: 0,
    verdict: "IGNORE",
    provisional: true,
    cohort: "pumpfun-bonding-curve",
    comparableCount: 0,
    flags,
    dataQuality: "critical",
  };

  if (!cfg) {
    return {
      ...base,
      flags: dedupeFlags([...flags, { kind: "red", text: "Bonding-curve scoring not configured" }]),
    };
  }

  const pct = metrics.progressPct;
  let progressScore: number;
  if (pct >= cfg.sweetSpotMinPct && pct <= cfg.sweetSpotMaxPct) {
    progressScore = cfg.progressWeight;
    flags.push({
      kind: "green",
      text: `Bonding progress ${pct.toFixed(1)}% is in the ${cfg.sweetSpotMinPct}-${cfg.sweetSpotMaxPct}% sweet spot`,
    });
  } else if (pct < cfg.sweetSpotMinPct) {
    progressScore = cfg.sweetSpotMinPct > 0 ? cfg.progressWeight * (pct / cfg.sweetSpotMinPct) : 0;
    flags.push({
      kind: "red",
      text: `Bonding progress only ${pct.toFixed(1)}% — below the ${cfg.sweetSpotMinPct}% sweet-spot floor, largely unproven`,
    });
  } else {
    const decayRange = Math.max(1, 100 - cfg.sweetSpotMaxPct);
    const over = pct - cfg.sweetSpotMaxPct;
    progressScore = cfg.progressWeight * Math.max(0, 1 - over / decayRange);
    flags.push({
      kind: "red",
      text: `Bonding progress ${pct.toFixed(1)}% is past the sweet spot — most of the curve move has likely already happened`,
    });
  }

  const raiseRatio = clamp(metrics.solRaised / cfg.fullRaiseSol, 0, 1);
  const raiseScore = cfg.raiseWeight * raiseRatio;
  flags.push({
    kind: raiseRatio >= 0.5 ? "green" : "red",
    text: `${metrics.solRaised.toFixed(2)} SOL raised so far (~${cfg.fullRaiseSol} SOL typically graduates)`,
  });

  const total = clamp(progressScore + raiseScore, 0, 100);
  const verdict = capVerdict(verdictFor(total, config), cfg.maxVerdict);

  return {
    ...base,
    baseTotal: total,
    total,
    verdict,
    flags: dedupeFlags(flags).slice(0, 6),
  };
}
