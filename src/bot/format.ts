import type { DerivedMetrics } from "../metrics/derive.js";
import type { ScoreResult } from "../scoring/engine.js";
import type { DexPair } from "../providers/dexscreener.js";
import type { FollowupRow, ScanRow, TokenRow } from "../db/repo.js";
import type { OnchainSentimentSuccess } from "../onchain/types.js";
import {
  parseSentimentSnapshot,
  type SentimentSnapshot,
} from "../onchain/snapshot.js";

const TG_LIMIT = 4096;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

function fmtAge(minutes: number | null): string {
  if (minutes === null) return "?";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(0)}%`;
}

function fmtPriceDelta(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  if (n > 0) return `+${n.toFixed(0)}%`;
  if (n < 0) return `${n.toFixed(0)}%`;
  return "0%";
}

function flagLine(kind: "green" | "red" | "info", text: string): string {
  const prefix = kind === "green" ? "✅" : kind === "red" ? "⚠️" : "•";
  return `${prefix} ${escapeHtml(text)}`;
}

function shortVerdict(verdict: ScoreResult["verdict"]): string {
  switch (verdict) {
    case "IGNORE":
      return "SKIP";
    case "WATCH":
      return "WATCH";
    case "INVESTIGATE":
      return "LOOK";
    case "HIGH ATTENTION":
      return "HIGH";
  }
}

function cohortLabel(cohort: string): string {
  const labels: Record<string, string> = {
    "<1h": "<1h",
    "1-6h": "1–6h",
    "6-24h": "6–24h",
    "1-7d": "1–7d",
    ">7d": ">7d",
    unknown: "?",
  };
  return labels[cohort] ?? cohort;
}

function fmtSigned(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

function fmtNetFlow(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : "−"}${fmtUsd(Math.abs(n))}`;
}

function section(title: string): string {
  return `<b>${title}</b>`;
}

/** Compact on-chain line for /report (full detail stays on /sentiment). */
export function formatSentimentEmbed(
  sentiment: SentimentSnapshot | null,
  note?: string | null,
): string[] {
  if (!sentiment) {
    return note ? ["", `${section("Sentiment")} · ${escapeHtml(note)}`] : [];
  }
  return [
    "",
    `${section("Sentiment")} · <b>${sentiment.score}</b>/100 · ${escapeHtml(sentiment.verdict)}`,
    `Buyers ${sentiment.uniqueBuyers} · Net ${fmtNetFlow(sentiment.netFlowUsd)}`,
  ];
}

/** Market → final blend for /scan (important bits only). */
export function formatScoreBlend(score: ScoreResult): string[] {
  const adj = score.sentimentAdjustment ?? 0;
  const base = score.baseTotal ?? score.total;
  if (adj === 0) {
    return [
      "",
      section("Blend"),
      `Market ${base} · Sentiment — · Final <b>${score.total}</b>/100`,
    ];
  }
  const arrow = adj > 0 ? "📈" : "📉";
  return [
    "",
    section("Blend"),
    `Market ${base} → Final <b>${score.total}</b>/100  ${arrow} sentiment ${adj > 0 ? "+" : ""}${adj}`,
  ];
}

/** Most important baseline → now deltas for follow-up notifications. */
export function formatKeyDeltas(input: {
  baselineMarketScore: number | null;
  followupMarketScore: number | null;
  baselineSentiment: SentimentSnapshot | null;
  followupSentiment: SentimentSnapshot | null;
}): string[] {
  const marketScoreDelta =
    input.baselineMarketScore !== null &&
    input.followupMarketScore !== null &&
    Number.isFinite(input.baselineMarketScore) &&
    Number.isFinite(input.followupMarketScore)
      ? input.followupMarketScore - input.baselineMarketScore
      : null;

  const lines = [
    "",
    section("Deltas"),
    `Market ${input.baselineMarketScore ?? "n/a"} → ${input.followupMarketScore ?? "n/a"} (${fmtSigned(marketScoreDelta)})`,
  ];

  const from = input.baselineSentiment;
  const to = input.followupSentiment;
  if (!from && !to) {
    lines.push("Sentiment —");
    return lines;
  }
  if (!from || !to) {
    lines.push(
      `Sentiment ${from?.score ?? "n/a"} → ${to?.score ?? "n/a"} · ${escapeHtml(to?.verdict ?? from?.verdict ?? "")}`,
    );
    return lines;
  }

  const sentDelta = to.score - from.score;
  const buyersDelta = to.uniqueBuyers - from.uniqueBuyers;
  const netDelta =
    from.netFlowUsd !== null &&
    to.netFlowUsd !== null &&
    Number.isFinite(from.netFlowUsd) &&
    Number.isFinite(to.netFlowUsd)
      ? to.netFlowUsd - from.netFlowUsd
      : null;

  lines.push(
    `Sentiment ${from.score} → ${to.score} (${fmtSigned(sentDelta)}) · ${escapeHtml(from.verdict)} → ${escapeHtml(to.verdict)}`,
    `Buyers ${from.uniqueBuyers} → ${to.uniqueBuyers} (${fmtSigned(buyersDelta)})`,
    `Net ${fmtNetFlow(from.netFlowUsd)} → ${fmtNetFlow(to.netFlowUsd)}${netDelta === null ? "" : ` (${fmtNetFlow(netDelta)})`}`,
  );
  return lines;
}

export function formatScanReport(input: {
  symbol: string;
  metrics: DerivedMetrics;
  score: ScoreResult;
  pair: DexPair | null;
  firstSeenAt?: string | null;
  recommendMinScore?: number;
}): string {
  const { symbol, metrics: m, score, pair, firstSeenAt } = input;
  const recommendMin = input.recommendMinScore ?? 65;
  const sym = escapeHtml(symbol || "TOKEN");
  const recommended = score.total >= recommendMin && score.dataQuality !== "critical";
  const mark = recommended ? "✅" : "⛔";

  let firstSeen = "";
  if (firstSeenAt) {
    const d = new Date(firstSeenAt);
    firstSeen = Number.isFinite(d.getTime())
      ? d.toISOString().slice(11, 16) + " UTC"
      : escapeHtml(firstSeenAt);
  }

  const volToMc =
    m.volume1hToMarketCap === null ? "n/a" : fmtPct(m.volume1hToMarketCap * 100);

  const lines: string[] = [
    `<b>ORION</b>  ·  $${sym}`,
    `<b>${score.total}</b>/100 ${mark}  ·  ${fmtAge(m.pairAgeMinutes)} old  ·  ${shortVerdict(score.verdict)}`,
    recommended
      ? `✅ Recommended (≥${recommendMin})`
      : `⛔ Not recommended (need ≥${recommendMin})`,
    score.provisional ? "Peers: provisional" : "Peers: ready",
    "",
    section("Market"),
    `MC ${fmtUsd(m.marketCapUsd)}  ·  FDV ${fmtUsd(m.fdvUsd)}  ·  Liq ${fmtUsd(m.liquidityUsd)}`,
    `Vol 1h ${fmtUsd(m.volume1hUsd)}  ·  Δ ${fmtPriceDelta(m.priceChange1hPct)}`,
    `Buys/Sells ${m.buys1h ?? "n/a"}/${m.sells1h ?? "n/a"}  ·  Vol/MC ${volToMc}`,
    "",
    section("Score"),
    `Quality ${score.marketQuality}/25  ·  Activity ${score.marketActivity}/25`,
    `Momentum ${score.attention}/25  ·  Value ${score.relativeValue}/25`,
    score.penalties > 0 ? `Penalties −${score.penalties}` : null,
    `Age ${escapeHtml(cohortLabel(score.cohort))}  ·  Peers ${score.comparableCount}`,
    ...formatScoreBlend(score),
  ].filter((line): line is string => line !== null);

  const flags = score.flags.filter(
    (f) => !f.text.toLowerCase().includes("holder/deployer"),
  );
  if (flags.length) {
    lines.push("", section("Flags"));
    for (const f of flags.slice(0, 4)) lines.push(flagLine(f.kind, f.text));
  }

  lines.push("");
  if (pair?.url) {
    lines.push(`🔗 <a href="${escapeHtml(pair.url)}">Dexscreener</a>`);
  }
  if (pair?.dexId) {
    lines.push(`${escapeHtml(pair.dexId)}  ·  <code>${escapeHtml(pair.pairAddress)}</code>`);
  }
  if (firstSeen) {
    lines.push(`First seen ${firstSeen}`);
  }

  return lines.join("\n");
}

export function formatTokenReport(input: {
  token: TokenRow;
  latest: ScanRow;
  first: ScanRow | null;
  followups: FollowupRow[];
  notes: Array<{ created_at: string; text: string }>;
}): string {
  const { token, latest, first, followups, notes } = input;
  const metrics = JSON.parse(latest.metrics_json) as DerivedMetrics;
  const flags = JSON.parse(latest.flags_json) as ScoreResult["flags"];
  const sym = escapeHtml(token.symbol ?? "TOKEN");

  const scoreDelta =
    first && first.id !== latest.id ? latest.score_total - first.score_total : null;

  const lines: string[] = [
    `<b>ORION REPORT</b>  ·  $${sym}  ·  <b>${latest.score_total}</b>/100`,
    `<code>${escapeHtml(token.address)}</code>`,
    "",
    section("Market"),
    `${escapeHtml(latest.verdict)}${
      scoreDelta !== null ? `  ·  since first ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}` : ""
    }`,
    `MC ${fmtUsd(latest.market_cap_usd)}  ·  Liq ${fmtUsd(latest.liquidity_usd)}  ·  Price ${fmtUsd(latest.price_usd)}`,
    `Vol/MC 1h ${fmtPct(metrics.volume1hToMarketCap === null ? null : metrics.volume1hToMarketCap * 100)}`,
    ...formatSentimentEmbed(parseSentimentSnapshot(latest.sentiment_json)),
  ];

  const done = followups.filter((f) => f.status !== "pending");
  if (done.length) {
    lines.push("", section("Follow-ups"));
    for (const f of done) {
      const sent =
        f.sentiment_score === null || f.sentiment_score === undefined
          ? ""
          : `  ·  sent ${f.sentiment_score}`;
      const retEmoji =
        f.return_pct === null || !Number.isFinite(f.return_pct)
          ? "•"
          : f.return_pct > 0
            ? "📈"
            : f.return_pct < 0
              ? "📉"
              : "•";
      lines.push(
        `${retEmoji} ${f.horizon}: ${escapeHtml(f.status)} ${fmtPct(f.return_pct)}  ·  mkt ${f.score_total ?? "n/a"}${sent}`,
      );
    }
  } else {
    const pending = followups.filter((f) => f.status === "pending");
    if (pending.length) {
      lines.push("", `⏳ Pending: ${pending.map((f) => f.horizon).join(", ")}`);
    }
  }

  const usefulFlags = flags.filter(
    (f) => !f.text.toLowerCase().includes("holder/deployer"),
  );
  if (usefulFlags.length) {
    lines.push("", section("Flags"));
    for (const f of usefulFlags.slice(0, 4)) lines.push(flagLine(f.kind, f.text));
  }

  if (notes.length) {
    lines.push("", section("Notes"));
    for (const n of notes.slice(0, 3)) {
      lines.push(`• ${escapeHtml(n.text).slice(0, 120)}`);
    }
  }

  if (latest.pair_url) {
    lines.push("", `🔗 <a href="${escapeHtml(latest.pair_url)}">Dexscreener</a>`);
  }

  return splitTelegram(lines.join("\n"))[0] ?? "";
}

export function formatTop(
  rows: Array<{
    token_address: string;
    symbol: string | null;
    score_total: number;
    verdict: string;
    first_seen_at: string;
  }>,
  period: string,
): string {
  if (!rows.length) {
    return `<b>ORION</b>  ·  TOP ${escapeHtml(period.toUpperCase())}\nNo tokens first-seen in this window.`;
  }

  const lines = [`<b>ORION</b>  ·  🏆 TOP ${escapeHtml(period.toUpperCase())}`, ""];
  rows.forEach((r, i) => {
    const sym = escapeHtml(r.symbol ?? "TOKEN");
    lines.push(`${i + 1}. <b>$${sym}</b>  ·  ${r.score_total}  ·  ${escapeHtml(r.verdict)}`);
    lines.push(`   <code>${escapeHtml(r.token_address)}</code>`);
  });
  return lines.join("\n");
}

export function formatRank(input: {
  rows: Array<{
    token_address: string;
    symbol: string | null;
    score_total: number;
    verdict: string;
    market_cap_usd: number | null;
    liquidity_usd: number | null;
    scanned_at: string;
  }>;
  mode: "rank" | "viable";
  minScore?: number;
}): string {
  const { rows, mode, minScore } = input;
  const title =
    mode === "viable"
      ? `<b>ORION</b>  ·  ✅ VIABLE (≥${minScore ?? 65})`
      : `<b>ORION</b>  ·  📋 RANK`;

  if (!rows.length) {
    return mode === "viable"
      ? `${title}\nNo tokens at/above the recommend threshold yet.`
      : `${title}\nNo scanned tokens in the database yet.`;
  }

  const lines = [title, ""];
  rows.forEach((r, i) => {
    const sym = escapeHtml(r.symbol ?? "TOKEN");
    const badge = r.score_total >= (minScore ?? 65) ? "✅" : "•";
    lines.push(
      `${i + 1}. ${badge} <b>$${sym}</b>  ·  <b>${r.score_total}</b>/100  ·  ${escapeHtml(r.verdict)}`,
    );
    lines.push(`   MC ${fmtUsd(r.market_cap_usd)}  ·  Liq ${fmtUsd(r.liquidity_usd)}`);
    lines.push(`   <code>${escapeHtml(r.token_address)}</code>`);
  });
  return lines.join("\n");
}

export function formatFollowupNotification(input: {
  symbol: string;
  address: string;
  horizon: string;
  status: "completed" | "unpriced" | "failed";
  returnPct: number | null;
  baselineScore: number | null;
  followupScore: number | null;
  baselinePriceUsd: number | null;
  followupPriceUsd: number | null;
  baselineMarketCapUsd: number | null;
  followupMarketCapUsd: number | null;
  baselineLiquidityUsd: number | null;
  followupLiquidityUsd: number | null;
  baselineSentiment?: SentimentSnapshot | null;
  followupSentiment?: SentimentSnapshot | null;
  pairUrl?: string | null;
  error?: string | null;
}): string {
  const sym = escapeHtml(input.symbol || "TOKEN");
  const ret = fmtPct(input.returnPct);
  const retEmoji =
    input.returnPct === null || !Number.isFinite(input.returnPct)
      ? "•"
      : input.returnPct > 0
        ? "📈"
        : input.returnPct < 0
          ? "📉"
          : "•";

  const statusEmoji =
    input.status === "completed" ? "✅" : input.status === "unpriced" ? "⚠️" : "⛔";

  const lines: string[] = [
    `<b>ORION FOLLOW-UP</b>  ·  ${escapeHtml(input.horizon)}  ·  $${sym}`,
    `<code>${escapeHtml(input.address)}</code>`,
    "",
    `${retEmoji} <b>Return ${ret}</b>  ·  ${statusEmoji} ${escapeHtml(input.status)}`,
    `Price ${fmtUsd(input.baselinePriceUsd)} → ${fmtUsd(input.followupPriceUsd)}`,
    `MC ${fmtUsd(input.baselineMarketCapUsd)} → ${fmtUsd(input.followupMarketCapUsd)}`,
    `Liq ${fmtUsd(input.baselineLiquidityUsd)} → ${fmtUsd(input.followupLiquidityUsd)}`,
    ...formatKeyDeltas({
      baselineMarketScore: input.baselineScore,
      followupMarketScore: input.followupScore,
      baselineSentiment: input.baselineSentiment ?? null,
      followupSentiment: input.followupSentiment ?? null,
    }),
  ];

  if (input.error) {
    lines.push("", `⚠️ ${escapeHtml(input.error)}`);
  }

  if (input.pairUrl) {
    lines.push("", `🔗 <a href="${escapeHtml(input.pairUrl)}">Dexscreener</a>`);
  }

  return lines.join("\n");
}

export function formatError(message: string): string {
  return `<b>ORION</b>  ·  ⛔ error\n${escapeHtml(message)}`;
}

export function formatOnchainSentimentReport(result: OnchainSentimentSuccess): string {
  const { metrics: m, score } = result;
  const growth = m.buyerGrowth === null ? "n/a" : fmtPct(m.buyerGrowth * 100);
  const concentration =
    m.topFiveBuyerShare === null ? "n/a" : `${(m.topFiveBuyerShare * 100).toFixed(0)}%`;
  const confidence =
    score.confidence === "normal"
      ? "OK"
      : score.confidence === "provisional"
        ? "thin sample"
        : "too little data";

  const netUsd =
    m.netFlowUsd === null || !Number.isFinite(m.netFlowUsd)
      ? "n/a"
      : `${m.netFlowUsd >= 0 ? "+" : "−"}${fmtUsd(Math.abs(m.netFlowUsd))}`;

  const buyerSeller =
    m.buyerSellerRatio === null ? "n/a" : `${m.buyerSellerRatio.toFixed(2)}x`;
  const buySellVol =
    m.buySellVolumeRatio === null ? "n/a" : `${m.buySellVolumeRatio.toFixed(2)}x`;

  const lines = [
    `<b>ORION SENTIMENT</b>  ·  <b>${score.total}</b>/100  ·  ${escapeHtml(score.verdict)}`,
    `${m.windowMinutes}m  ·  ${escapeHtml(result.chain.toUpperCase())}  ·  ${confidence}`,
    `<code>${escapeHtml(result.address)}</code>`,
    "",
    section("Flow"),
  ];

  if (m.buyVolumeUsd === null || m.sellVolumeUsd === null) {
    lines.push(`Buys/Sells ${m.buyCount}/${m.sellCount} (token-volume scored)`);
    lines.push(
      `Token vol buy/sell ${m.buyTokenVolume.toFixed(0)}/${m.sellTokenVolume.toFixed(0)}`,
    );
  } else {
    lines.push(
      `Buy ${fmtUsd(m.buyVolumeUsd)}  ·  Sell ${fmtUsd(m.sellVolumeUsd)}  ·  Net ${netUsd}`,
    );
    lines.push(`Swaps buy/sell ${m.buyCount}/${m.sellCount}`);
  }

  lines.push(
    `Buyers ${m.uniqueBuyers}  ·  Sellers ${m.uniqueSellers}${m.selfTradingWallets > 0 ? `  ·  Self-traders ${m.selfTradingWallets}` : ""}`,
    `Buyer/seller ${buyerSeller}  ·  Buy/sell vol ${buySellVol}`,
    `Growth ${growth} (prev ${m.previousUniqueBuyers})  ·  Top5 ${concentration}`,
    `Analyzed swaps ${m.analyzedSwaps}`,
    "",
    section("Score parts"),
    `Breadth ${score.breadth}/25 — unique buyers vs sellers`,
    `Volume ${score.volumeBalance}/25 — buy vs sell size`,
    `Flow ${score.netFlow}/20 — net USD (or token) flow`,
    `Acceleration ${score.acceleration}/15 — buyer growth vs prior window`,
    `Distribution ${score.concentration}/15 — top buyer concentration`,
  );

  if (score.flags.length) {
    lines.push("", section("Flags"));
    for (const flag of score.flags) lines.push(flagLine(flag.kind, flag.text));
  }
  if (result.truncated) {
    lines.push(flagLine("red", "Window truncated — sample incomplete"));
  }

  lines.push(
    "",
    `Provider ${escapeHtml(result.provider)}  ·  tx ${result.inspectedTransactions}`,
    result.marketAddress
      ? `Pool <code>${escapeHtml(result.marketAddress)}</code>`
      : "Pool n/a",
    `id <code>${result.executionId.slice(0, 8)}</code>`,
  );
  return lines.join("\n");
}

/** Split long messages on newlines without blowing Telegram's limit. */
export function splitTelegram(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const parts: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > limit) {
      if (buf) parts.push(buf);
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) {
          parts.push(line.slice(i, i + limit));
        }
        buf = "";
      } else {
        buf = line;
      }
    } else {
      buf = next;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}
