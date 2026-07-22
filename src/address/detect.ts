import { isValidEvmAddress } from "./evm.js";
import { isValidSolanaAddress } from "./solana.js";

export type MarketChain = "solana" | "robinhood";

/** Infer which market/sentiment chain to use from the address shape. */
export function detectMarketChain(address: string): MarketChain | null {
  const trimmed = address.trim();
  if (isValidEvmAddress(trimmed)) return "robinhood";
  if (isValidSolanaAddress(trimmed)) return "solana";
  return null;
}

export function isValidTokenAddress(address: string): boolean {
  return detectMarketChain(address) !== null;
}
