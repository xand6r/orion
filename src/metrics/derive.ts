import type { DexPair } from "../providers/dexscreener.js";

export type MentionWindows = {
  m15: number;
  h1: number;
  h6: number;
  h24: number;
  prevM15: number;
  prevH1: number;
  prevH6: number;
  prevH24: number;
  distinctSenders1h: number;
  firstMentionAt: string | null;
};

export type DerivedMetrics = {
  pairAgeMinutes: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  priceUsd: number | null;
  volume1hUsd: number | null;
  volume6hUsd: number | null;
  volume24hUsd: number | null;
  buys1h: number | null;
  sells1h: number | null;
  priceChange1hPct: number | null;
  liquidityToMarketCap: number | null;
  volume1hToLiquidity: number | null;
  volume1hToMarketCap: number | null;
  buySellRatio1h: number | null;
  netBuys1h: number | null;
  mentions15m: number;
  mentions1h: number;
  mentions6h: number;
  mentions24h: number;
  mentionVelocity15m: number | null;
  mentionVelocity1h: number | null;
  distinctSenders1h: number;
  minutesSinceFirstMention: number | null;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function div(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

function velocity(current: number, previous: number): number | null {
  // Absolute delta — rising when current window beats the preceding equivalent window.
  return current - previous;
}

export function deriveMetrics(input: {
  pair: DexPair;
  now: Date;
  mentions: MentionWindows;
}): DerivedMetrics {
  const { pair, now, mentions } = input;

  const liquidityUsd = num(pair.liquidity?.usd);
  const marketCapUsd = num(pair.marketCap);
  const fdvUsd = num(pair.fdv);
  const priceUsd = num(pair.priceUsd);
  const volume1hUsd = num(pair.volume?.h1);
  const volume6hUsd = num(pair.volume?.h6);
  const volume24hUsd = num(pair.volume?.h24);
  const buys1h = num(pair.txns?.h1?.buys);
  const sells1h = num(pair.txns?.h1?.sells);
  const priceChange1hPct = num(pair.priceChange?.h1);

  let pairAgeMinutes: number | null = null;
  if (pair.pairCreatedAt) {
    pairAgeMinutes = Math.max(0, (now.getTime() - pair.pairCreatedAt) / 60_000);
  }

  let minutesSinceFirstMention: number | null = null;
  if (mentions.firstMentionAt) {
    const first = Date.parse(mentions.firstMentionAt);
    if (Number.isFinite(first)) {
      minutesSinceFirstMention = Math.max(0, (now.getTime() - first) / 60_000);
    }
  }

  return {
    pairAgeMinutes,
    liquidityUsd,
    marketCapUsd,
    fdvUsd,
    priceUsd,
    volume1hUsd,
    volume6hUsd,
    volume24hUsd,
    buys1h,
    sells1h,
    priceChange1hPct,
    liquidityToMarketCap: div(liquidityUsd, marketCapUsd),
    volume1hToLiquidity: div(volume1hUsd, liquidityUsd),
    volume1hToMarketCap: div(volume1hUsd, marketCapUsd),
    buySellRatio1h:
      buys1h === null || sells1h === null ? null : buys1h / Math.max(sells1h, 1),
    netBuys1h: buys1h === null || sells1h === null ? null : buys1h - sells1h,
    mentions15m: mentions.m15,
    mentions1h: mentions.h1,
    mentions6h: mentions.h6,
    mentions24h: mentions.h24,
    mentionVelocity15m: velocity(mentions.m15, mentions.prevM15),
    mentionVelocity1h: velocity(mentions.h1, mentions.prevH1),
    distinctSenders1h: mentions.distinctSenders1h,
    minutesSinceFirstMention,
  };
}

export function emptyMentions(): MentionWindows {
  return {
    m15: 0,
    h1: 0,
    h6: 0,
    h24: 0,
    prevM15: 0,
    prevH1: 0,
    prevH6: 0,
    prevH24: 0,
    distinctSenders1h: 0,
    firstMentionAt: null,
  };
}
