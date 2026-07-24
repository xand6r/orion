import { z } from "zod";
import { errorFields, type Logger } from "../logger.js";

export type MintRiskSnapshot = {
  checked: boolean;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  provider: string;
  error?: string;
};

const mintInfoSchema = z
  .object({
    mintAuthority: z.string().nullable().optional(),
    freezeAuthority: z.string().nullable().optional(),
  })
  .passthrough();

const accountInfoSchema = z.object({
  result: z
    .object({
      value: z
        .object({
          data: z
            .object({
              parsed: z
                .object({
                  info: mintInfoSchema,
                })
                .passthrough()
                .optional(),
            })
            .passthrough()
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});

const PROVIDER = "helius:getAccountInfo";

/**
 * Reads the SPL mint account directly from chain: null authority = renounced.
 * Deliberately narrow in scope — legacy Token program mint/freeze authorities only.
 * Token-2022 extensions (permanent delegate, transfer fees, etc.) are not decoded.
 */
export async function fetchSolanaMintRisk(input: {
  mint: string;
  rpcUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log: Logger;
}): Promise<MintRiskSnapshot> {
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
        id: "orion-mint-risk",
        method: "getAccountInfo",
        params: [input.mint, { encoding: "jsonParsed" }],
      }),
    });

    if (!response.ok) {
      return {
        checked: false,
        mintAuthorityRevoked: null,
        freezeAuthorityRevoked: null,
        provider: PROVIDER,
        error: `HTTP ${response.status}`,
      };
    }

    const parsed = accountInfoSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        checked: false,
        mintAuthorityRevoked: null,
        freezeAuthorityRevoked: null,
        provider: PROVIDER,
        error: "Invalid response shape",
      };
    }
    if (parsed.data.error) {
      return {
        checked: false,
        mintAuthorityRevoked: null,
        freezeAuthorityRevoked: null,
        provider: PROVIDER,
        error: parsed.data.error.message,
      };
    }

    const info = parsed.data.result?.value?.data?.parsed?.info;
    if (!info) {
      return {
        checked: false,
        mintAuthorityRevoked: null,
        freezeAuthorityRevoked: null,
        provider: PROVIDER,
        error: "Mint account not found or not an SPL token",
      };
    }

    return {
      checked: true,
      mintAuthorityRevoked: info.mintAuthority === null || info.mintAuthority === undefined,
      freezeAuthorityRevoked:
        info.freezeAuthority === null || info.freezeAuthority === undefined,
      provider: PROVIDER,
    };
  } catch (error) {
    input.log.warn("mint_risk_check_failed", errorFields(error));
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      checked: false,
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      provider: PROVIDER,
      error: timedOut ? "Request timed out" : "Network request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Gates the check behind HELIUS_API_KEY the same way Solana sentiment does. */
export class MintRiskService {
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
    this.log = options.log.child({ component: "mint_risk_service" });
  }

  get enabled(): boolean {
    return this.options.apiKey !== null && this.options.apiKey.length > 0;
  }

  async checkSolanaMint(mint: string): Promise<MintRiskSnapshot> {
    if (!this.enabled) {
      return {
        checked: false,
        mintAuthorityRevoked: null,
        freezeAuthorityRevoked: null,
        provider: PROVIDER,
        error: "HELIUS_API_KEY not configured",
      };
    }
    return fetchSolanaMintRisk({
      mint,
      rpcUrl: this.options.rpcUrl,
      apiKey: this.options.apiKey as string,
      timeoutMs: this.options.timeoutMs,
      fetchImpl: this.options.fetchImpl,
      log: this.log,
    });
  }
}
