/** Basic EVM address check (Robinhood Chain / Ethereum-style). */
export function isValidEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function normalizeEvmAddress(value: string): string {
  return value.trim().toLowerCase();
}
