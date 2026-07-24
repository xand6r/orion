import { Bot, type Context } from "grammy";
import { isValidSolanaAddress } from "../address/solana.js";
import type { MarketChain } from "../address/detect.js";
import { isValidEvmAddress } from "../address/evm.js";
import type { Env } from "../env.js";
import type { Logger } from "../logger.js";
import type { Repository } from "../db/repo.js";
import type { ScanService } from "../services/scan.js";
import type { AppConfig } from "../config/app.js";
import type { ScoringConfig } from "../config/scoring.js";
import type { DexscreenerClient } from "../providers/dexscreener.js";
import { selectPrimaryPair } from "../providers/dexscreener.js";
import type { OnchainSentimentService } from "../onchain/service.js";
import { errorFields } from "../logger.js";
import {
  formatError,
  formatScanReport,
  formatTokenReport,
  formatTop,
  formatRank,
  formatOnchainSentimentReport,
  formatBasicStats,
  splitTelegram,
} from "./format.js";

export type BotDeps = {
  env: Env;
  app: AppConfig;
  log: Logger;
  repo: Repository;
  scans: ScanService;
  config: ScoringConfig;
  dex: DexscreenerClient;
  onchain: OnchainSentimentService;
};

/** Registered with Telegram so `/` shows suggestions. */
export const BOT_COMMANDS = [
  { command: "start", description: "Command menu" },
  { command: "help", description: "Command menu" },
  { command: "ping", description: "Liveness check → pong" },
  { command: "stats", description: "Catalog / scan / follow-up totals" },
  { command: "scan", description: "sol|rh <address> — score a token" },
  { command: "watch", description: "sol|rh <address> — watchlist + baseline scan" },
  { command: "report", description: "sol|rh <address> — latest score, deltas, notes" },
  { command: "sentiment", description: "sol|rh <address> [5|15|60] — on-chain demand report" },
  { command: "rank", description: "Tokens by latest score" },
  { command: "viable", description: "Recommendable tokens only" },
  { command: "top", description: "Top scores in 1h/6h/24h/7d" },
  { command: "eval", description: "24h returns by score band" },
  { command: "note", description: "sol|rh <address> <text> — save a thesis note" },
] as const;

function chatAllowed(ctx: Context, env: Env): boolean {
  if (env.allowedChatIds.size === 0) return false;
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  return env.allowedChatIds.has(String(chatId));
}

function commandName(ctx: Context): string {
  const text = ctx.message?.text ?? ctx.channelPost?.text ?? "";
  const match = text.match(/^\/([a-zA-Z0-9_]+)/);
  return match?.[1]?.toLowerCase() ?? "unknown";
}

const CHAIN_ALIASES: Record<string, MarketChain> = {
  sol: "solana",
  solana: "solana",
  rh: "robinhood",
  robinhood: "robinhood",
};

/** Every command that takes a chain arg accepts the same sol|rh (or full-name) tokens. */
function parseChainArg(raw: string): MarketChain | null {
  return CHAIN_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** Catches "sol <0x…>" / "rh <base58>" typos before they hit a provider call. */
function chainAddressMismatch(chain: MarketChain, address: string): string | null {
  if (chain === "solana" && !isValidSolanaAddress(address)) {
    return "That doesn't look like a Solana address.";
  }
  if (chain === "robinhood" && !isValidEvmAddress(address)) {
    return "That doesn't look like a Robinhood (0x…) address.";
  }
  return null;
}

async function replyChunks(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitTelegram(text)) {
    await ctx.reply(chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

export function createBot(deps: BotDeps): Bot {
  const { env, log, repo, scans, config } = deps;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.use(async (ctx, next) => {
    const startedAt = Date.now();
    const command = commandName(ctx);
    const updateLog = log.child({
      component: "telegram",
      command,
    });

    if (!chatAllowed(ctx, env)) {
      updateLog.info("request_ignored", { reason: "chat_not_allowlisted" });
      return;
    }

    updateLog.info("request_received");
    try {
      await next();
      updateLog.info("request_completed", { durationMs: Date.now() - startedAt });
    } catch (err) {
      updateLog.error("request_failed", {
        ...errorFields(err),
        durationMs: Date.now() - startedAt,
      });
      try {
        if (ctx.chat) {
          await ctx.reply(formatError("Something broke handling that update."), {
            parse_mode: "HTML",
          });
        }
      } catch {
        // swallow secondary reply failures
      }
    }
  });

  const helpText = [
    "<b>ORION</b> online ✅",
    "",
    "<b>Research</b>",
    "/scan sol|rh &lt;address&gt;",
    "/watch sol|rh &lt;address&gt;",
    "/report sol|rh &lt;address&gt;",
    "/sentiment sol|rh &lt;address&gt; [5|15|60]",
    "",
    "<b>Lists</b>",
    "/rank · /viable · /top 24h · /eval",
    "",
    "<b>Status</b>",
    "/ping · /stats",
    "",
    "<b>Notes</b>",
    "/note sol|rh &lt;address&gt; &lt;text&gt;",
    "",
    "<b>Help</b>",
    "/start · /help",
  ].join("\n");

  bot.command("start", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  bot.command("stats", async (ctx) => {
    log.info("stats_requested");
    await replyChunks(ctx, formatBasicStats(repo.basicStats()));
  });

  bot.command("scan", async (ctx) => {
    const args = (ctx.match ?? "").toString().trim().split(/\s+/).filter(Boolean);
    const chain = parseChainArg(args[0] ?? "");
    const arg = args[1] ?? "";
    if (!chain || !arg) {
      await ctx.reply(formatError("Usage: /scan sol|rh <address>"), { parse_mode: "HTML" });
      return;
    }
    const mismatch = chainAddressMismatch(chain, arg);
    if (mismatch) {
      await ctx.reply(formatError(mismatch), { parse_mode: "HTML" });
      return;
    }

    log.info("scan_requested", { address: arg, source: "manual_scan", chain });
    repo.upsertToken({ address: arg });
    await runAndReply(ctx, deps, arg, "manual_scan", false);
  });

  bot.command("watch", async (ctx) => {
    const args = (ctx.match ?? "").toString().trim().split(/\s+/).filter(Boolean);
    const chain = parseChainArg(args[0] ?? "");
    const arg = args[1] ?? "";
    if (!chain || !arg) {
      await ctx.reply(formatError("Usage: /watch sol|rh <address>"), { parse_mode: "HTML" });
      return;
    }
    const mismatch = chainAddressMismatch(chain, arg);
    if (mismatch) {
      await ctx.reply(formatError(mismatch), { parse_mode: "HTML" });
      return;
    }
    log.info("watch_requested", { address: arg, chain });
    repo.upsertToken({ address: arg });
    repo.addWatch(arg);
    await ctx.reply(`Watching <code>${arg}</code>. Creating a baseline scan.`, {
      parse_mode: "HTML",
    });
    await runAndReply(ctx, deps, arg, "manual_scan", true);
  });

  bot.command("note", async (ctx) => {
    const raw = (ctx.match ?? "").toString().trim();
    const firstSp = raw.indexOf(" ");
    const chainToken = firstSp === -1 ? raw : raw.slice(0, firstSp);
    const rest = firstSp === -1 ? "" : raw.slice(firstSp + 1).trim();
    const secondSp = rest.indexOf(" ");
    const address = secondSp === -1 ? rest : rest.slice(0, secondSp);
    const text = secondSp === -1 ? "" : rest.slice(secondSp + 1).trim();

    const chain = parseChainArg(chainToken);
    if (!chain || !address || !text) {
      await ctx.reply(formatError("Usage: /note sol|rh <address> <text>"), { parse_mode: "HTML" });
      return;
    }
    const mismatch = chainAddressMismatch(chain, address);
    if (mismatch) {
      await ctx.reply(formatError(mismatch), { parse_mode: "HTML" });
      return;
    }
    log.info("note_requested", { address, chain });
    repo.upsertToken({ address });
    repo.addNote(address, text);
    await ctx.reply("Note saved.", { parse_mode: "HTML" });
  });

  bot.command("report", async (ctx) => {
    const args = (ctx.match ?? "").toString().trim().split(/\s+/).filter(Boolean);
    const chain = parseChainArg(args[0] ?? "");
    const arg = args[1] ?? "";
    if (!chain || !arg) {
      await ctx.reply(formatError("Usage: /report sol|rh <address>"), { parse_mode: "HTML" });
      return;
    }
    const mismatch = chainAddressMismatch(chain, arg);
    if (mismatch) {
      await ctx.reply(formatError(mismatch), { parse_mode: "HTML" });
      return;
    }

    log.info("report_requested", { address: arg, chain });
    const token = repo.getToken(arg);
    const latest = repo.latestScan(arg);
    if (!token || !latest) {
      await ctx.reply(formatError("No scans yet for that address. Try /scan first."), {
        parse_mode: "HTML",
      });
      return;
    }

    const text = formatTokenReport({
      token,
      latest,
      first: repo.firstScan(arg),
      followups: repo.getFollowupsForToken(arg),
      notes: repo.listNotes(arg),
    });
    await replyChunks(ctx, text);
  });

  bot.command("top", async (ctx) => {
    const arg = ((ctx.match ?? "").toString().trim() || "24h").toLowerCase();
    const allowed = ["1h", "6h", "24h", "7d"] as const;
    const period = (allowed as readonly string[]).includes(arg)
      ? (arg as (typeof allowed)[number])
      : null;
    if (!period) {
      await ctx.reply(formatError("Usage: /top 1h|6h|24h|7d"), { parse_mode: "HTML" });
      return;
    }
    log.info("top_requested", { period });
    const rows = repo.topTokens(period, 10);
    await replyChunks(ctx, formatTop(rows, period));
  });

  bot.command("rank", async (ctx) => {
    log.info("rank_requested");
    const rows = repo.rankedByLatestScore({ limit: 25 });
    await replyChunks(ctx, formatRank({ rows, mode: "rank" }));
  });

  bot.command("viable", async (ctx) => {
    const minScore = config.recommendMinScore;
    log.info("viable_requested", { minScore });
    const rows = repo.rankedByLatestScore({
      minScore,
      excludeCritical: true,
      limit: 25,
    });
    await replyChunks(ctx, formatRank({ rows, mode: "viable", minScore }));
  });

  bot.command("eval", async (ctx) => {
    log.info("eval_requested");
    const snap = repo.evaluationSnapshot();
    const lines = ["<b>ORION</b> · 24h forward returns by score band", ""];
    for (const b of snap.byBand) {
      if (b.n === 0) {
        lines.push(`${b.band}: n=0`);
        continue;
      }
      const median = b.medianReturn === null ? "n/a" : `${b.medianReturn.toFixed(1)}%`;
      const mean = b.meanReturn === null ? "n/a" : `${b.meanReturn.toFixed(1)}%`;
      const positive = b.pctPositive === null ? "n/a" : `${b.pctPositive.toFixed(0)}%`;
      lines.push(
        `${b.band}: n=${b.n} measured=${b.measured} unpriced=${b.unpriced} failed=${b.failed} median=${median} mean=${mean} pos=${positive}`,
      );
    }
    lines.push("", `Total scans stored: ${repo.countScans()}`);
    lines.push(`Config: ${config.version}`);
    await replyChunks(ctx, lines.join("\n"));
  });

  bot.command("sentiment", async (ctx) => {
    const args = (ctx.match ?? "").toString().trim().split(/\s+/).filter(Boolean);
    const chain = parseChainArg(args[0] ?? "");
    const address = args[1] ?? "";
    const requestedWindow = args[2] ? Number(args[2]) : deps.app.onchain.defaultWindowMinutes;
    if (!chain || !address || ![5, 15, 60].includes(requestedWindow)) {
      await replyChunks(ctx, formatError("Usage: /sentiment sol|rh <address> [5|15|60]"));
      return;
    }
    const mismatch = chainAddressMismatch(chain, address);
    if (mismatch) {
      await replyChunks(ctx, formatError(mismatch));
      return;
    }

    log.info("sentiment_requested", { chain, address, windowMinutes: requestedWindow });

    let priceUsd: number | null = null;
    let marketAddress: string | null = null;

    try {
      const pairs = await deps.dex.getTokenPairs(address, chain);
      const selected = selectPrimaryPair(address, pairs, chain);
      marketAddress = selected?.pair.pairAddress ?? null;
      const parsedPrice = Number(selected?.pair.priceUsd);
      priceUsd = Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : null;
    } catch (error) {
      log.warn("onchain_price_lookup_failed", { ...errorFields(error), chain, address });
    }

    if (!marketAddress) {
      log.info("onchain_market_not_found", { chain, address });
      await replyChunks(ctx, formatError(`No usable ${chain} market pair found for ${address}`));
      return;
    }

    const outcome = await deps.onchain.analyze({
      chain,
      address,
      windowMinutes: requestedWindow,
      priceUsd,
      marketAddress,
    });
    if (!outcome.ok) {
      log.warn("sentiment_failed", {
        address,
        code: outcome.code,
        executionId: outcome.executionId,
      });
      await replyChunks(
        ctx,
        formatError(`${outcome.error}\nExecution: ${outcome.executionId.slice(0, 8)}`),
      );
      return;
    }
    log.info("sentiment_completed", {
      address,
      score: outcome.score.total,
      verdict: outcome.score.verdict,
      confidence: outcome.score.confidence,
      executionId: outcome.executionId,
    });
    await replyChunks(ctx, formatOnchainSentimentReport(outcome));
  });

  bot.catch((err) => {
    log.error("bot_error", errorFields(err.error ?? err));
  });

  return bot;
}

async function runAndReply(
  ctx: Context,
  deps: BotDeps,
  address: string,
  source: "organic" | "manual_scan",
  scheduleFollowups = source === "organic",
): Promise<void> {
  const { scans, repo, log } = deps;
  try {
    const outcome = await scans.scanToken({
      tokenAddress: address,
      source,
      scheduleFollowups,
    });

    if (!outcome.ok) {
      log.warn("scan_failed", { address, error: outcome.error });
      await replyChunks(ctx, formatError(outcome.error));
      return;
    }

    const token = repo.getToken(address);

    if (!outcome.pair) {
      // Pre-graduation pump.fun mints have no Dexscreener pair yet, but ScanService
      // still scores them via the on-chain bonding-curve path.
      if (outcome.metrics.bondingProgressPct !== undefined) {
        log.info("scan_completed", {
          address,
          symbol: token?.symbol ?? "TOKEN",
          score: outcome.score.total,
          verdict: outcome.score.verdict,
          provisional: outcome.score.provisional,
          bondingCurve: true,
        });
        await replyChunks(
          ctx,
          formatScanReport({
            symbol: token?.symbol ?? "TOKEN",
            metrics: outcome.metrics,
            score: outcome.score,
            pair: null,
            firstSeenAt: token?.first_seen_at ?? null,
            recommendMinScore: deps.config.recommendMinScore,
          }),
        );
        return;
      }

      log.info("scan_no_pair", { address });
      await replyChunks(
        ctx,
        formatError(
          outcome.sentimentNote ??
            `No usable market pair for <code>${address}</code>`,
        ),
      );
      return;
    }

    log.info("scan_completed", {
      address,
      symbol: outcome.pair.baseToken.symbol,
      score: outcome.score.total,
      verdict: outcome.score.verdict,
      provisional: outcome.score.provisional,
    });

    const text = formatScanReport({
      symbol: token?.symbol ?? outcome.pair.baseToken.symbol ?? "TOKEN",
      metrics: outcome.metrics,
      score: outcome.score,
      pair: outcome.pair,
      firstSeenAt: token?.first_seen_at ?? null,
      recommendMinScore: deps.config.recommendMinScore,
    });
    await replyChunks(ctx, text);
  } catch (err) {
    log.error("scan_reply_failed", {
      address,
      ...errorFields(err),
    });
    await replyChunks(ctx, formatError("Scan failed. Check logs."));
  }
}

