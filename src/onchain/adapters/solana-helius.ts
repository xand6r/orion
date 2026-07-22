import { z } from "zod";
import { isValidSolanaAddress } from "../../address/solana.js";
import { errorFields, type Logger } from "../../logger.js";
import type {
  NormalizedSwap,
  OnchainAdapter,
  SwapBatch,
  SwapQuery,
} from "../types.js";

const accountKeySchema = z.union([
  z.string(),
  z.object({ pubkey: z.string() }).passthrough(),
]);

const tokenBalanceSchema = z
  .object({
    accountIndex: z.number().int().nonnegative(),
    mint: z.string(),
    owner: z.string().optional(),
    uiTokenAmount: z.object({
      uiAmount: z.number().nullable().optional(),
      uiAmountString: z.string().optional(),
      amount: z.string(),
      decimals: z.number().int().nonnegative(),
    }),
  })
  .passthrough();

const transactionEntrySchema = z
  .object({
    blockTime: z.number().int().nullable(),
    transaction: z.object({
      signatures: z.array(z.string()).min(1),
      message: z.object({ accountKeys: z.array(accountKeySchema).min(1) }).passthrough(),
    }),
    meta: z
      .object({
        err: z.unknown().nullable().optional(),
        fee: z.number().nonnegative().default(0),
        preBalances: z.array(z.number()).default([]),
        postBalances: z.array(z.number()).default([]),
        preTokenBalances: z.array(tokenBalanceSchema).nullish().transform((value) => value ?? []),
        postTokenBalances: z.array(tokenBalanceSchema).nullish().transform((value) => value ?? []),
      })
      .passthrough(),
  })
  .passthrough();

const responseSchema = z.object({
  result: z
    .object({
      data: z.array(transactionEntrySchema),
      paginationToken: z.string().nullable().optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.number().optional(),
      message: z.string(),
    })
    .optional(),
});

type TransactionEntry = z.infer<typeof transactionEntrySchema>;
type TokenBalance = z.infer<typeof tokenBalanceSchema>;

export class SolanaHeliusAdapter implements OnchainAdapter {
  readonly chain = "solana";
  private readonly log: Logger;

  constructor(
    private readonly options: {
      apiKey: string;
      rpcUrl: string;
      timeoutMs: number;
      maxRetries: number;
      maxTransactions: number;
      fetchImpl?: typeof fetch;
      log: Logger;
    },
  ) {
    this.log = options.log.child({ component: "solana_helius_adapter", provider: "helius" });
  }

  validateAddress(address: string): boolean {
    return isValidSolanaAddress(address);
  }

  async getSwaps(query: SwapQuery): Promise<SwapBatch> {
    const requestId = crypto.randomUUID();
    const requestLog = this.log.child({
      requestId,
      address: query.address,
      marketAddress: query.marketAddress,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
    });
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const startedAt = Date.now();
      requestLog.debug("helius_request_started", { attempt: attempt + 1 });
      try {
        const entries = await this.fetchTransactions(query);
        const swaps = entries.flatMap((entry) => {
          const swap = parseSwap(entry, query.address, query.priceUsd ?? null);
          return swap ? [swap] : [];
        });
        requestLog.info("helius_request_completed", {
          attempt: attempt + 1,
          transactionCount: entries.length,
          qualifyingSwapCount: swaps.length,
          durationMs: Date.now() - startedAt,
        });
        return {
          swaps,
          provider: "helius:getTransactionsForAddress",
          truncated: entries.length >= this.options.maxTransactions,
          inspectedTransactions: entries.length,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof HeliusProviderError && error.retryable;
        requestLog.warn("helius_request_failed", {
          ...errorFields(error),
          attempt: attempt + 1,
          retryable,
          durationMs: Date.now() - startedAt,
        });
        if (!retryable || attempt >= this.options.maxRetries) throw lastError;
        await delay(250 * 2 ** attempt);
      }
    }

    throw lastError ?? new HeliusProviderError("Helius request failed", false);
  }

  private async fetchTransactions(query: SwapQuery): Promise<TransactionEntry[]> {
    if (!query.marketAddress || !isValidSolanaAddress(query.marketAddress)) {
      throw new HeliusProviderError("A valid Solana market pair address is required", false);
    }
    const url = new URL(this.options.rpcUrl);
    url.searchParams.set("api-key", this.options.apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const fetchImpl = this.options.fetchImpl ?? fetch;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "orion-onchain",
          method: "getTransactionsForAddress",
          params: [
            query.marketAddress,
            {
              transactionDetails: "full",
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
              commitment: "finalized",
              sortOrder: "desc",
              limit: this.options.maxTransactions,
              filters: {
                status: "succeeded",
                tokenAccounts: "none",
                blockTime: {
                  gte: Math.floor(query.from.getTime() / 1000),
                  lte: Math.floor(query.to.getTime() / 1000),
                },
              },
            },
          ],
        }),
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new HeliusProviderError(`Helius HTTP ${response.status}`, retryable);
      }

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new HeliusProviderError("Helius returned an invalid response", false);
      }
      if (parsed.data.error) {
        const code = parsed.data.error.code;
        const retryable = code === -32005 || code === -32603;
        throw new HeliusProviderError(parsed.data.error.message, retryable);
      }
      if (!parsed.data.result) {
        throw new HeliusProviderError("Helius response had no result", false);
      }
      return parsed.data.result.data;
    } catch (error) {
      if (error instanceof HeliusProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new HeliusProviderError("Helius request timed out", true);
      }
      throw new HeliusProviderError("Helius network request failed", true, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class HeliusProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "HeliusProviderError";
  }
}

export function parseSwap(
  entry: TransactionEntry,
  targetMint: string,
  priceUsd: number | null,
): NormalizedSwap | null {
  if (entry.blockTime === null || entry.meta.err) return null;
  const feePayer = accountKey(entry.transaction.message.accountKeys[0]);
  const signature = entry.transaction.signatures[0];
  if (!feePayer || !signature) return null;

  const deltas = tokenDeltas(
    entry.meta.preTokenBalances,
    entry.meta.postTokenBalances,
    feePayer,
  );
  const targetDelta = deltas.get(targetMint) ?? 0;
  if (!Number.isFinite(targetDelta) || Math.abs(targetDelta) <= 0) return null;

  const oppositeTokenFlow = [...deltas.entries()].some(
    ([mint, delta]) => mint !== targetMint && Math.sign(delta) === -Math.sign(targetDelta),
  );
  const nativeDelta = nativeTradeDelta(entry, feePayer);
  const oppositeNativeFlow =
    nativeDelta !== null && Math.sign(nativeDelta) === -Math.sign(targetDelta);
  if (!oppositeTokenFlow && !oppositeNativeFlow) return null;

  const tokenAmount = Math.abs(targetDelta);
  return {
    id: signature,
    wallet: feePayer,
    side: targetDelta > 0 ? "buy" : "sell",
    tokenAmount,
    usdValue:
      priceUsd !== null && Number.isFinite(priceUsd) && priceUsd >= 0
        ? tokenAmount * priceUsd
        : null,
    timestamp: new Date(entry.blockTime * 1000),
  };
}

function tokenDeltas(
  pre: TokenBalance[],
  post: TokenBalance[],
  owner: string,
): Map<string, number> {
  const preByMint = balancesByMint(pre, owner);
  const postByMint = balancesByMint(post, owner);
  const mints = new Set([...preByMint.keys(), ...postByMint.keys()]);
  const deltas = new Map<string, number>();
  for (const mint of mints) {
    deltas.set(mint, (postByMint.get(mint) ?? 0) - (preByMint.get(mint) ?? 0));
  }
  return deltas;
}

function balancesByMint(balances: TokenBalance[], owner: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const balance of balances) {
    if (balance.owner !== owner) continue;
    const amount = uiAmount(balance);
    if (amount === null) continue;
    result.set(balance.mint, (result.get(balance.mint) ?? 0) + amount);
  }
  return result;
}

function uiAmount(balance: TokenBalance): number | null {
  const direct = balance.uiTokenAmount.uiAmount;
  if (direct !== null && direct !== undefined && Number.isFinite(direct)) return direct;
  const fromString = Number(balance.uiTokenAmount.uiAmountString);
  if (Number.isFinite(fromString)) return fromString;
  const raw = Number(balance.uiTokenAmount.amount);
  if (!Number.isFinite(raw)) return null;
  return raw / 10 ** balance.uiTokenAmount.decimals;
}

function nativeTradeDelta(entry: TransactionEntry, feePayer: string): number | null {
  const keys = entry.transaction.message.accountKeys.map(accountKey);
  const index = keys.indexOf(feePayer);
  if (index < 0) return null;
  const pre = entry.meta.preBalances[index];
  const post = entry.meta.postBalances[index];
  if (pre === undefined || post === undefined) return null;
  // Add the fee back so a simple token transfer is not mistaken for a SOL-funded swap.
  return post - pre + entry.meta.fee;
}

function accountKey(key: string | { pubkey: string } | undefined): string | null {
  if (!key) return null;
  return typeof key === "string" ? key : key.pubkey;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
