import { z } from "zod";
import { errorFields, type Logger } from "../logger.js";

export type RugCheckSnapshot = {
  checked: boolean;
  score: number | null;
  riskLevel: string | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  lpLocked: boolean | null;
  lpLockedPct: number | null;
  topHoldersPct: number | null;
  risks: Array<{ name: string; level: string }>;
  provider: string;
  error?: string;
};

const riskSchema = z
  .object({
    name: z.string(),
    level: z.string(),
  })
  .passthrough();

const summarySchema = z
  .object({
    score: z.number().nullable().optional(),
    riskLevel: z.string().nullable().optional(),
    mintAuthority: z.string().nullable().optional(),
    freezeAuthority: z.string().nullable().optional(),
    lpLocked: z.boolean().nullable().optional(),
    lpLockedPct: z.number().nullable().optional(),
    topHoldersPct: z.number().nullable().optional(),
    risks: z.array(riskSchema).optional(),
  })
  .passthrough();

const PROVIDER = "rugcheck:report/summary";

/**
 * RugCheck's public summary report — no API key required. Gives mint/freeze
 * authority (redundant with our own Helius check, kept as cross-check), plus
 * LP-lock status and top-holder concentration computed *excluding* pool
 * accounts, which we deliberately don't attempt to compute ourselves.
 */
export async function fetchRugCheckSummary(input: {
  mint: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log: Logger;
}): Promise<RugCheckSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const fetchImpl = input.fetchImpl ?? fetch;
  const empty = {
    checked: false,
    score: null,
    riskLevel: null,
    mintAuthorityRevoked: null,
    freezeAuthorityRevoked: null,
    lpLocked: null,
    lpLockedPct: null,
    topHoldersPct: null,
    risks: [],
    provider: PROVIDER,
  };

  try {
    const response = await fetchImpl(
      `https://api.rugcheck.xyz/v1/tokens/${input.mint}/report/summary`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      },
    );

    if (response.status === 404) {
      return { ...empty, error: "Token not indexed by RugCheck" };
    }
    if (!response.ok) {
      return { ...empty, error: `HTTP ${response.status}` };
    }

    const parsed = summarySchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ...empty, error: "Invalid response shape" };
    }
    const data = parsed.data;

    return {
      checked: true,
      score: data.score ?? null,
      riskLevel: data.riskLevel ?? null,
      mintAuthorityRevoked:
        data.mintAuthority === null || data.mintAuthority === undefined ? true : false,
      freezeAuthorityRevoked:
        data.freezeAuthority === null || data.freezeAuthority === undefined ? true : false,
      lpLocked: data.lpLocked ?? null,
      lpLockedPct: data.lpLockedPct ?? null,
      topHoldersPct: data.topHoldersPct ?? null,
      risks: data.risks ?? [],
      provider: PROVIDER,
    };
  } catch (error) {
    input.log.warn("rugcheck_check_failed", errorFields(error));
    const timedOut = error instanceof Error && error.name === "AbortError";
    return { ...empty, error: timedOut ? "Request timed out" : "Network request failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** Small in-memory TTL cache — RugCheck data doesn't change second to second,
 * and a manual /scan + 4 follow-ups on the same token shouldn't hit it 5x. */
export class RugCheckService {
  private readonly log: Logger;
  private readonly cache = new Map<string, { at: number; value: RugCheckSnapshot }>();

  constructor(
    private readonly options: {
      timeoutMs: number;
      cacheMs?: number;
      fetchImpl?: typeof fetch;
      log: Logger;
    },
  ) {
    this.log = options.log.child({ component: "rugcheck_service" });
  }

  async checkSolanaMint(mint: string): Promise<RugCheckSnapshot> {
    const cacheMs = this.options.cacheMs ?? 60_000;
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.at < cacheMs) {
      return cached.value;
    }
    const value = await fetchRugCheckSummary({
      mint,
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
