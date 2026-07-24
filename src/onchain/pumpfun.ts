import bs58 from "bs58";
import { z } from "zod";
import { errorFields, type Logger } from "../logger.js";
import { findProgramAddress } from "./pda.js";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/**
 * pump.fun's default Global curve params (verified against the program's own
 * public docs: initial_real_token_reserves=793,100,000,000,000 for a
 * token_total_supply=1,000,000,000,000,000, 6-decimal token). Every coin
 * launched with pump.fun's standard fair-launch flow uses this same ratio;
 * scaling by each curve's own tokenTotalSupply keeps this robust even if a
 * curve's supply ever differs from the default.
 */
const DEFAULT_REAL_RESERVES_RATIO = 793_100_000_000_000 / 1_000_000_000_000_000;

export type BondingCurveState = {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
};

export type BondingCurveMetrics = {
  progressPct: number;
  solRaised: number;
  priceSolPerToken: number;
  marketCapSol: number;
  complete: boolean;
};

/** PDA-derives the bonding-curve account address for a given mint. */
export function bondingCurveAddress(mint: string): string {
  const mintBytes = bs58.decode(mint);
  const { address } = findProgramAddress(
    [Buffer.from("bonding-curve"), Buffer.from(mintBytes)],
    PUMP_PROGRAM_ID,
  );
  return address;
}

/**
 * Decodes the raw pump.fun BondingCurve account layout:
 * 8-byte anchor discriminator, then 5 little-endian u64 fields, then a bool.
 * A trailing 32-byte creator pubkey was added later via extend_account and is
 * ignored here — not needed for scoring, decoding is defensive either way.
 */
export function decodeBondingCurve(data: Buffer): BondingCurveState | null {
  const HEADER = 8;
  const U64_COUNT = 5;
  const MIN_LEN = HEADER + U64_COUNT * 8 + 1;
  if (data.length < MIN_LEN) return null;

  let offset = HEADER;
  const readU64 = (): bigint => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };

  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const complete = data.readUInt8(offset) !== 0;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
}

export function computeBondingCurveMetrics(state: BondingCurveState): BondingCurveMetrics {
  const initialRealTokenReserves =
    Number(state.tokenTotalSupply) * DEFAULT_REAL_RESERVES_RATIO;
  const progressPct =
    initialRealTokenReserves > 0
      ? clampPct(100 * (1 - Number(state.realTokenReserves) / initialRealTokenReserves))
      : 0;

  const priceSolPerToken =
    state.virtualTokenReserves > 0n
      ? Number(state.virtualSolReserves) / Number(state.virtualTokenReserves)
      : 0;

  return {
    progressPct,
    solRaised: Number(state.realSolReserves) / 1e9,
    priceSolPerToken,
    marketCapSol: (priceSolPerToken * Number(state.tokenTotalSupply)) / 1e9,
    complete: state.complete,
  };
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

const accountInfoSchema = z.object({
  result: z
    .object({
      value: z
        .object({
          data: z.tuple([z.string(), z.string()]).or(z.array(z.string())),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});

export type PumpFunSnapshot = {
  checked: boolean;
  exists: boolean;
  metrics: BondingCurveMetrics | null;
  provider: string;
  error?: string;
};

const PROVIDER = "helius:getAccountInfo(bonding-curve)";

/**
 * Fetches and decodes a mint's pump.fun bonding-curve account directly from
 * chain (raw base64 getAccountInfo — pump.fun has no REST API for this).
 * `exists: false` with `checked: true` means the mint simply isn't a
 * pump.fun coin (or has no curve account yet), which is a normal outcome,
 * not an error.
 */
export async function fetchPumpFunBondingCurve(input: {
  mint: string;
  rpcUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log: Logger;
}): Promise<PumpFunSnapshot> {
  const empty: PumpFunSnapshot = {
    checked: false,
    exists: false,
    metrics: null,
    provider: PROVIDER,
  };

  let curveAddress: string;
  try {
    curveAddress = bondingCurveAddress(input.mint);
  } catch (error) {
    return { ...empty, error: `Invalid mint address: ${(error as Error).message}` };
  }

  const url = new URL(input.rpcUrl);
  url.searchParams.set("api-key", input.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "orion-pumpfun-bonding-curve",
        method: "getAccountInfo",
        params: [curveAddress, { encoding: "base64" }],
      }),
    });

    if (!response.ok) {
      return { ...empty, error: `HTTP ${response.status}` };
    }

    const parsed = accountInfoSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ...empty, error: "Invalid response shape" };
    }
    if (parsed.data.error) {
      return { ...empty, error: parsed.data.error.message };
    }

    const value = parsed.data.result?.value;
    if (!value) {
      return { checked: true, exists: false, metrics: null, provider: PROVIDER };
    }

    const [base64Data] = value.data;
    const buffer = Buffer.from(base64Data, "base64");
    const state = decodeBondingCurve(buffer);
    if (!state) {
      return { ...empty, error: "Unrecognized bonding curve account layout" };
    }

    return {
      checked: true,
      exists: true,
      metrics: computeBondingCurveMetrics(state),
      provider: PROVIDER,
    };
  } catch (error) {
    input.log.warn("pumpfun_check_failed", errorFields(error));
    const timedOut = error instanceof Error && error.name === "AbortError";
    return { ...empty, error: timedOut ? "Request timed out" : "Network request failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** Gates the check behind HELIUS_API_KEY the same way mint-risk does. */
export class PumpFunService {
  private readonly log: Logger;

  constructor(
    private readonly options: {
      apiKey: string | null;
      rpcUrl: string;
      timeoutMs: number;
      fetchImpl?: typeof fetch;
      log: Logger;
    },
  ) {
    this.log = options.log.child({ component: "pumpfun_service" });
  }

  get enabled(): boolean {
    return this.options.apiKey !== null && this.options.apiKey.length > 0;
  }

  async checkMint(mint: string): Promise<PumpFunSnapshot> {
    if (!this.enabled) {
      return {
        checked: false,
        exists: false,
        metrics: null,
        provider: PROVIDER,
        error: "HELIUS_API_KEY not configured",
      };
    }
    return fetchPumpFunBondingCurve({
      mint,
      rpcUrl: this.options.rpcUrl,
      apiKey: this.options.apiKey as string,
      timeoutMs: this.options.timeoutMs,
      fetchImpl: this.options.fetchImpl,
      log: this.log,
    });
  }
}
