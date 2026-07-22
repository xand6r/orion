import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

function csvIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Secrets and deployment-specific access only. Tunables live in config/app.json. */
const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  ALLOWED_CHAT_IDS: z.string().default(""),
  HELIUS_API_KEY: z.string().optional(),
  /** Optional override; defaults to ./config/app.json */
  APP_CONFIG_PATH: z.string().default("./config/app.json"),
});

export type Env = z.infer<typeof schema> & {
  allowedChatIds: Set<string>;
};

export function loadEnv(overrides: Partial<Record<keyof z.infer<typeof schema>, string>> = {}): Env {
  const parsed = schema.parse({
    TELEGRAM_BOT_TOKEN: overrides.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN,
    ALLOWED_CHAT_IDS: overrides.ALLOWED_CHAT_IDS ?? process.env.ALLOWED_CHAT_IDS,
    HELIUS_API_KEY: overrides.HELIUS_API_KEY ?? process.env.HELIUS_API_KEY,
    APP_CONFIG_PATH: overrides.APP_CONFIG_PATH ?? process.env.APP_CONFIG_PATH,
  });

  return {
    ...parsed,
    allowedChatIds: new Set(csvIds(parsed.ALLOWED_CHAT_IDS)),
  };
}
