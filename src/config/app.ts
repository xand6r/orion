import { readFileSync } from "node:fs";
import { z } from "zod";

export const appConfigSchema = z.object({
  databasePath: z.string().min(1),
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  logPretty: z.boolean().default(true),
  scoringConfigPath: z.string().min(1),
  dexscreener: z.object({
    timeoutMs: z.number().int().positive(),
    cacheMs: z.number().int().nonnegative(),
    maxRetries: z.number().int().min(0).max(5),
  }),
  followup: z.object({
    pollMs: z.number().int().positive(),
    maxAttempts: z.number().int().min(1).max(10),
    retryBaseMs: z.number().int().positive(),
  }),
  helius: z.object({
    rpcUrl: z.string().url(),
  }),
  robinhood: z
    .object({
      rpcUrl: z.string().url(),
    })
    .default({ rpcUrl: "https://rpc.mainnet.chain.robinhood.com" }),
  onchain: z.object({
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().min(0).max(5),
    maxTransactions: z.number().int().min(10).max(100),
    defaultWindowMinutes: z.number().int().min(5).max(60),
  }),
  http: z
    .object({
      port: z.number().int().min(1).max(65535),
      host: z.string().min(1).default("0.0.0.0"),
    })
    .default({ port: 8080, host: "0.0.0.0" }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadAppConfig(path = "./config/app.json"): AppConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return appConfigSchema.parse(raw);
}
