import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import {
  bondingCurveAddress,
  computeBondingCurveMetrics,
  decodeBondingCurve,
  fetchPumpFunBondingCurve,
  PumpFunService,
  type BondingCurveState,
} from "../src/onchain/pumpfun.js";

const log = createLogger("error");

function encodeCurve(state: {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}): Buffer {
  const buf = Buffer.alloc(49);
  buf.writeBigUInt64LE(state.virtualTokenReserves, 8);
  buf.writeBigUInt64LE(state.virtualSolReserves, 16);
  buf.writeBigUInt64LE(state.realTokenReserves, 24);
  buf.writeBigUInt64LE(state.realSolReserves, 32);
  buf.writeBigUInt64LE(state.tokenTotalSupply, 40);
  buf.writeUInt8(state.complete ? 1 : 0, 48);
  return buf;
}

describe("decodeBondingCurve", () => {
  it("decodes pump.fun's own documented 'fresh curve' example", () => {
    // Ground truth from pump.fun's public docs (PUMP_PROGRAM_README.md):
    // an essentially-untouched bonding curve just after creation.
    const buf = encodeCurve({
      virtualTokenReserves: 1072999999992855n,
      virtualSolReserves: 30000000013n,
      realTokenReserves: 793099999992855n,
      realSolReserves: 13n,
      tokenTotalSupply: 1000000000000000n,
      complete: false,
    });
    const state = decodeBondingCurve(buf);
    expect(state).not.toBeNull();
    expect(state?.complete).toBe(false);

    const metrics = computeBondingCurveMetrics(state as BondingCurveState);
    // Essentially fresh curve — progress should be ~0%, not the ~26% a naive
    // "reserved tokens" formula would produce.
    expect(metrics.progressPct).toBeLessThan(0.01);
    expect(metrics.solRaised).toBeCloseTo(13 / 1e9, 10);
  });

  it("decodes a real, fully graduated on-chain curve (verified live via Helius)", () => {
    // Captured live from account EsmVk4MTsoT71JFaRM5DWFZboKpMQjfY6EYzAgUuksXw
    // (owner: pump program) — fully migrated, all reserves zeroed, complete=true.
    const base64 =
      "F7f4N2DYrGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAxqR+jQMAATeip+0TgS6BPeseaKI8iApyVNh3qhRW7BXP5UqnPRQdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const state = decodeBondingCurve(Buffer.from(base64, "base64"));
    expect(state).toEqual({
      virtualTokenReserves: 0n,
      virtualSolReserves: 0n,
      realTokenReserves: 0n,
      realSolReserves: 0n,
      tokenTotalSupply: 1000000000000000n,
      complete: true,
    });

    const metrics = computeBondingCurveMetrics(state as BondingCurveState);
    expect(metrics.complete).toBe(true);
    expect(metrics.progressPct).toBe(100);
    // Zeroed virtual reserves post-migration must not produce NaN/Infinity.
    expect(metrics.priceSolPerToken).toBe(0);
    expect(metrics.marketCapSol).toBe(0);
  });

  it("returns null for undersized/garbage buffers", () => {
    expect(decodeBondingCurve(Buffer.alloc(10))).toBeNull();
  });
});

describe("bondingCurveAddress", () => {
  it("deterministically derives a valid base58 PDA for a mint", () => {
    const address = bondingCurveAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(bondingCurveAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(address);
  });
});

describe("fetchPumpFunBondingCurve", () => {
  it("reports exists:false when the account is not found (not a pump.fun coin)", async () => {
    const result = await fetchPumpFunBondingCurve({
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      rpcUrl: "https://example.test/rpc",
      apiKey: "test-key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }), {
          status: 200,
        }),
    });
    expect(result.checked).toBe(true);
    expect(result.exists).toBe(false);
  });

  it("decodes a found account into metrics", async () => {
    const buf = encodeCurve({
      virtualTokenReserves: 1072999999992855n,
      virtualSolReserves: 30000000013n,
      realTokenReserves: 793099999992855n,
      realSolReserves: 13n,
      tokenTotalSupply: 1000000000000000n,
      complete: false,
    });
    const result = await fetchPumpFunBondingCurve({
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      rpcUrl: "https://example.test/rpc",
      apiKey: "test-key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { value: { data: [buf.toString("base64"), "base64"] } },
          }),
          { status: 200 },
        ),
    });
    expect(result.checked).toBe(true);
    expect(result.exists).toBe(true);
    expect(result.metrics?.complete).toBe(false);
  });

  it("degrades gracefully on network failure", async () => {
    const result = await fetchPumpFunBondingCurve({
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      rpcUrl: "https://example.test/rpc",
      apiKey: "test-key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.checked).toBe(false);
  });
});

describe("PumpFunService", () => {
  it("reports disabled without an API key", async () => {
    const service = new PumpFunService({
      apiKey: null,
      rpcUrl: "https://example.test/rpc",
      timeoutMs: 1000,
      log,
    });
    expect(service.enabled).toBe(false);
    const result = await service.checkMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(result.checked).toBe(false);
  });
});
