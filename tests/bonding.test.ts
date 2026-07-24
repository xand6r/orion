import { describe, expect, it } from "vitest";
import { loadScoringConfig } from "../src/config/scoring.js";
import { scoreBondingCurve } from "../src/scoring/bonding.js";
import type { BondingCurveMetrics } from "../src/onchain/pumpfun.js";

const config = loadScoringConfig("config/scoring.v4.json");

function metrics(overrides: Partial<BondingCurveMetrics> = {}): BondingCurveMetrics {
  return {
    progressPct: 0,
    solRaised: 0,
    priceSolPerToken: 0,
    marketCapSol: 0,
    complete: false,
    ...overrides,
  };
}

describe("scoreBondingCurve", () => {
  it("scores low for a fresh, barely-traded curve", () => {
    const result = scoreBondingCurve({ metrics: metrics({ progressPct: 2, solRaised: 0.5 }), config });
    expect(result.total).toBeLessThan(30);
    expect(result.verdict).toBe("IGNORE");
    expect(result.dataQuality).toBe("critical");
    expect(result.cohort).toBe("pumpfun-bonding-curve");
    expect(result.flags.some((f) => f.text.includes("below the"))).toBe(true);
  });

  it("scores well for a mid-progress curve with a healthy raise", () => {
    const cfg = config.bondingCurve;
    expect(cfg).toBeDefined();
    const midPct = ((cfg?.sweetSpotMinPct ?? 0) + (cfg?.sweetSpotMaxPct ?? 100)) / 2;
    const result = scoreBondingCurve({
      metrics: metrics({ progressPct: midPct, solRaised: (cfg?.fullRaiseSol ?? 85) * 0.6 }),
      config,
    });
    expect(result.total).toBeGreaterThan(50);
    expect(result.flags.some((f) => f.text.includes("sweet spot") && f.kind === "green")).toBe(
      true,
    );
  });

  it("decays score for a curve past the sweet spot (about to graduate)", () => {
    const cfg = config.bondingCurve;
    const result = scoreBondingCurve({
      metrics: metrics({ progressPct: 99, solRaised: cfg?.fullRaiseSol ?? 85 }),
      config,
    });
    expect(result.flags.some((f) => f.text.includes("past the sweet spot"))).toBe(true);
  });

  it("never exceeds the configured maxVerdict cap", () => {
    const cfg = config.bondingCurve;
    const midPct = ((cfg?.sweetSpotMinPct ?? 0) + (cfg?.sweetSpotMaxPct ?? 100)) / 2;
    const result = scoreBondingCurve({
      metrics: metrics({ progressPct: midPct, solRaised: cfg?.fullRaiseSol ?? 85 }),
      config,
    });
    const order = ["IGNORE", "WATCH", "INVESTIGATE", "HIGH ATTENTION"];
    expect(order.indexOf(result.verdict)).toBeLessThanOrEqual(order.indexOf(cfg?.maxVerdict ?? "INVESTIGATE"));
  });

  it("flags a completed curve distinctly", () => {
    const result = scoreBondingCurve({ metrics: metrics({ progressPct: 100, complete: true }), config });
    expect(result.flags.some((f) => f.text.includes("complete") && f.kind === "green")).toBe(true);
  });
});
