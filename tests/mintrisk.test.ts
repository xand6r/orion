import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { fetchSolanaMintRisk, MintRiskService } from "../src/onchain/mintrisk.js";

const log = createLogger("error");

function rpcResponse(info: Record<string, unknown> | null): Response {
  const body = info
    ? { result: { value: { data: { parsed: { info } } } } }
    : { result: { value: null } };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("fetchSolanaMintRisk", () => {
  it("reports both authorities revoked when the mint account has none", async () => {
    const result = await fetchSolanaMintRisk({
      mint: "Tok1111111111111111111111111111111111111",
      rpcUrl: "https://example.test",
      apiKey: "key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () =>
        rpcResponse({ mintAuthority: null, freezeAuthority: null }),
    });
    expect(result.checked).toBe(true);
    expect(result.mintAuthorityRevoked).toBe(true);
    expect(result.freezeAuthorityRevoked).toBe(true);
  });

  it("reports active authorities when present on the mint", async () => {
    const result = await fetchSolanaMintRisk({
      mint: "Tok1111111111111111111111111111111111111",
      rpcUrl: "https://example.test",
      apiKey: "key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () =>
        rpcResponse({
          mintAuthority: "Deployer11111111111111111111111111111111",
          freezeAuthority: "Deployer11111111111111111111111111111111",
        }),
    });
    expect(result.checked).toBe(true);
    expect(result.mintAuthorityRevoked).toBe(false);
    expect(result.freezeAuthorityRevoked).toBe(false);
  });

  it("marks the check unchecked on a missing mint account", async () => {
    const result = await fetchSolanaMintRisk({
      mint: "Tok1111111111111111111111111111111111111",
      rpcUrl: "https://example.test",
      apiKey: "key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => rpcResponse(null),
    });
    expect(result.checked).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("marks the check unchecked on a provider HTTP failure", async () => {
    const result = await fetchSolanaMintRisk({
      mint: "Tok1111111111111111111111111111111111111",
      rpcUrl: "https://example.test",
      apiKey: "key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(result.checked).toBe(false);
    expect(result.mintAuthorityRevoked).toBeNull();
    expect(result.freezeAuthorityRevoked).toBeNull();
  });

  it("marks the check unchecked on network failure", async () => {
    const result = await fetchSolanaMintRisk({
      mint: "Tok1111111111111111111111111111111111111",
      rpcUrl: "https://example.test",
      apiKey: "key",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.checked).toBe(false);
  });
});

describe("MintRiskService", () => {
  it("is disabled without an API key and never calls the provider", async () => {
    const service = new MintRiskService({
      apiKey: null,
      rpcUrl: "https://example.test",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => {
        throw new Error("should not be called");
      },
    });
    expect(service.enabled).toBe(false);
    const result = await service.checkSolanaMint("Tok1111111111111111111111111111111111111");
    expect(result.checked).toBe(false);
  });

  it("is enabled and delegates to the provider with an API key", async () => {
    const service = new MintRiskService({
      apiKey: "key",
      rpcUrl: "https://example.test",
      timeoutMs: 1000,
      log,
      fetchImpl: async () => rpcResponse({ mintAuthority: null, freezeAuthority: null }),
    });
    expect(service.enabled).toBe(true);
    const result = await service.checkSolanaMint("Tok1111111111111111111111111111111111111");
    expect(result.checked).toBe(true);
    expect(result.mintAuthorityRevoked).toBe(true);
  });
});
