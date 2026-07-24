import { z } from "zod";
import { errorFields, type Logger } from "../logger.js";

export type BirdeyeSnapshot = {
  checked: boolean;
  creatorPercentage: number | null;
  top10HolderPercent: number | null;
  holders: number | null;
  freezeable: boolean | null;
  mutableMetadata: boolean | null;
  provider: string;
  error?: string;
};

const securitySchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      creatorPercentage: z.number().nullable().optional(),
      top10HolderPercent: z.number().nullable().optional(),
      freezeable: z.boolean().nullable().optional(),
      mutableMetadata: z.boolean().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  message: z.string().optional(),
});

const overviewSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      holder: z.number().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  message: z.string().optional(),
});

const BASE_URL = "https://public-api.birdeye.so";
const PROVIDER = "birdeye:token_security+overview";

/**
 * Free-tier Birdeye (Standard plan: 30,000 CU/month, 1 req/sec) — dev/creator
 * holding % and top-10 concentration, cross-checking RugCheck's own holder
 * numbers from an independent data source, plus a raw holder count.
 * Deliberately two lightweight calls, not the heavier holder-list endpoint.
 */
export async function fetchBirdeyeSecurity(input: {
  mint: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log: Logger;
}): Promise<BirdeyeSnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    accept: "application/json",
    "x-chain": "solana",
    "X-API-KEY": input.apiKey,
  };
  const empty: BirdeyeSnapshot = {
    checked: false,
    creatorPercentage: null,
    top10HolderPercent: null,
    holders: null,
    freezeable: null,
    mutableMetadata: null,
    provider: PROVIDER,
  };

  async function getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetchImpl(`${BASE_URL}${path}?address=${input.mint}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const [securityRaw, overviewRaw] = await Promise.allSettled([
      getJson("/defi/token_security"),
      getJson("/defi/token_overview"),
    ]);

    let creatorPercentage: number | null = null;
    let top10HolderPercent: number | null = null;
    let freezeable: boolean | null = null;
    let mutableMetadata: boolean | null = null;
    let holders: number | null = null;
    let anyChecked = false;

    if (securityRaw.status === "fulfilled") {
      const parsed = securitySchema.safeParse(securityRaw.value);
      if (parsed.success && parsed.data.success && parsed.data.data) {
        anyChecked = true;
        // Birdeye returns these as fractions (0-1); normalize to percentage points.
        const creatorFraction = parsed.data.data.creatorPercentage ?? null;
        const top10Fraction = parsed.data.data.top10HolderPercent ?? null;
        creatorPercentage = creatorFraction === null ? null : creatorFraction * 100;
        top10HolderPercent = top10Fraction === null ? null : top10Fraction * 100;
        freezeable = parsed.data.data.freezeable ?? null;
        mutableMetadata = parsed.data.data.mutableMetadata ?? null;
      }
    }
    if (overviewRaw.status === "fulfilled") {
      const parsed = overviewSchema.safeParse(overviewRaw.value);
      if (parsed.success && parsed.data.success && parsed.data.data) {
        anyChecked = true;
        holders = parsed.data.data.holder ?? null;
      }
    }

    if (!anyChecked) {
      return { ...empty, error: "Birdeye request failed" };
    }

    return {
      checked: true,
      creatorPercentage,
      top10HolderPercent,
      holders,
      freezeable,
      mutableMetadata,
      provider: PROVIDER,
    };
  } catch (error) {
    input.log.warn("birdeye_check_failed", errorFields(error));
    return { ...empty, error: "Network request failed" };
  }
}

/** Gated behind BIRDEYE_API_KEY, exactly like Helius gates Solana sentiment. */
export class BirdeyeService {
  private readonly log: Logger;
  private readonly cache = new Map<string, { at: number; value: BirdeyeSnapshot }>();

  constructor(
    private readonly options: {
      apiKey: string | null;
      timeoutMs: number;
      cacheMs?: number;
      fetchImpl?: typeof fetch;
      log: Logger;
    },
  ) {
    this.log = options.log.child({ component: "birdeye_service" });
  }

  get enabled(): boolean {
    return this.options.apiKey !== null && this.options.apiKey.length > 0;
  }

  async checkSolanaToken(mint: string): Promise<BirdeyeSnapshot> {
    if (!this.enabled) {
      return {
        checked: false,
        creatorPercentage: null,
        top10HolderPercent: null,
        holders: null,
        freezeable: null,
        mutableMetadata: null,
        provider: "birdeye:token_security+overview",
        error: "BIRDEYE_API_KEY not configured",
      };
    }
    const cacheMs = this.options.cacheMs ?? 5 * 60_000;
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.at < cacheMs) {
      return cached.value;
    }
    const value = await fetchBirdeyeSecurity({
      mint,
      apiKey: this.options.apiKey as string,
      timeoutMs: this.options.timeoutMs,
      fetchImpl: this.options.fetchImpl,
      log: this.log,
    });
    if (value.checked) {
      this.cache.set(mint, { at: Date.now(), value });
    }
    return value;
  }
}
