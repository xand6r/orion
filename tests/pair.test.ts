import { describe, expect, it } from "vitest";
import {
  selectPrimaryPair,
  type DexPair,
} from "../src/providers/dexscreener.js";

const TOKEN = "TokenTokenTokenTokenTokenTokenTokenTokenTok";

function pair(partial: Partial<DexPair> & Pick<DexPair, "pairAddress" | "dexId">): DexPair {
  return {
    chainId: "solana",
    url: "https://dexscreener.com/solana/" + partial.pairAddress,
    baseToken: { address: TOKEN, name: "Tok", symbol: "TOK" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
    priceUsd: "1",
    liquidity: { usd: 10_000 },
    ...partial,
  };
}

describe("primary pair selection", () => {
  it("drops non-solana and zero liquidity", () => {
    const selected = selectPrimaryPair(TOKEN, [
      pair({ pairAddress: "a", dexId: "raydium", chainId: "ethereum", liquidity: { usd: 99_000 } }),
      pair({ pairAddress: "b", dexId: "raydium", liquidity: { usd: 0 } }),
      pair({ pairAddress: "c", dexId: "raydium", liquidity: { usd: 12_000 } }),
    ]);
    expect(selected?.pair.pairAddress).toBe("c");
  });

  it("prefers SOL/USDC/USDT then highest liquidity", () => {
    const selected = selectPrimaryPair(TOKEN, [
      pair({
        pairAddress: "meme",
        dexId: "pumpswap",
        liquidity: { usd: 50_000 },
        quoteToken: { address: "x", name: "MEME", symbol: "MEME" },
      }),
      pair({
        pairAddress: "usdc-low",
        dexId: "raydium",
        liquidity: { usd: 20_000 },
        quoteToken: { address: "y", name: "USDC", symbol: "USDC" },
      }),
      pair({
        pairAddress: "sol-high",
        dexId: "raydium",
        liquidity: { usd: 40_000 },
        quoteToken: { address: "z", name: "SOL", symbol: "SOL" },
      }),
    ]);
    expect(selected?.pair.pairAddress).toBe("sol-high");
  });

  it("falls back to highest liquidity when no preferred quote", () => {
    const selected = selectPrimaryPair(TOKEN, [
      pair({
        pairAddress: "a",
        dexId: "x",
        liquidity: { usd: 5_000 },
        quoteToken: { address: "1", name: "A", symbol: "AAA" },
      }),
      pair({
        pairAddress: "b",
        dexId: "x",
        liquidity: { usd: 9_000 },
        quoteToken: { address: "2", name: "B", symbol: "BBB" },
      }),
    ]);
    expect(selected?.pair.pairAddress).toBe("b");
  });

  it("does not attribute base-token market data to a requested quote token", () => {
    const selected = selectPrimaryPair(TOKEN, [
      pair({
        pairAddress: "wrong-side",
        dexId: "raydium",
        baseToken: { address: "another", name: "Another", symbol: "OTHER" },
        quoteToken: { address: TOKEN, name: "Tok", symbol: "TOK" },
        liquidity: { usd: 1_000_000 },
      }),
    ]);
    expect(selected).toBeNull();
  });

  it("prefers ETH/USDC on robinhood", () => {
    const selected = selectPrimaryPair(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        {
          chainId: "robinhood",
          dexId: "uniswap",
          pairAddress: "0xpairmeme",
          url: "",
          baseToken: {
            address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            name: "M",
            symbol: "M",
          },
          quoteToken: { address: "0xbbbb", name: "MEME", symbol: "MEME" },
          priceUsd: "1",
          liquidity: { usd: 80_000 },
        },
        {
          chainId: "robinhood",
          dexId: "uniswap",
          pairAddress: "0xpaireth",
          url: "",
          baseToken: {
            address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            name: "M",
            symbol: "M",
          },
          quoteToken: { address: "0xcccc", name: "ETH", symbol: "ETH" },
          priceUsd: "1",
          liquidity: { usd: 40_000 },
        },
      ],
      "robinhood",
    );
    expect(selected?.pair.pairAddress).toBe("0xpaireth");
  });
});
