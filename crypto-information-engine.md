# Crypto Information Engine

## Goal

Build an information engine that finds **mispriced attention** in newly launched or existing crypto tokens.

We are not building an auto-buy trading bot first. The first product is a research and risk engine that helps decide whether a token is worth deeper investigation.

## Core Idea

A token may be interesting when:

- attention is growing
- market cap is still low relative to that attention
- liquidity is healthy enough to enter and exit
- holders are not dangerously concentrated
- volume is real, not obviously botted
- there is a clear reason future buyers may come in

Cheap does not mean undervalued. Early plus right is the edge.

## First Product

Telegram-first contract analyzer:

```text
Telegram message contains token CA
        ↓
Bot detects contract address
        ↓
Bot fetches market data
        ↓
Bot runs checklist and scoring
        ↓
Bot replies with risk report
        ↓
Scan is saved for review
```

## V1 Data Sources

- Telegram channel/group messages
- Dexscreener market data
- Solana public RPC/indexer data later
- Manual narrative notes

Twitter/X sentiment stays manual for now.

## V1 Checklist

- token name and ticker
- contract address
- pair age
- market cap
- liquidity
- volume
- buys vs sells
- unique makers/traders
- volume vs market cap
- liquidity vs market cap
- basic chart movement
- red flags
- green flags
- score out of 100
- verdict: skip, watch, research, possible trade

## Main Scores

- Safety Score: can this rug or dump easily?
- Attention Score: is attention real and growing?
- Valuation Score: is market cap low relative to attention?
- Liquidity Score: can we enter and exit?
- Momentum Score: is money flowing in now?
- Conviction Score: can we explain the thesis clearly?

## First Milestone

When someone posts a Solana contract address in Telegram, the bot replies within a few seconds:

```text
$TOKEN | 23m old
MC: $180k | Liq: $34k | Vol: $290k
Score: 68/100
Verdict: WATCH

Flags:
- Liquidity thin vs market cap
- Volume healthy
- Needs holder/deployer check
```

## Build Order

1. Define checklist schema.
2. Build Telegram bot listener.
3. Detect Solana contract addresses.
4. Fetch Dexscreener market data.
5. Add basic scoring rules.
6. Format Telegram reply.
7. Save scans to SQLite.
8. Add holder/deployer analysis.
9. Add wallet reputation tracking.
10. Add alerts for promising tokens.

## Rule

No thesis, no trade.

