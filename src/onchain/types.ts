export type OnchainChain = string;
export type SwapSide = "buy" | "sell";

export type NormalizedSwap = {
  id: string;
  wallet: string;
  side: SwapSide;
  tokenAmount: number;
  usdValue: number | null;
  timestamp: Date;
};

export type SwapQuery = {
  address: string;
  marketAddress?: string;
  from: Date;
  to: Date;
  priceUsd?: number | null;
};

export type SwapBatch = {
  swaps: NormalizedSwap[];
  provider: string;
  truncated: boolean;
  inspectedTransactions: number;
};

export interface OnchainAdapter {
  readonly chain: string;
  validateAddress(address: string): boolean;
  getSwaps(query: SwapQuery): Promise<SwapBatch>;
}

export type OnchainSentimentMetrics = {
  windowMinutes: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  /** Wallets that both bought and sold inside the current window (wash suspects). */
  selfTradingWallets: number;
  buyCount: number;
  sellCount: number;
  buyTokenVolume: number;
  sellTokenVolume: number;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  netFlowUsd: number | null;
  buyerSellerRatio: number | null;
  buySellVolumeRatio: number | null;
  buyerGrowth: number | null;
  previousUniqueBuyers: number;
  topFiveBuyerShare: number | null;
  analyzedSwaps: number;
  /** Provider hit its transaction limit; the previous window is unreliable. */
  truncated: boolean;
};

export type OnchainSentimentFlag = {
  kind: "green" | "red" | "info";
  text: string;
};

export type OnchainSentimentScore = {
  total: number;
  verdict: "WEAK" | "NEUTRAL" | "CONSTRUCTIVE" | "STRONG";
  confidence: "insufficient" | "provisional" | "normal";
  breadth: number;
  volumeBalance: number;
  netFlow: number;
  acceleration: number;
  concentration: number;
  flags: OnchainSentimentFlag[];
};

export type OnchainSentimentSuccess = {
  ok: true;
  executionId: string;
  chain: string;
  address: string;
  marketAddress: string | null;
  provider: string;
  truncated: boolean;
  inspectedTransactions: number;
  metrics: OnchainSentimentMetrics;
  score: OnchainSentimentScore;
};

export type OnchainSentimentFailure = {
  ok: false;
  executionId: string;
  chain: string;
  address: string;
  code: "UNSUPPORTED_CHAIN" | "INVALID_ADDRESS" | "PROVIDER_ERROR" | "NO_DATA";
  error: string;
};

export type OnchainSentimentOutcome = OnchainSentimentSuccess | OnchainSentimentFailure;
