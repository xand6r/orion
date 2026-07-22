import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { loadAppConfig } from "./config/app.js";
import { loadScoringConfig } from "./config/scoring.js";
import { openDatabase } from "./db/client.js";
import { Repository } from "./db/repo.js";
import { DexscreenerClient } from "./providers/dexscreener.js";
import { ScanService } from "./services/scan.js";
import { FollowupWorker } from "./services/followups.js";
import { createBot } from "./bot/create.js";
import { splitTelegram } from "./bot/format.js";
import { SolanaHeliusAdapter } from "./onchain/adapters/solana-helius.js";
import { RobinhoodEvmAdapter } from "./onchain/adapters/robinhood-evm.js";
import { OnchainSentimentService } from "./onchain/service.js";
import { errorFields } from "./logger.js";
import { printMogwaiBanner } from "./banner.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = loadAppConfig(env.APP_CONFIG_PATH);
  const log = createLogger(app.logLevel, undefined, { pretty: app.logPretty });
  const scoring = loadScoringConfig(app.scoringConfigPath);

  const db = openDatabase(app.databasePath);
  const repo = new Repository(db);
  const dex = new DexscreenerClient({
    timeoutMs: app.dexscreener.timeoutMs,
    cacheMs: app.dexscreener.cacheMs,
    maxRetries: app.dexscreener.maxRetries,
  });
  const onchainAdapters = [
    ...(env.HELIUS_API_KEY
      ? [
          new SolanaHeliusAdapter({
            apiKey: env.HELIUS_API_KEY,
            rpcUrl: app.helius.rpcUrl,
            timeoutMs: app.onchain.timeoutMs,
            maxRetries: app.onchain.maxRetries,
            maxTransactions: app.onchain.maxTransactions,
            log,
          }),
        ]
      : []),
    new RobinhoodEvmAdapter({
      rpcUrl: app.robinhood.rpcUrl,
      timeoutMs: app.onchain.timeoutMs,
      maxRetries: app.onchain.maxRetries,
      maxTransactions: app.onchain.maxTransactions,
      log,
    }),
  ];
  if (!env.HELIUS_API_KEY) {
    log.warn("onchain_adapters_partial", {
      reason: "HELIUS_API_KEY is not configured — Solana sentiment disabled; Robinhood enabled",
    });
  }
  const onchain = new OnchainSentimentService(onchainAdapters, log);
  const scans = new ScanService({
    repo,
    dex,
    config: scoring,
    log,
    onchain,
    sentimentWindowMinutes: app.onchain.defaultWindowMinutes,
  });
  const bot = createBot({ env, app, log, repo, scans, config: scoring, dex, onchain });

  const followups = new FollowupWorker({
    repo,
    scans,
    log,
    pollMs: app.followup.pollMs,
    maxAttempts: app.followup.maxAttempts,
    retryBaseMs: app.followup.retryBaseMs,
    notify: async (html) => {
      for (const chatId of env.allowedChatIds) {
        for (const chunk of splitTelegram(html)) {
          await bot.api.sendMessage(chatId, chunk, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
        }
      }
    },
  });

  followups.start();

  const shutdown = async (signal: string) => {
    log.info("shutting_down", { signal });
    followups.stop();
    await bot.stop();
    db.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("orion_starting", {
    db: app.databasePath,
    scoring: scoring.version,
    allowedChatCount: env.allowedChatIds.size,
    onchainChains: onchain.supportedChains(),
  });

  printMogwaiBanner("  starting…");

  await bot.start({
    onStart: (info) => {
      // eslint-disable-next-line no-console
      console.log(`\n  @${info.username}  ·  ready\n`);
      log.info("bot_online", { username: info.username });
    },
  });
}

main().catch((err) => {
  createLogger("error").error("fatal", errorFields(err));
  process.exit(1);
});
