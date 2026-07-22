import type Database from "better-sqlite3";
import type { FollowupHorizon } from "../config/scoring.js";
import type { DerivedMetrics } from "../metrics/derive.js";
import type { ScoreResult } from "../scoring/engine.js";
import type { SentimentSnapshot } from "../onchain/snapshot.js";

export type TokenRow = {
  address: string;
  name: string | null;
  symbol: string | null;
  first_seen_at: string;
  last_seen_at: string;
  pair_address: string | null;
  dex_id: string | null;
  quote_asset: string | null;
};

export type ScanRow = {
  id: number;
  token_address: string;
  scanned_at: string;
  source: string;
  pair_address: string | null;
  dex_id: string | null;
  quote_asset: string | null;
  pair_url: string | null;
  raw_payload: string | null;
  metrics_json: string;
  score_quality: number;
  score_activity: number;
  score_attention: number;
  score_value: number;
  score_penalties: number;
  score_total: number;
  verdict: string;
  provisional: number;
  data_quality: string;
  flags_json: string;
  config_version: string;
  price_usd: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  sentiment_json: string | null;
  sentiment_score: number | null;
  sentiment_verdict: string | null;
};

export type FollowupRow = {
  id: number;
  token_address: string;
  baseline_scan_id: number;
  horizon: FollowupHorizon;
  scheduled_at: string;
  completed_at: string | null;
  price_usd: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  score_total: number | null;
  return_pct: number | null;
  status: "pending" | "completed" | "unpriced" | "failed";
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  sentiment_json: string | null;
  sentiment_score: number | null;
  sentiment_verdict: string | null;
};

function iso(d: Date = new Date()): string {
  return d.toISOString();
}

export class Repository {
  constructor(private readonly db: Database.Database) {}

  upsertToken(input: {
    address: string;
    name?: string | null;
    symbol?: string | null;
    pairAddress?: string | null;
    dexId?: string | null;
    quoteAsset?: string | null;
    seenAt?: Date;
  }): void {
    const at = iso(input.seenAt ?? new Date());
    this.db
      .prepare(
        `
INSERT INTO tokens (address, name, symbol, first_seen_at, last_seen_at, pair_address, dex_id, quote_asset)
VALUES (@address, @name, @symbol, @at, @at, @pairAddress, @dexId, @quoteAsset)
ON CONFLICT(address) DO UPDATE SET
  name = COALESCE(excluded.name, tokens.name),
  symbol = COALESCE(excluded.symbol, tokens.symbol),
  last_seen_at = excluded.last_seen_at,
  pair_address = COALESCE(excluded.pair_address, tokens.pair_address),
  dex_id = COALESCE(excluded.dex_id, tokens.dex_id),
  quote_asset = COALESCE(excluded.quote_asset, tokens.quote_asset)
`,
      )
      .run({
        address: input.address,
        name: input.name ?? null,
        symbol: input.symbol ?? null,
        at,
        pairAddress: input.pairAddress ?? null,
        dexId: input.dexId ?? null,
        quoteAsset: input.quoteAsset ?? null,
      });
  }

  getToken(address: string): TokenRow | null {
    return (
      (this.db.prepare("SELECT * FROM tokens WHERE address = ?").get(address) as
        | TokenRow
        | undefined) ?? null
    );
  }

  tryLockScan(tokenAddress: string, ttlMs = 20_000): boolean {
    const now = Date.now();
    const cutoff = new Date(now - ttlMs).toISOString();
    this.db.prepare("DELETE FROM scan_locks WHERE locked_at < ?").run(cutoff);

    try {
      this.db
        .prepare("INSERT INTO scan_locks (token_address, locked_at) VALUES (?, ?)")
        .run(tokenAddress, new Date(now).toISOString());
      return true;
    } catch {
      return false;
    }
  }

  unlockScan(tokenAddress: string): void {
    this.db.prepare("DELETE FROM scan_locks WHERE token_address = ?").run(tokenAddress);
  }

  insertScan(input: {
    tokenAddress: string;
    scannedAt?: Date;
    source: string;
    pairAddress?: string | null;
    dexId?: string | null;
    quoteAsset?: string | null;
    pairUrl?: string | null;
    rawPayload?: unknown;
    metrics: DerivedMetrics;
    score: ScoreResult;
    sentiment?: SentimentSnapshot | null;
  }): ScanRow {
    const scannedAt = iso(input.scannedAt ?? new Date());
    const sentiment = input.sentiment ?? null;
    const result = this.db
      .prepare(
        `
INSERT INTO scans (
  token_address, scanned_at, source, pair_address, dex_id, quote_asset, pair_url, raw_payload,
  metrics_json, score_quality, score_activity, score_attention, score_value, score_penalties,
  score_total, verdict, provisional, data_quality, flags_json, config_version,
  price_usd, market_cap_usd, liquidity_usd,
  sentiment_json, sentiment_score, sentiment_verdict
) VALUES (
  @tokenAddress, @scannedAt, @source, @pairAddress, @dexId, @quoteAsset, @pairUrl, @rawPayload,
  @metricsJson, @scoreQuality, @scoreActivity, @scoreAttention, @scoreValue, @scorePenalties,
  @scoreTotal, @verdict, @provisional, @dataQuality, @flagsJson, @configVersion,
  @priceUsd, @marketCapUsd, @liquidityUsd,
  @sentimentJson, @sentimentScore, @sentimentVerdict
)
`,
      )
      .run({
        tokenAddress: input.tokenAddress,
        scannedAt,
        source: input.source,
        pairAddress: input.pairAddress ?? null,
        dexId: input.dexId ?? null,
        quoteAsset: input.quoteAsset ?? null,
        pairUrl: input.pairUrl ?? null,
        rawPayload: input.rawPayload ? JSON.stringify(input.rawPayload) : null,
        metricsJson: JSON.stringify(input.metrics),
        scoreQuality: input.score.marketQuality,
        scoreActivity: input.score.marketActivity,
        scoreAttention: input.score.attention,
        scoreValue: input.score.relativeValue,
        scorePenalties: input.score.penalties,
        scoreTotal: input.score.total,
        verdict: input.score.verdict,
        provisional: input.score.provisional ? 1 : 0,
        dataQuality: input.score.dataQuality,
        flagsJson: JSON.stringify(input.score.flags),
        configVersion: input.score.configVersion,
        priceUsd: input.metrics.priceUsd,
        marketCapUsd: input.metrics.marketCapUsd,
        liquidityUsd: input.metrics.liquidityUsd,
        sentimentJson: sentiment ? JSON.stringify(sentiment) : null,
        sentimentScore: sentiment?.score ?? null,
        sentimentVerdict: sentiment?.verdict ?? null,
      });

    return this.getScan(Number(result.lastInsertRowid))!;
  }

  getScan(id: number): ScanRow | null {
    return (
      (this.db.prepare("SELECT * FROM scans WHERE id = ?").get(id) as ScanRow | undefined) ?? null
    );
  }

  latestScan(tokenAddress: string): ScanRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM scans WHERE token_address = ? ORDER BY scanned_at DESC, id DESC LIMIT 1")
        .get(tokenAddress) as ScanRow | undefined) ?? null
    );
  }

  firstScan(tokenAddress: string): ScanRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM scans WHERE token_address = ? ORDER BY scanned_at ASC, id ASC LIMIT 1")
        .get(tokenAddress) as ScanRow | undefined) ?? null
    );
  }

  countScans(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM scans").get() as { c: number }).c;
  }

  basicStats(): {
    tokens: number;
    scans: number;
    scansLast24h: number;
    watchesActive: number;
    notes: number;
    followups: {
      pending: number;
      completed: number;
      unpriced: number;
      failed: number;
    };
    latestByVerdict: Record<string, number>;
    avgLatestScore: number | null;
    withSentiment: number;
    firstScanAt: string | null;
    lastScanAt: string | null;
  } {
    const count = (sql: string): number =>
      (this.db.prepare(sql).get() as { c: number }).c;

    const tokens = count("SELECT COUNT(*) AS c FROM tokens");
    const scans = count("SELECT COUNT(*) AS c FROM scans");
    const since24h = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const scansLast24h = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM scans WHERE scanned_at >= ?`)
        .get(since24h) as { c: number }
    ).c;
    const watchesActive = count(
      `SELECT COUNT(*) AS c FROM watchlist WHERE status = 'active'`,
    );
    const notes = count("SELECT COUNT(*) AS c FROM notes");

    const followupRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM followups GROUP BY status`,
      )
      .all() as Array<{ status: string; c: number }>;
    const followups = {
      pending: 0,
      completed: 0,
      unpriced: 0,
      failed: 0,
    };
    for (const row of followupRows) {
      if (row.status in followups) {
        followups[row.status as keyof typeof followups] = row.c;
      }
    }

    const verdictRows = this.db
      .prepare(
        `
SELECT s.verdict, COUNT(*) AS c
FROM scans s
JOIN (
  SELECT token_address, MAX(id) AS max_id
  FROM scans
  GROUP BY token_address
) latest ON latest.max_id = s.id
GROUP BY s.verdict
`,
      )
      .all() as Array<{ verdict: string; c: number }>;
    const latestByVerdict: Record<string, number> = {};
    for (const row of verdictRows) {
      latestByVerdict[row.verdict] = row.c;
    }

    const avgRow = this.db
      .prepare(
        `
SELECT AVG(s.score_total) AS avg_score
FROM scans s
JOIN (
  SELECT token_address, MAX(id) AS max_id
  FROM scans
  GROUP BY token_address
) latest ON latest.max_id = s.id
`,
      )
      .get() as { avg_score: number | null };
    const avgLatestScore =
      avgRow.avg_score === null || !Number.isFinite(avgRow.avg_score)
        ? null
        : avgRow.avg_score;

    const withSentiment = count(
      `SELECT COUNT(*) AS c FROM scans WHERE sentiment_score IS NOT NULL`,
    );

    const range = this.db
      .prepare(
        `SELECT MIN(scanned_at) AS first_at, MAX(scanned_at) AS last_at FROM scans`,
      )
      .get() as { first_at: string | null; last_at: string | null };

    return {
      tokens,
      scans,
      scansLast24h,
      watchesActive,
      notes,
      followups,
      latestByVerdict,
      avgLatestScore,
      withSentiment,
      firstScanAt: range.first_at,
      lastScanAt: range.last_at,
    };
  }

  listBaselineMetrics(excludeTokenAddress: string): DerivedMetrics[] {
    const rows = this.db
      .prepare(
        `
SELECT s.metrics_json
FROM scans s
JOIN (
  SELECT token_address, MIN(baseline_scan_id) AS first_baseline_id
  FROM followups
  WHERE token_address != ?
  GROUP BY token_address
) baselines ON baselines.first_baseline_id = s.id
`,
      )
      .all(excludeTokenAddress) as Array<{ metrics_json: string }>;

    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.metrics_json) as DerivedMetrics];
      } catch {
        return [];
      }
    });
  }

  scheduleFollowups(input: {
    tokenAddress: string;
    baselineScanId: number;
    baselineAt: Date;
    horizons: FollowupHorizon[];
  }): void {
    const offsets: Record<FollowupHorizon, number> = {
      "15m": 15 * 60_000,
      "1h": 60 * 60_000,
      "6h": 6 * 60 * 60_000,
      "24h": 24 * 60 * 60_000,
    };

    const stmt = this.db.prepare(`
INSERT OR IGNORE INTO followups
  (token_address, baseline_scan_id, horizon, scheduled_at)
VALUES (?, ?, ?, ?)
`);

    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT 1 FROM followups WHERE token_address = ? LIMIT 1")
        .get(input.tokenAddress);
      if (existing) return;

      for (const horizon of input.horizons) {
        const scheduled = new Date(input.baselineAt.getTime() + offsets[horizon]).toISOString();
        stmt.run(input.tokenAddress, input.baselineScanId, horizon, scheduled);
      }
    });
    tx();
  }

  dueFollowups(now: Date = new Date(), limit = 20): FollowupRow[] {
    return this.db
      .prepare(
        `
SELECT * FROM followups
WHERE status = 'pending'
  AND COALESCE(next_attempt_at, scheduled_at) <= ?
ORDER BY COALESCE(next_attempt_at, scheduled_at) ASC
LIMIT ?
`,
      )
      .all(iso(now), limit) as FollowupRow[];
  }

  completeFollowup(input: {
    id: number;
    completedAt?: Date;
    priceUsd: number | null;
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    scoreTotal: number | null;
    returnPct: number | null;
    sentiment?: SentimentSnapshot | null;
  }): void {
    const sentiment = input.sentiment ?? null;
    this.db
      .prepare(
        `
UPDATE followups SET
  status = 'completed',
  completed_at = ?,
  price_usd = ?,
  market_cap_usd = ?,
  liquidity_usd = ?,
  score_total = ?,
  return_pct = ?,
  sentiment_json = ?,
  sentiment_score = ?,
  sentiment_verdict = ?,
  next_attempt_at = NULL,
  last_error = NULL
WHERE id = ?
`,
      )
      .run(
        iso(input.completedAt ?? new Date()),
        input.priceUsd,
        input.marketCapUsd,
        input.liquidityUsd,
        input.scoreTotal,
        input.returnPct,
        sentiment ? JSON.stringify(sentiment) : null,
        sentiment?.score ?? null,
        sentiment?.verdict ?? null,
        input.id,
      );
  }

  deferFollowup(input: {
    id: number;
    nextAttemptAt: Date;
    error: string;
  }): void {
    this.db
      .prepare(
        `
UPDATE followups SET
  attempt_count = attempt_count + 1,
  next_attempt_at = ?,
  last_error = ?
WHERE id = ? AND status = 'pending'
`,
      )
      .run(iso(input.nextAttemptAt), input.error, input.id);
  }

  finalizeFollowupIssue(input: {
    id: number;
    status: "unpriced" | "failed";
    error: string;
    returnPct: number | null;
    completedAt?: Date;
  }): void {
    this.db
      .prepare(
        `
UPDATE followups SET
  status = ?,
  attempt_count = attempt_count + 1,
  completed_at = ?,
  return_pct = ?,
  next_attempt_at = NULL,
  last_error = ?
WHERE id = ? AND status = 'pending'
`,
      )
      .run(
        input.status,
        iso(input.completedAt ?? new Date()),
        input.returnPct,
        input.error,
        input.id,
      );
  }

  getFollowupsForToken(tokenAddress: string): FollowupRow[] {
    return this.db
      .prepare(
        `
SELECT * FROM followups
WHERE token_address = ?
ORDER BY baseline_scan_id, scheduled_at
`,
      )
      .all(tokenAddress) as FollowupRow[];
  }

  addWatch(tokenAddress: string): void {
    this.db
      .prepare(
        `
INSERT INTO watchlist (token_address, created_at, created_by, status)
VALUES (?, ?, ?, 'active')
ON CONFLICT(token_address) DO UPDATE SET
  status = 'active',
  created_by = NULL
`,
      )
      .run(tokenAddress, iso(), null);
  }

  getWatch(tokenAddress: string): { token_address: string; status: string } | null {
    return (
      (this.db.prepare("SELECT token_address, status FROM watchlist WHERE token_address = ?").get(
        tokenAddress,
      ) as { token_address: string; status: string } | undefined) ?? null
    );
  }

  addNote(tokenAddress: string, text: string): void {
    this.db
      .prepare(
        `
INSERT INTO notes (token_address, author_id, created_at, text)
VALUES (?, ?, ?, ?)
`,
      )
      .run(tokenAddress, null, iso(), text);
  }

  listNotes(tokenAddress: string, limit = 10): { created_at: string; text: string; author_id: string | null }[] {
    return this.db
      .prepare(
        `
SELECT created_at, text, author_id FROM notes
WHERE token_address = ?
ORDER BY created_at DESC
LIMIT ?
`,
      )
      .all(tokenAddress, limit) as {
      created_at: string;
      text: string;
      author_id: string | null;
    }[];
  }

  /**
   * Latest scan per token, ranked by score.
   * When minScore is set, only rows at/above that score (and non-critical data) are returned.
   */
  rankedByLatestScore(input: {
    minScore?: number | null;
    excludeCritical?: boolean;
    limit?: number;
  } = {}): Array<{
    token_address: string;
    symbol: string | null;
    first_seen_at: string;
    scanned_at: string;
    score_total: number;
    verdict: string;
    data_quality: string;
    market_cap_usd: number | null;
    liquidity_usd: number | null;
    price_usd: number | null;
  }> {
    const limit = input.limit ?? 25;
    const minScore = input.minScore ?? null;
    const excludeCritical = input.excludeCritical ?? minScore !== null;

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (minScore !== null) {
      where.push("s.score_total >= ?");
      params.push(minScore);
    }
    if (excludeCritical) {
      where.push("s.data_quality != 'critical'");
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    return this.db
      .prepare(
        `
SELECT t.address AS token_address,
       t.symbol,
       t.first_seen_at,
       s.scanned_at,
       s.score_total,
       s.verdict,
       s.data_quality,
       s.market_cap_usd,
       s.liquidity_usd,
       s.price_usd
FROM tokens t
JOIN scans s ON s.id = (
  SELECT id FROM scans WHERE token_address = t.address
  ORDER BY scanned_at DESC, id DESC LIMIT 1
)
${whereSql}
ORDER BY s.score_total DESC, s.scanned_at DESC
LIMIT ?
`,
      )
      .all(...params, limit) as Array<{
      token_address: string;
      symbol: string | null;
      first_seen_at: string;
      scanned_at: string;
      score_total: number;
      verdict: string;
      data_quality: string;
      market_cap_usd: number | null;
      liquidity_usd: number | null;
      price_usd: number | null;
    }>;
  }

  topTokens(period: "1h" | "6h" | "24h" | "7d", limit = 10): Array<{
    token_address: string;
    symbol: string | null;
    first_seen_at: string;
    score_total: number;
    verdict: string;
  }> {
    const ms: Record<typeof period, number> = {
      "1h": 60 * 60_000,
      "6h": 6 * 60 * 60_000,
      "24h": 24 * 60 * 60_000,
      "7d": 7 * 24 * 60 * 60_000,
    };
    const since = new Date(Date.now() - ms[period]).toISOString();

    return this.db
      .prepare(
        `
SELECT t.address AS token_address,
       t.symbol,
       t.first_seen_at,
       s.score_total,
       s.verdict
FROM tokens t
JOIN scans s ON s.id = (
  SELECT id FROM scans WHERE token_address = t.address
  ORDER BY scanned_at DESC, id DESC LIMIT 1
)
WHERE t.first_seen_at >= ?
ORDER BY s.score_total DESC, t.first_seen_at DESC
LIMIT ?
`,
      )
      .all(since, limit) as Array<{
      token_address: string;
      symbol: string | null;
      first_seen_at: string;
      score_total: number;
      verdict: string;
    }>;
  }

  evaluationSnapshot(): {
    byBand: Array<{
      band: string;
      n: number;
      medianReturn: number | null;
      meanReturn: number | null;
      pctPositive: number | null;
      measured: number;
      unpriced: number;
      failed: number;
    }>;
  } {
    const rows = this.db
      .prepare(
        `
SELECT s.score_total, f.horizon, f.return_pct, f.status
FROM followups f
JOIN scans s ON s.id = f.baseline_scan_id
WHERE f.status != 'pending'
  AND f.horizon = '24h'
  AND f.baseline_scan_id = (
    SELECT MIN(f2.baseline_scan_id)
    FROM followups f2
    WHERE f2.token_address = f.token_address AND f2.horizon = '24h'
  )
`,
      )
      .all() as Array<{
        score_total: number;
        horizon: string;
        return_pct: number | null;
        status: FollowupRow["status"];
      }>;

    const bands = [
      { band: "0-39", lo: 0, hi: 39 },
      { band: "40-59", lo: 40, hi: 59 },
      { band: "60-79", lo: 60, hi: 79 },
      { band: "80-100", lo: 80, hi: 100 },
    ];

    const byBand = bands.map((b) => {
      const bandRows = rows.filter((r) => r.score_total >= b.lo && r.score_total <= b.hi);
      const vals = bandRows
        .flatMap((r) => (r.return_pct === null ? [] : [r.return_pct]))
        .sort((a, c) => a - c);
      const unpriced = bandRows.filter((r) => r.status === "unpriced").length;
      const failed = bandRows.filter((r) => r.status === "failed").length;
      if (vals.length === 0) {
        return {
          band: b.band,
          n: bandRows.length,
          measured: 0,
          unpriced,
          failed,
          medianReturn: null,
          meanReturn: null,
          pctPositive: null,
        };
      }
      const mean = vals.reduce((a, c) => a + c, 0) / vals.length;
      const mid = Math.floor(vals.length / 2);
      const median =
        vals.length % 2 === 0 ? ((vals[mid - 1] ?? 0) + (vals[mid] ?? 0)) / 2 : (vals[mid] ?? 0);
      const pctPositive = (vals.filter((v) => v > 0).length / vals.length) * 100;
      return {
        band: b.band,
        n: bandRows.length,
        measured: vals.length,
        unpriced,
        failed,
        medianReturn: median,
        meanReturn: mean,
        pctPositive,
      };
    });

    return { byBand };
  }
}
