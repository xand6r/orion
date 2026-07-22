import { describe, expect, it } from "vitest";
import {
  extractSolanaAddresses,
  isValidSolanaAddress,
  looksLikeSolanaAddress,
} from "../src/address/solana.js";

// Known valid 32-byte ed25519 pubkey (System Program)
const SYSTEM = "11111111111111111111111111111111";
// USDC mint on Solana
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("solana address", () => {
  it("accepts valid base58 32-byte keys", () => {
    expect(isValidSolanaAddress(SYSTEM)).toBe(true);
    expect(isValidSolanaAddress(USDC)).toBe(true);
  });

  it("rejects wrong length / charset / decode", () => {
    expect(isValidSolanaAddress("short")).toBe(false);
    expect(isValidSolanaAddress("0".repeat(32))).toBe(false); // 0 not in base58
    expect(looksLikeSolanaAddress("OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO")).toBe(false);
    // Valid charset + length but not 32 bytes when decoded
    expect(isValidSolanaAddress("1111111111111111111111111111111")).toBe(false);
  });

  it("extracts multiple unique addresses and skips dupes", () => {
    const text = `check ${USDC} and again ${USDC} also ${SYSTEM}`;
    expect(extractSolanaAddresses(text)).toEqual([USDC, SYSTEM]);
  });

  it("ignores tickers", () => {
    expect(extractSolanaAddresses("buy $BONK now")).toEqual([]);
  });
});
