import type { NormalizedSwap, OnchainSentimentMetrics } from "./types.js";

export function analyzeSwaps(input: {
  swaps: NormalizedSwap[];
  now: Date;
  windowMinutes: number;
  truncated?: boolean;
}): OnchainSentimentMetrics {
  const { now, windowMinutes } = input;
  const truncated = input.truncated ?? false;
  const windowMs = windowMinutes * 60_000;
  const currentStart = now.getTime() - windowMs;
  const previousStart = currentStart - windowMs;

  const deduped = dedupeSwaps(input.swaps);
  const current = deduped.filter((swap) => {
    const at = swap.timestamp.getTime();
    return at >= currentStart && at <= now.getTime();
  });
  const previous = deduped.filter((swap) => {
    const at = swap.timestamp.getTime();
    return at >= previousStart && at < currentStart;
  });

  const allBuyers = uniqueWallets(current, "buy");
  const allSellers = uniqueWallets(current, "sell");
  // Wallets on both sides of the book in one window are wash suspects:
  // exclude them from breadth so a single bot can't manufacture "participants".
  const selfTraders = new Set([...allBuyers].filter((wallet) => allSellers.has(wallet)));
  const buyers = new Set([...allBuyers].filter((wallet) => !selfTraders.has(wallet)));
  const sellers = new Set([...allSellers].filter((wallet) => !selfTraders.has(wallet)));

  const previousBuyers = uniqueWallets(previous, "buy");
  const buys = current.filter((swap) => swap.side === "buy");
  const sells = current.filter((swap) => swap.side === "sell");
  const buyTokenVolume = sum(buys.map((swap) => swap.tokenAmount));
  const sellTokenVolume = sum(sells.map((swap) => swap.tokenAmount));
  const buyVolumeUsd = nullableSum(buys.map((swap) => swap.usdValue));
  const sellVolumeUsd = nullableSum(sells.map((swap) => swap.usdValue));

  // A truncated fetch starves the previous window (results arrive newest-first),
  // which fakes acceleration. Refuse to compute growth in that case.
  const buyerGrowth =
    truncated || (buyers.size === 0 && previousBuyers.size === 0)
      ? null
      : (buyers.size - previousBuyers.size) / Math.max(previousBuyers.size, 1);

  return {
    windowMinutes,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    selfTradingWallets: selfTraders.size,
    buyCount: buys.length,
    sellCount: sells.length,
    buyTokenVolume,
    sellTokenVolume,
    buyVolumeUsd,
    sellVolumeUsd,
    netFlowUsd:
      buyVolumeUsd === null || sellVolumeUsd === null
        ? null
        : buyVolumeUsd - sellVolumeUsd,
    buyerSellerRatio: ratio(buyers.size, sellers.size),
    buySellVolumeRatio: ratio(buyTokenVolume, sellTokenVolume),
    buyerGrowth,
    previousUniqueBuyers: previousBuyers.size,
    topFiveBuyerShare: buyerConcentration(buys, buyTokenVolume),
    analyzedSwaps: current.length,
    truncated,
  };
}

function dedupeSwaps(swaps: NormalizedSwap[]): NormalizedSwap[] {
  const seen = new Set<string>();
  return swaps.filter((swap) => {
    if (seen.has(swap.id)) return false;
    seen.add(swap.id);
    return true;
  });
}

function uniqueWallets(swaps: NormalizedSwap[], side: NormalizedSwap["side"]): Set<string> {
  return new Set(swaps.filter((swap) => swap.side === side).map((swap) => swap.wallet));
}

function buyerConcentration(buys: NormalizedSwap[], total: number): number | null {
  if (total <= 0) return null;
  const byWallet = new Map<string, number>();
  for (const buy of buys) {
    byWallet.set(buy.wallet, (byWallet.get(buy.wallet) ?? 0) + buy.tokenAmount);
  }
  const topFive = [...byWallet.values()]
    .sort((a, b) => b - a)
    .slice(0, 5);
  return sum(topFive) / total;
}

function nullableSum(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === values.length ? sum(known) : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * One-sided flow is reported as a capped ratio, not Infinity, so a handful of
 * unopposed buys cannot claim an unbounded signal.
 */
const RATIO_CAP = 5;

function ratio(numerator: number, denominator: number): number | null {
  if (numerator === 0 && denominator === 0) return null;
  if (denominator === 0) return numerator > 0 ? RATIO_CAP : null;
  return Math.min(numerator / denominator, RATIO_CAP);
}
