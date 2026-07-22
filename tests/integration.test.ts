import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { openDatabase } from "../src/db/client.js";
import { Repository } from "../src/db/repo.js";
import { DexscreenerClient } from "../src/providers/dexscreener.js";
import { ScanService } from "../src/services/scan.js";
import { FollowupWorker } from "../src/services/followups.js";
import { scoringConfigSchema } from "../src/config/scoring.js";
import { createLogger } from "../src/logger.js";
import { deriveMetrics, emptyMentions } from "../src/metrics/derive.js";
import { scoreOpportunity } from "../src/scoring/engine.js";

const config = scoringConfigSchema.parse(
  JSON.parse(readFileSync(new URL("../config/scoring.v4.json", import.meta.url), "utf8")),
);

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "orion-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.sqlite"));
  return { db, repo: new Repository(db) };
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("repository", () => {
  it("does not retain Telegram identity or message tables", () => {
    const { db, repo } = tempDb();
    repo.upsertToken({ address: USDC });
    repo.addWatch(USDC);
    repo.addNote(USDC, "research note");
    const mentions = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mentions'")
      .get();
    const watch = db.prepare("SELECT created_by FROM watchlist WHERE token_address = ?").get(USDC) as {
      created_by: string | null;
    };
    const note = db.prepare("SELECT author_id FROM notes WHERE token_address = ?").get(USDC) as {
      author_id: string | null;
    };
    expect(mentions).toBeUndefined();
    expect(watch.created_by).toBeNull();
    expect(note.author_id).toBeNull();
    db.close();
  });

  it("returns basic catalog stats", () => {
    const { db, repo } = tempDb();
    repo.upsertToken({ address: USDC, symbol: "USDC" });
    repo.addWatch(USDC);
    repo.addNote(USDC, "note");
    const metrics = deriveMetrics({
      pair: {
        chainId: "solana",
        dexId: "raydium",
        pairAddress: "p",
        url: "https://dexscreener.com/solana/p",
        baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
        quoteToken: { address: "s", name: "SOL", symbol: "SOL" },
        priceUsd: "1",
        liquidity: { usd: 100_000 },
        marketCap: 200_000,
      },
      now: new Date(),
      mentions: emptyMentions(),
    });
    const scored = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: [],
      hasPrimaryPair: true,
    });
    repo.insertScan({
      tokenAddress: USDC,
      source: "manual_scan",
      metrics,
      score: scored,
    });
    const stats = repo.basicStats();
    expect(stats.tokens).toBe(1);
    expect(stats.scans).toBe(1);
    expect(stats.watchesActive).toBe(1);
    expect(stats.notes).toBe(1);
    expect(stats.avgLatestScore).toBe(scored.total);
    expect(stats.latestByVerdict[scored.verdict]).toBe(1);
    db.close();
  });

  it("ranks tokens by latest score and filters viable", () => {
    const { db, repo } = tempDb();
    const other = "So11111111111111111111111111111111111111112";
    repo.upsertToken({ address: USDC, symbol: "USDC" });
    repo.upsertToken({ address: other, symbol: "SOL" });

    const mk = (token: string, total: number, quality: "ok" | "critical" = "ok") => {
      const metrics = deriveMetrics({
        pair: {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "p",
          url: "",
          baseToken: { address: token, name: "T", symbol: "T" },
          quoteToken: { address: "s", name: "SOL", symbol: "SOL" },
          priceUsd: "1",
          liquidity: { usd: 50_000 },
          marketCap: 200_000,
        },
        now: new Date(),
        mentions: emptyMentions(),
      });
      const score = scoreOpportunity({
        metrics,
        config,
        comparableMetrics: [],
        hasPrimaryPair: true,
      });
      score.total = total;
      score.dataQuality = quality;
      repo.insertScan({ tokenAddress: token, source: "manual_scan", metrics, score });
    };

    mk(USDC, 40);
    mk(other, 72);
    mk(USDC, 80); // newer USDC scan should win

    const ranked = repo.rankedByLatestScore({ limit: 10 });
    expect(ranked.map((r) => r.token_address)).toEqual([USDC, other]);
    expect(ranked[0]?.score_total).toBe(80);

    const viable = repo.rankedByLatestScore({ minScore: 65, excludeCritical: true });
    expect(viable).toHaveLength(2);
    expect(viable.every((r) => r.score_total >= 65)).toBe(true);

    db.close();
  });

  it("schedules followups once per baseline+horizon", () => {
    const { db, repo } = tempDb();
    repo.upsertToken({ address: USDC });
    const metrics = deriveMetrics({
      pair: {
        chainId: "solana",
        dexId: "raydium",
        pairAddress: "p",
        url: "",
        baseToken: { address: USDC, name: "USDC", symbol: "USDC" },
        quoteToken: { address: "s", name: "SOL", symbol: "SOL" },
        priceUsd: "1",
        liquidity: { usd: 1_000_000 },
        marketCap: 1_000_000,
      },
      now: new Date(),
      mentions: emptyMentions(),
    });
    const score = scoreOpportunity({
      metrics,
      config,
      comparableMetrics: [],
      hasPrimaryPair: true,
    });
    const scan = repo.insertScan({
      tokenAddress: USDC,
      source: "organic",
      metrics,
      score,
    });
    repo.scheduleFollowups({
      tokenAddress: USDC,
      baselineScanId: scan.id,
      baselineAt: new Date(),
      horizons: config.followupHorizons,
    });
    repo.scheduleFollowups({
      tokenAddress: USDC,
      baselineScanId: scan.id,
      baselineAt: new Date(),
      horizons: config.followupHorizons,
    });

    const laterScan = repo.insertScan({
      tokenAddress: USDC,
      source: "manual_scan",
      metrics,
      score,
    });
    repo.scheduleFollowups({
      tokenAddress: USDC,
      baselineScanId: laterScan.id,
      baselineAt: new Date(),
      horizons: config.followupHorizons,
    });
    expect(repo.getFollowupsForToken(USDC)).toHaveLength(4);
    db.close();
  });
});

describe("dexscreener client", () => {
  it("handles timeout", async () => {
    const client = new DexscreenerClient({
      timeoutMs: 30,
      cacheMs: 0,
      fetchImpl: async (_url, init) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => resolve(), 200);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        return new Response("[]");
      },
    });
    await expect(client.getTokenPairs(USDC)).rejects.toThrow(/timed out/i);
  });

  it("handles malformed JSON body as empty pairs via normalize", async () => {
    const client = new DexscreenerClient({
      timeoutMs: 1000,
      cacheMs: 0,
      fetchImpl: async () =>
        new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    });
    expect(await client.getTokenPairs(USDC)).toEqual([]);
  });

  it("drops malformed pair entries instead of trusting provider shapes", async () => {
    const client = new DexscreenerClient({
      timeoutMs: 1000,
      cacheMs: 0,
      fetchImpl: async () =>
        new Response(JSON.stringify([{ chainId: "solana", liquidity: { usd: "a lot" } }]), {
          status: 200,
        }),
    });
    expect(await client.getTokenPairs(USDC)).toEqual([]);
  });

  it("retries bounded transient provider failures", async () => {
    let calls = 0;
    const client = new DexscreenerClient({
      timeoutMs: 1000,
      cacheMs: 0,
      maxRetries: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("busy", { status: 503 });
        return new Response(
          JSON.stringify([
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "PairABC",
              url: "https://dexscreener.com/solana/PairABC",
              baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
              quoteToken: { address: "SOL", name: "SOL", symbol: "SOL" },
              priceUsd: "1",
              liquidity: { usd: 10_000 },
            },
          ]),
          { status: 200 },
        );
      },
    });

    expect(await client.getTokenPairs(USDC)).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe("scan + followup e2e", () => {
  it("feeds a mocked market response into scan and stores report fields", async () => {
    const { db, repo } = tempDb();
    const log = createLogger("error");

    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          {
            chainId: "solana",
            dexId: "raydium",
            pairAddress: "PairABC",
            url: "https://dexscreener.com/solana/PairABC",
            baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
            quoteToken: {
              address: "So11111111111111111111111111111111111111112",
              name: "SOL",
              symbol: "SOL",
            },
            priceUsd: "1.0",
            liquidity: { usd: 34_000 },
            marketCap: 180_000,
            pairCreatedAt: Date.now() - 23 * 60_000,
            volume: { h1: 96_000 },
            priceChange: { h1: 18 },
            txns: { h1: { buys: 184, sells: 91 } },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const dex = new DexscreenerClient({ timeoutMs: 2000, cacheMs: 0, fetchImpl });
    const scans = new ScanService({ repo, dex, config, log });

    const outcome = await scans.scanToken({
      tokenAddress: USDC,
      source: "organic",
      scheduleFollowups: true,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.score.total).toBeGreaterThan(0);
    expect(outcome.scan.pair_address).toBe("PairABC");
    expect(repo.getFollowupsForToken(USDC)).toHaveLength(4);
    expect(repo.latestScan(USDC)?.verdict).toBeTruthy();

    // Overdue recovery: backdate a followup and process it.
    db.prepare("UPDATE followups SET scheduled_at = ? WHERE horizon = '15m'").run(
      new Date(Date.now() - 60_000).toISOString(),
    );

    const worker = new FollowupWorker({
      repo,
      scans,
      log,
      pollMs: 60_000,
    });
    const n = await worker.tick();
    expect(n).toBeGreaterThanOrEqual(1);
    const done = repo.getFollowupsForToken(USDC).filter((f) => f.completed_at);
    expect(done.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it("notifies allowlisted chats when a follow-up completes", async () => {
    const { db, repo } = tempDb();
    const log = createLogger("error");
    const notified: string[] = [];

    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          {
            chainId: "solana",
            dexId: "raydium",
            pairAddress: "PairABC",
            url: "https://dexscreener.com/solana/PairABC",
            baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
            quoteToken: {
              address: "So11111111111111111111111111111111111111112",
              name: "SOL",
              symbol: "SOL",
            },
            priceUsd: "1.2",
            liquidity: { usd: 34_000 },
            marketCap: 180_000,
            pairCreatedAt: Date.now() - 23 * 60_000,
            volume: { h1: 96_000 },
            priceChange: { h1: 18 },
            txns: { h1: { buys: 184, sells: 91 } },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const dex = new DexscreenerClient({ timeoutMs: 2000, cacheMs: 0, fetchImpl });
    const scans = new ScanService({ repo, dex, config, log });
    await scans.scanToken({
      tokenAddress: USDC,
      source: "manual_scan",
      scheduleFollowups: true,
    });

    // Force baseline price to 1.0 so return is measurable against 1.2 follow-up.
    db.prepare("UPDATE scans SET price_usd = 1.0 WHERE token_address = ?").run(USDC);
    db.prepare("UPDATE followups SET scheduled_at = ? WHERE horizon = '15m'").run(
      new Date(Date.now() - 60_000).toISOString(),
    );

    const worker = new FollowupWorker({
      repo,
      scans,
      log,
      pollMs: 60_000,
      notify: async (html) => {
        notified.push(html);
      },
    });
    await worker.tick();

    expect(notified.length).toBe(1);
    expect(notified[0]).toContain("ORION FOLLOW-UP");
    expect(notified[0]).toContain("15m");
    expect(notified[0]).toContain("Return");

    db.close();
  });

  it("records a vanished pair as an explicit conservative outcome", async () => {
    const { db, repo } = tempDb();
    const log = createLogger("error");
    const baselineMetrics = deriveMetrics({
      pair: {
        chainId: "solana",
        dexId: "raydium",
        pairAddress: "baseline-pair",
        url: "",
        baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
        quoteToken: { address: "SOL", name: "SOL", symbol: "SOL" },
        priceUsd: "1",
        liquidity: { usd: 50_000 },
        marketCap: 1_000_000,
        volume: { h1: 50_000 },
      },
      now: new Date(),
      mentions: emptyMentions(),
    });
    const baselineScore = scoreOpportunity({
      metrics: baselineMetrics,
      config,
      comparableMetrics: [],
      hasPrimaryPair: true,
    });
    repo.upsertToken({ address: USDC });
    const baseline = repo.insertScan({
      tokenAddress: USDC,
      source: "organic",
      pairAddress: "baseline-pair",
      metrics: baselineMetrics,
      score: baselineScore,
    });
    repo.scheduleFollowups({
      tokenAddress: USDC,
      baselineScanId: baseline.id,
      baselineAt: new Date(),
      horizons: config.followupHorizons,
    });
    db.prepare("UPDATE followups SET scheduled_at = ? WHERE horizon = '15m'").run(
      new Date(Date.now() - 60_000).toISOString(),
    );

    const dex = new DexscreenerClient({
      timeoutMs: 1000,
      cacheMs: 0,
      fetchImpl: async () => new Response("[]", { status: 200 }),
    });
    const scans = new ScanService({ repo, dex, config, log });
    const worker = new FollowupWorker({
      repo,
      scans,
      log,
      pollMs: 60_000,
      maxAttempts: 1,
      retryBaseMs: 1,
    });

    await worker.tick();
    const result = repo.getFollowupsForToken(USDC).find((row) => row.horizon === "15m");
    expect(result?.status).toBe("unpriced");
    expect(result?.return_pct).toBe(-100);
    expect(result?.last_error).toMatch(/priced market pair/i);
    db.close();
  });
});
