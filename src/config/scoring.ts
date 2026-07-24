import { readFileSync } from "node:fs";
import { z } from "zod";

const cohortSchema = z.object({
  id: z.string(),
  maxAgeMinutes: z.number().nullable(),
});

export const scoringConfigSchema = z.object({
  version: z.string(),
  weights: z.object({
    marketQuality: z.number(),
    marketActivity: z.number(),
    attention: z.number(),
    relativeValue: z.number(),
  }),
  marketQuality: z.object({
    minLiquidityUsd: z.number(),
    goodLiquidityUsd: z.number(),
    minLiquidityToMcap: z.number(),
    goodLiquidityToMcap: z.number(),
    minPairAgeMinutes: z.number(),
    maturePairAgeMinutes: z.number(),
  }),
  marketActivity: z.object({
    minTxns1h: z.number(),
    goodTxns1h: z.number(),
    minBuySellRatio: z.number(),
    goodBuySellRatio: z.number(),
    minVolumeToLiquidity: z.number(),
    goodVolumeToLiquidity: z.number(),
    extremePriceChange1hPct: z.number(),
  }),
  momentum: z.object({
    minVolumeToMcap1h: z.number(),
    goodVolumeToMcap1h: z.number(),
  }),
  relativeValue: z.object({
    provisionalUntilComparableScans: z.number(),
    goodVolumeToMcap1h: z.number(),
  }),
  penalties: z.object({
    lowLiquidity: z.number(),
    extremePriceExpansion: z.number(),
    veryYoungPair: z.number(),
    sellImbalance: z.number(),
    extremeVolumeToLiquidity: z.number(),
    incompleteMarketData: z.number(),
  }),
  verdicts: z.object({
    ignoreMax: z.number(),
    watchMax: z.number(),
    investigateMax: z.number(),
  }),
  sentimentAdjustment: z
    .object({
      strong: z.number(),
      constructive: z.number(),
      neutral: z.number(),
      weak: z.number(),
      provisionalMaxAbs: z.number().nonnegative(),
      insufficientMaxAbs: z.number().nonnegative(),
    })
    .optional(),
  mintRisk: z
    .object({
      mintAuthorityActivePenalty: z.number().nonnegative(),
      freezeAuthorityActivePenalty: z.number().nonnegative(),
    })
    .optional(),
  rugcheck: z
    .object({
      minScore: z.number(),
      maxTopHoldersPct: z.number(),
      requireLpLocked: z.boolean(),
      lowScorePenalty: z.number().nonnegative(),
      unlockedLpPenalty: z.number().nonnegative(),
      highConcentrationPenalty: z.number().nonnegative(),
    })
    .optional(),
  birdeye: z
    .object({
      maxCreatorHoldingPct: z.number(),
      minHolders: z.number().nonnegative(),
      creatorHoldingPenalty: z.number().nonnegative(),
      lowHolderPenalty: z.number().nonnegative(),
    })
    .optional(),
  bondingCurve: z
    .object({
      sweetSpotMinPct: z.number(),
      sweetSpotMaxPct: z.number(),
      progressWeight: z.number().nonnegative(),
      raiseWeight: z.number().nonnegative(),
      fullRaiseSol: z.number().positive(),
      maxVerdict: z.enum(["IGNORE", "WATCH", "INVESTIGATE", "HIGH ATTENTION"]),
    })
    .optional(),
  autoWatchMinScore: z.number(),
  recommendMinScore: z.number().default(65),
  followupHorizons: z.array(z.enum(["15m", "1h", "6h", "24h"])),
  cohorts: z.array(cohortSchema),
});

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;
export type FollowupHorizon = ScoringConfig["followupHorizons"][number];

export function loadScoringConfig(path: string): ScoringConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return scoringConfigSchema.parse(raw);
}
