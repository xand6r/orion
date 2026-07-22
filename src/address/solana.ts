import bs58 from "bs58";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Candidate shape from the spec: base58, 32–44 chars. */
export function looksLikeSolanaAddress(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && BASE58_RE.test(value);
}

/** Strict validation: base58 decode must yield exactly 32 bytes. */
export function isValidSolanaAddress(value: string): boolean {
  if (!looksLikeSolanaAddress(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * Pull unique valid Solana addresses from free text.
 * Tickers are ignored — only CA-shaped tokens are considered.
 */
export function extractSolanaAddresses(text: string): string[] {
  if (!text) return [];

  const candidates = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of candidates) {
    if (!isValidSolanaAddress(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }

  return out;
}
