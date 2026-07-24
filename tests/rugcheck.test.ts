import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { fetchRugCheckSummary, RugCheckService } from "../src/onchain/rugcheck.js";

const log = createLogger("error");

function summaryResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("fetchRugCheckSummary", () => {
  it("parses a clean report", async () => {
    const result = await fetchRugCheckSummary({
      mint: "Tok1111111111111111111111111111111111111",
      timeoutMs: 1000,
      log,
      fetchImpl: async () =>
        summaryResponse({
          score: 92,
          riskLevel: "Good",
          mintAuthority: null,
          freezeAuthority: null,
          lpLocked: true,
          lpLockedPct: 100,
          topHoldersPct: 18.4,
          risks: [],
        }),
    });
    expect(result.checked).toBe(true);
    expect(result.score).toBe(92);
    expect(result.mintAuthorityRevoked).toBe(true);
    expect(result.lpLocked).toBe(true);
    expect(result.topHoldersPct).toBe(18.4);
  });

  it("parses a risky report with active authorities", async () => {
    const result = await fetchRugCheckSummary({
      mint: "Tok1111111111111111111111111111111111111",
      timeoutMs: 1000,
      log,
      fetchImpl: async () =>
        summaryResponse({
          score: 35,
          riskLevel: "Danger",
          mintAuthority: "Deployer1111111111111111111111111111111111",
          freezeAuthority: null,
          lpLocked: false,
          topHoldersPct: 61.2,
          risks: [{ name: "Mutable metadata", level: "warning" }],
        }),
    });
    expect(result.mintAuthorityRevoked).toBe(false);
    expect(result.lpLocked).toBe(false);
    expect(result.topHoldersPct).toBe(61.2);
    expect(result.risks).toHaveLength(1);
  });

  it("marks unchecked on 404 (token not indexed)", async () => {
    const result = await fetchRugCheckSummary({
      mint: "Tok1111111111111111111111111111111111111",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });
    expect(result.checked).toBe(false);
  });

  it("marks unchecked on network failure", async () => {
    const result = await fetchRugCheckSummary({
      mint: "Tok1111111111111111111111111111111111111",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.checked).toBe(false);
  });
});

describe("RugCheckService", () => {
  it("caches results per mint within the TTL", async () => {
    let calls = 0;
    const service = new RugCheckService({
      timeoutMs: 1000,
      cacheMs: 60_000,
      log,
      fetchImpl: async () => {
        calls += 1;
        return summaryResponse({ score: 90, riskLevel: "Good", mintAuthority: null, freezeAuthority: null });
      },
    });
    await service.checkSolanaMint("Tok1111111111111111111111111111111111111");
    await service.checkSolanaMint("Tok1111111111111111111111111111111111111");
    expect(calls).toBe(1);
  });

  it("does not cache failed lookups", async () => {
    let calls = 0;
    const service = new RugCheckService({
      timeoutMs: 1000,
      cacheMs: 60_000,
      log,
      fetchImpl: async () => {
        calls += 1;
        return new Response("nope", { status: 500 });
      },
    });
    await service.checkSolanaMint("Tok1111111111111111111111111111111111111");
    await service.checkSolanaMint("Tok1111111111111111111111111111111111111");
    expect(calls).toBe(2);
  });
});
