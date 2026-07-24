import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { BirdeyeService, fetchBirdeyeSecurity } from "../src/providers/birdeye.js";

const log = createLogger("error");

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("fetchBirdeyeSecurity", () => {
  it("normalizes fraction-based percentages and merges overview holder count", async () => {
    const result = await fetchBirdeyeSecurity({
      mint: "Tok1111111111111111111111111111111111111",
      apiKey: "test-key",
      timeoutMs: 1000,
      log,
      fetchImpl: async (url) => {
        const href = typeof url === "string" ? url : url.toString();
        if (href.includes("token_security")) {
          return jsonResponse({
            success: true,
            data: { creatorPercentage: 0.05, top10HolderPercent: 0.304, freezeable: false, mutableMetadata: false },
          });
        }
        return jsonResponse({ success: true, data: { holder: 412 } });
      },
    });

    expect(result.checked).toBe(true);
    expect(result.creatorPercentage).toBeCloseTo(5, 5);
    expect(result.top10HolderPercent).toBeCloseTo(30.4, 5);
    expect(result.holders).toBe(412);
  });

  it("degrades gracefully when both calls fail", async () => {
    const result = await fetchBirdeyeSecurity({
      mint: "Tok1111111111111111111111111111111111111",
      apiKey: "test-key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(result.checked).toBe(false);
  });

  it("still returns partial data when only one endpoint succeeds", async () => {
    const result = await fetchBirdeyeSecurity({
      mint: "Tok1111111111111111111111111111111111111",
      apiKey: "test-key",
      timeoutMs: 1000,
      log,
      fetchImpl: async (url) => {
        const href = typeof url === "string" ? url : url.toString();
        if (href.includes("token_security")) {
          return jsonResponse({ success: true, data: { creatorPercentage: 0.02 } });
        }
        return new Response("nope", { status: 500 });
      },
    });
    expect(result.checked).toBe(true);
    expect(result.creatorPercentage).toBeCloseTo(2, 5);
    expect(result.holders).toBeNull();
  });
});

describe("BirdeyeService", () => {
  it("reports disabled when no API key is configured", async () => {
    const service = new BirdeyeService({ apiKey: null, timeoutMs: 1000, log });
    expect(service.enabled).toBe(false);
    const result = await service.checkSolanaToken("Tok1111111111111111111111111111111111111");
    expect(result.checked).toBe(false);
  });

  it("caches results per mint within the TTL", async () => {
    let calls = 0;
    const service = new BirdeyeService({
      apiKey: "test-key",
      timeoutMs: 1000,
      cacheMs: 60_000,
      log,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ success: true, data: { holder: 100 } });
      },
    });
    await service.checkSolanaToken("Tok1111111111111111111111111111111111111");
    await service.checkSolanaToken("Tok1111111111111111111111111111111111111");
    expect(calls).toBe(2); // one security + one overview call per lookup
  });
});
