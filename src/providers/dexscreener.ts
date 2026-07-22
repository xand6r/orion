import { z } from "zod";

export type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string | null;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { h24?: number; h6?: number; h1?: number; m5?: number };
  txns?: {
    h24?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    m5?: { buys?: number; sells?: number };
  };
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
};

export type SelectedPair = {
  pair: DexPair;
  reason: string;
};

const PREFERRED_QUOTES_BY_CHAIN: Record<string, Set<string>> = {
  solana: new Set(["SOL", "USDC", "USDT", "WSOL"]),
  robinhood: new Set(["ETH", "WETH", "USDC", "USDT", "USDG"]),
};

export class DexscreenerError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DexscreenerError";
  }
}

type CacheEntry = { at: number; pairs: DexPair[] };

export class DexscreenerClient {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly opts: {
      timeoutMs: number;
      cacheMs: number;
      fetchImpl?: typeof fetch;
      baseUrl?: string;
      maxRetries?: number;
    },
  ) {}

  async getTokenPairs(tokenAddress: string, chainId: string = "solana"): Promise<DexPair[]> {
    const cacheKey = `${chainId}:${tokenAddress}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.opts.cacheMs) {
      return cached.pairs;
    }

    const maxRetries = this.opts.maxRetries ?? 0;
    let lastError: DexscreenerError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const pairs = await this.fetchTokenPairs(tokenAddress, chainId);
        this.cache.set(cacheKey, { at: Date.now(), pairs });
        return pairs;
      } catch (err) {
        const wrapped =
          err instanceof DexscreenerError
            ? err
            : new DexscreenerError("Dexscreener request failed", err, true);
        lastError = wrapped;
        if (!wrapped.retryable || attempt >= maxRetries) throw wrapped;
        await delay(200 * 2 ** attempt);
      }
    }

    throw lastError ?? new DexscreenerError("Dexscreener request failed");
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async fetchTokenPairs(tokenAddress: string, chainId: string): Promise<DexPair[]> {
    const base = this.opts.baseUrl ?? "https://api.dexscreener.com";
    const url = `${base}/token-pairs/v1/${encodeURIComponent(chainId)}/${tokenAddress}`;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });

      if (res.status === 404) return [];
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new DexscreenerError(`Dexscreener HTTP ${res.status}`, undefined, retryable);
      }

      return normalizePairs((await res.json()) as unknown);
    } catch (err) {
      if (err instanceof DexscreenerError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new DexscreenerError("Dexscreener request timed out", err, true);
      }
      throw new DexscreenerError("Dexscreener request failed", err, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

const tokenSchema = z.object({
  address: z.string().min(1),
  name: z.string().default(""),
  symbol: z.string().default(""),
});

const dexPairSchema = z
  .object({
    chainId: z.string().min(1),
    dexId: z.string().min(1),
    pairAddress: z.string().min(1),
    url: z.string().default(""),
    labels: z.array(z.string()).optional(),
    baseToken: tokenSchema,
    quoteToken: tokenSchema,
    priceUsd: z.string().nullable().default(null),
    liquidity: z
      .object({
        usd: z.number().finite().optional(),
        base: z.number().finite().optional(),
        quote: z.number().finite().optional(),
      })
      .nullable()
      .optional(),
    fdv: z.number().finite().nullable().optional(),
    marketCap: z.number().finite().nullable().optional(),
    pairCreatedAt: z.number().finite().nullable().optional(),
    volume: z
      .object({
        h24: z.number().finite().optional(),
        h6: z.number().finite().optional(),
        h1: z.number().finite().optional(),
        m5: z.number().finite().optional(),
      })
      .nullable()
      .optional(),
    priceChange: z
      .object({
        h24: z.number().finite().optional(),
        h6: z.number().finite().optional(),
        h1: z.number().finite().optional(),
        m5: z.number().finite().optional(),
      })
      .nullable()
      .optional(),
    txns: z
      .object({
        h24: z.object({ buys: z.number().optional(), sells: z.number().optional() }).optional(),
        h6: z.object({ buys: z.number().optional(), sells: z.number().optional() }).optional(),
        h1: z.object({ buys: z.number().optional(), sells: z.number().optional() }).optional(),
        m5: z.object({ buys: z.number().optional(), sells: z.number().optional() }).optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

function normalizePairs(body: unknown): DexPair[] {
  const candidates = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { pairs?: unknown }).pairs)
      ? (body as { pairs: unknown[] }).pairs
      : [];

  return candidates.flatMap((candidate) => {
    const parsed = dexPairSchema.safeParse(candidate);
    return parsed.success ? [parsed.data as DexPair] : [];
  });
}

/**
 * Primary pair selection:
 * Same-chain base-token pairs only → drop zero/missing liquidity → prefer quote assets
 * → highest USD liquidity.
 */
export function selectPrimaryPair(
  tokenAddress: string,
  pairs: DexPair[],
  chainId: string = "solana",
): SelectedPair | null {
  const chain = chainId.toLowerCase();
  const preferredQuotes = PREFERRED_QUOTES_BY_CHAIN[chain] ?? PREFERRED_QUOTES_BY_CHAIN.solana!;
  const sameAddress = (a: string | undefined, b: string) =>
    chain === "robinhood"
      ? (a ?? "").toLowerCase() === b.toLowerCase()
      : a === b;

  const onChain = pairs.filter(
    (p) =>
      p.chainId?.toLowerCase() === chain && sameAddress(p.baseToken?.address, tokenAddress),
  );

  const withLiq = onChain.filter((p) => (p.liquidity?.usd ?? 0) > 0);
  if (withLiq.length === 0) return null;

  const preferred = withLiq.filter((p) => {
    const quote = quoteSymbolForToken(tokenAddress, p);
    return quote !== null && preferredQuotes.has(quote.toUpperCase());
  });

  const pool = preferred.length > 0 ? preferred : withLiq;
  pool.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

  const pair = pool[0];
  if (!pair) return null;

  const reason =
    preferred.length > 0
      ? `highest liquidity among preferred ${chain} quote assets`
      : `highest liquidity among ${chain} pairs`;

  return { pair, reason };
}

export function quoteSymbolForToken(tokenAddress: string, pair: DexPair): string | null {
  const chain = pair.chainId?.toLowerCase() ?? "solana";
  const sameAddress = (a: string | undefined, b: string) =>
    chain === "robinhood"
      ? (a ?? "").toLowerCase() === b.toLowerCase()
      : a === b;
  if (sameAddress(pair.baseToken?.address, tokenAddress)) return pair.quoteToken?.symbol ?? null;
  if (sameAddress(pair.quoteToken?.address, tokenAddress)) return pair.baseToken?.symbol ?? null;
  return pair.quoteToken?.symbol ?? null;
}

export function tokenMeta(tokenAddress: string, pair: DexPair): { name: string; symbol: string } {
  const chain = pair.chainId?.toLowerCase() ?? "solana";
  const sameAddress = (a: string | undefined, b: string) =>
    chain === "robinhood"
      ? (a ?? "").toLowerCase() === b.toLowerCase()
      : a === b;
  if (sameAddress(pair.baseToken?.address, tokenAddress)) {
    return { name: pair.baseToken.name, symbol: pair.baseToken.symbol };
  }
  if (sameAddress(pair.quoteToken?.address, tokenAddress)) {
    return { name: pair.quoteToken.name, symbol: pair.quoteToken.symbol };
  }
  return {
    name: pair.baseToken?.name ?? "UNKNOWN",
    symbol: pair.baseToken?.symbol ?? "UNKNOWN",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
