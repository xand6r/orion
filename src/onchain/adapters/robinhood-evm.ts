import { isValidEvmAddress, normalizeEvmAddress } from "../../address/evm.js";
import { errorFields, type Logger } from "../../logger.js";
import type {
  NormalizedSwap,
  OnchainAdapter,
  SwapBatch,
  SwapQuery,
} from "../types.js";

/** ERC-20 Transfer(address,address,uint256) */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Robinhood Chain (EVM L2) sentiment via ERC-20 Transfer logs against the pool.
 * Transfer to pool = sell token; transfer from pool = buy token.
 */
export class RobinhoodEvmAdapter implements OnchainAdapter {
  readonly chain = "robinhood";

  constructor(
    private readonly options: {
      rpcUrl: string;
      timeoutMs: number;
      maxRetries: number;
      maxTransactions: number;
      /** Approx seconds per block for window → block-range estimate. */
      secondsPerBlock?: number;
      fetchImpl?: typeof fetch;
      log: Logger;
    },
  ) {}

  validateAddress(address: string): boolean {
    return isValidEvmAddress(address);
  }

  async getSwaps(query: SwapQuery): Promise<SwapBatch> {
    const token = normalizeEvmAddress(query.address);
    const pool = query.marketAddress ? normalizeEvmAddress(query.marketAddress) : null;
    if (!pool) {
      return {
        provider: "robinhood:eth_getLogs",
        truncated: false,
        inspectedTransactions: 0,
        swaps: [],
      };
    }

    const latestHex = await this.rpc<string>("eth_blockNumber", []);
    const latest = Number.parseInt(latestHex, 16);
    if (!Number.isFinite(latest)) {
      throw new Error("Invalid eth_blockNumber response");
    }

    const secondsPerBlock = this.options.secondsPerBlock ?? 0.5;
    const windowSeconds = Math.max(
      60,
      Math.floor((query.to.getTime() - query.from.getTime()) / 1000),
    );
    const blocksBack = Math.min(
      latest,
      Math.max(1, Math.ceil(windowSeconds / secondsPerBlock)),
    );
    const fromBlock = Math.max(0, latest - blocksBack);

    const logs = await this.rpc<Array<{
      address: string;
      topics: string[];
      data: string;
      blockNumber: string;
      transactionHash: string;
      logIndex: string;
    }>>("eth_getLogs", [
      {
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + latest.toString(16),
        address: token,
        topics: [TRANSFER_TOPIC],
      },
    ]);

    const capped = logs.slice(0, this.options.maxTransactions);
    const truncated = logs.length > capped.length;
    const blockTimes = await this.loadBlockTimes(
      [...new Set(capped.map((l) => l.blockNumber))],
    );

    const swaps: NormalizedSwap[] = [];
    for (const log of capped) {
      const from = topicAddress(log.topics[1]);
      const to = topicAddress(log.topics[2]);
      if (!from || !to) continue;

      let side: "buy" | "sell" | null = null;
      let wallet: string | null = null;
      if (to === pool && from !== pool) {
        side = "sell";
        wallet = from;
      } else if (from === pool && to !== pool) {
        side = "buy";
        wallet = to;
      }
      if (!side || !wallet) continue;

      const amount = hexToAmount(log.data);
      if (amount <= 0) continue;

      const blockTs = blockTimes.get(log.blockNumber);
      if (!blockTs) continue;

      const usdValue =
        query.priceUsd !== null &&
        query.priceUsd !== undefined &&
        Number.isFinite(query.priceUsd)
          ? amount * query.priceUsd
          : null;

      swaps.push({
        id: `${log.transactionHash}:${log.logIndex}`,
        wallet,
        side,
        tokenAmount: amount,
        usdValue,
        timestamp: new Date(blockTs * 1000),
      });
    }

    this.options.log.info("robinhood_swaps_built", {
      token,
      pool,
      logCount: capped.length,
      swapCount: swaps.length,
      fromBlock,
      latest,
      truncated,
    });

    return {
      provider: "robinhood:eth_getLogs",
      truncated,
      inspectedTransactions: capped.length,
      swaps,
    };
  }

  private async loadBlockTimes(blockHexes: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const blockHex of blockHexes) {
      try {
        const block = await this.rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [
          blockHex,
          false,
        ]);
        if (block?.timestamp) {
          out.set(blockHex, Number.parseInt(block.timestamp, 16));
        }
      } catch (err) {
        this.options.log.warn("robinhood_block_time_failed", {
          blockHex,
          ...errorFields(err),
        });
      }
    }
    return out;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const maxRetries = this.options.maxRetries;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const fetchImpl = this.options.fetchImpl ?? fetch;
        const res = await fetchImpl(this.options.rpcUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!res.ok) {
          throw new Error(`Robinhood RPC HTTP ${res.status}`);
        }
        const body = (await res.json()) as {
          result?: T;
          error?: { message?: string };
        };
        if (body.error) {
          throw new Error(body.error.message ?? "Robinhood RPC error");
        }
        return body.result as T;
      } catch (err) {
        lastError = err;
        if (attempt >= maxRetries) break;
        await delay(200 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Robinhood RPC failed");
  }
}

function topicAddress(topic: string | undefined): string | null {
  if (!topic || topic.length < 42) return null;
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function hexToAmount(data: string): number {
  try {
    const raw = data.startsWith("0x") ? data.slice(2) : data;
    if (!raw) return 0;
    // Treat as integer token units; without decimals we use raw / 1e18 as a soft default
    // for relative scoring (ratios cancel). Prefer usdValue when price is known.
    const bi = BigInt("0x" + raw);
    return Number(bi) / 1e18;
  } catch {
    return 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
