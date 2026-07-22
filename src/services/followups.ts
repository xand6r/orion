import type { Logger } from "../logger.js";
import { errorFields } from "../logger.js";
import type { FollowupRow, Repository } from "../db/repo.js";
import type { ScanService } from "./scan.js";
import { formatFollowupNotification } from "../bot/format.js";
import { parseSentimentSnapshot } from "../onchain/snapshot.js";

/**
 * Delayed worker that survives restarts — overdue jobs are picked up on the next tick.
 * On completion (or final unpriced/failed), optionally notifies Telegram with the delta.
 */
export class FollowupWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      repo: Repository;
      scans: ScanService;
      log: Logger;
      pollMs: number;
      maxAttempts?: number;
      retryBaseMs?: number;
      /** Send HTML to allowlisted chats. Optional so tests can omit it. */
      notify?: (html: string) => Promise<void>;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.deps.log.info("followup_worker_started", { pollMs: this.deps.pollMs });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let completed = 0;

    try {
      const due = this.deps.repo.dueFollowups(new Date(), 20);
      for (const job of due) {
        try {
          await this.process(job);
          completed += 1;
        } catch (err) {
          this.deps.log.error("followup_failed", {
            followupId: job.id,
            token: job.token_address,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.running = false;
    }

    return completed;
  }

  private async process(job: FollowupRow): Promise<void> {
    const followupId = job.id;
    const tokenAddress = job.token_address;
    const baseline = this.deps.repo.getScan(job.baseline_scan_id);
    if (!baseline) {
      this.deps.repo.finalizeFollowupIssue({
        id: followupId,
        status: "failed",
        error: "Baseline scan no longer exists",
        returnPct: null,
      });
      await this.notifyOutcome({
        job,
        status: "failed",
        returnPct: null,
        baseline,
        followupScore: null,
        followupPriceUsd: null,
        followupMarketCapUsd: null,
        followupLiquidityUsd: null,
        followupSentiment: null,
        pairUrl: null,
        error: "Baseline scan no longer exists",
      });
      return;
    }

    const outcome = await this.deps.scans.scanToken({
      tokenAddress,
      source: "followup",
      scheduleFollowups: false,
    });

    if (!outcome.ok) {
      this.deps.log.warn("followup_scan_failed", {
        followupId,
        token: tokenAddress,
        error: outcome.error,
      });
      const finalized = this.retryOrFinalize(job, outcome.error, "failed", null);
      if (finalized) {
        await this.notifyOutcome({
          job,
          status: "failed",
          returnPct: null,
          baseline,
          followupScore: null,
          followupPriceUsd: null,
          followupMarketCapUsd: null,
          followupLiquidityUsd: null,
          followupSentiment: null,
          pairUrl: null,
          error: outcome.error,
        });
      }
      return;
    }

    if (!outcome.pair || outcome.metrics.priceUsd === null) {
      const conservativeReturn = baseline.price_usd && baseline.price_usd > 0 ? -100 : null;
      const finalized = this.retryOrFinalize(
        job,
        "No usable priced market pair found",
        "unpriced",
        conservativeReturn,
      );
      if (finalized) {
        await this.notifyOutcome({
          job,
          status: "unpriced",
          returnPct: conservativeReturn,
          baseline,
          followupScore: outcome.score.total,
          followupPriceUsd: outcome.metrics.priceUsd,
          followupMarketCapUsd: outcome.metrics.marketCapUsd,
          followupLiquidityUsd: outcome.metrics.liquidityUsd,
          followupSentiment: outcome.sentiment,
          pairUrl: outcome.pair?.url ?? baseline.pair_url,
          error: "No usable priced market pair found",
        });
      }
      return;
    }

    const basePrice = baseline.price_usd;
    const newPrice = outcome.metrics.priceUsd;
    let returnPct: number | null = null;
    if (basePrice && basePrice > 0 && newPrice !== null) {
      returnPct = ((newPrice - basePrice) / basePrice) * 100;
    }

    this.deps.repo.completeFollowup({
      id: followupId,
      priceUsd: newPrice,
      marketCapUsd: outcome.metrics.marketCapUsd,
      liquidityUsd: outcome.metrics.liquidityUsd,
      scoreTotal: outcome.score.total,
      returnPct,
      sentiment: outcome.sentiment,
    });

    this.deps.log.info("followup_completed", {
      followupId,
      token: tokenAddress,
      returnPct,
      sentimentScore: outcome.sentiment?.score ?? null,
    });

    await this.notifyOutcome({
      job,
      status: "completed",
      returnPct,
      baseline,
      followupScore: outcome.score.total,
      followupPriceUsd: newPrice,
      followupMarketCapUsd: outcome.metrics.marketCapUsd,
      followupLiquidityUsd: outcome.metrics.liquidityUsd,
      followupSentiment: outcome.sentiment,
      pairUrl: outcome.pair.url ?? baseline.pair_url,
      error: null,
    });
  }

  /** Returns true when the job was finalized (no more retries). */
  private retryOrFinalize(
    job: FollowupRow,
    error: string,
    finalStatus: "unpriced" | "failed",
    finalReturnPct: number | null,
  ): boolean {
    const maxAttempts = this.deps.maxAttempts ?? 3;
    const nextAttempt = job.attempt_count + 1;
    if (nextAttempt >= maxAttempts) {
      this.deps.repo.finalizeFollowupIssue({
        id: job.id,
        status: finalStatus,
        error,
        returnPct: finalReturnPct,
      });
      return true;
    }

    const retryBaseMs = this.deps.retryBaseMs ?? 60_000;
    const delayMs = retryBaseMs * 2 ** job.attempt_count;
    this.deps.repo.deferFollowup({
      id: job.id,
      nextAttemptAt: new Date(Date.now() + delayMs),
      error,
    });
    return false;
  }

  private async notifyOutcome(input: {
    job: FollowupRow;
    status: "completed" | "unpriced" | "failed";
    returnPct: number | null;
    baseline: ReturnType<Repository["getScan"]>;
    followupScore: number | null;
    followupPriceUsd: number | null;
    followupMarketCapUsd: number | null;
    followupLiquidityUsd: number | null;
    followupSentiment: ReturnType<typeof parseSentimentSnapshot>;
    pairUrl: string | null;
    error: string | null;
  }): Promise<void> {
    const notify = this.deps.notify;
    if (!notify) return;

    const token = this.deps.repo.getToken(input.job.token_address);
    const baselineSentiment = parseSentimentSnapshot(input.baseline?.sentiment_json);
    const html = formatFollowupNotification({
      symbol: token?.symbol ?? "TOKEN",
      address: input.job.token_address,
      horizon: input.job.horizon,
      status: input.status,
      returnPct: input.returnPct,
      baselineScore: input.baseline?.score_total ?? null,
      followupScore: input.followupScore,
      baselinePriceUsd: input.baseline?.price_usd ?? null,
      followupPriceUsd: input.followupPriceUsd,
      baselineMarketCapUsd: input.baseline?.market_cap_usd ?? null,
      followupMarketCapUsd: input.followupMarketCapUsd,
      baselineLiquidityUsd: input.baseline?.liquidity_usd ?? null,
      followupLiquidityUsd: input.followupLiquidityUsd,
      baselineSentiment,
      followupSentiment: input.followupSentiment,
      pairUrl: input.pairUrl,
      error: input.error,
    });

    try {
      await notify(html);
      this.deps.log.info("followup_notified", {
        followupId: input.job.id,
        token: input.job.token_address,
        horizon: input.job.horizon,
        status: input.status,
      });
    } catch (err) {
      this.deps.log.warn("followup_notify_failed", {
        followupId: input.job.id,
        token: input.job.token_address,
        ...errorFields(err),
      });
    }
  }
}
