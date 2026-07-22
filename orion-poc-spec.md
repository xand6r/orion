# Orion POC Specification

## 1. Purpose

Build an information engine that accepts explicit research commands over Telegram, combines public market and on-chain data, and ranks tokens for further investigation. Telegram is transport only, never a market-data source.

The POC must test this hypothesis:

> Tokens showing unusually strong market and on-chain demand relative to their current market size may outperform comparable tokens over the next 1 to 24 hours.

The POC is a research system. It will not execute trades, hold private keys, promise profitability, or issue `BUY` and `SELL` instructions.

## 2. Success Criteria

The POC is successful when it can:

1. Accept a valid Solana contract address through an explicit command in an allowed Telegram chat.
2. Return a market or on-chain report within 10 seconds under normal API conditions.
3. Save scans, scores, and provider snapshots without Telegram metadata.
4. Recheck tracked tokens after 15 minutes, 1 hour, 6 hours, and 24 hours.
5. Compare high-scoring tokens with the rest of the observed token cohort.
6. Produce enough evidence to decide whether the scoring system deserves further development.

Operational targets:

- Plain-text messages and channel posts are ignored.
- Repeated commands do not create duplicate follow-up jobs.
- API failure produces a clear error without crashing the bot.
- Every displayed score can be explained by stored component scores and flags.

## 3. POC Scope

### Included

- Solana tokens only
- One Telegram command-and-report interface initially
- Manual `/scan` command
- Dexscreener market and pair data
- Solana on-chain demand through Helius
- Configurable opportunity scoring
- Red and green flags
- SQLite persistence
- Watchlist and manual thesis notes
- Scheduled performance snapshots
- Basic historical ranking report

### Excluded

- Automatic trade execution
- Wallet custody or private keys
- Twitter/X collection
- MEV strategies
- Copy trading
- AI-generated sentiment
- Image and meme analysis
- Guaranteed valuation labels
- Full deployer, holder, bundle, and funding analysis
- Multi-chain support

Holder and deployer analysis is the first likely extension after the POC.

## 4. Users and Access

The initial user is the channel owner and a small set of approved Telegram users.

The bot must ignore commands from chats not listed in `ALLOWED_CHAT_IDS`. Anyone in an allowlisted chat can use every command.

## 5. User Flows

### Manual scan

```text
/scan <contract-address>
```

The bot returns a fresh provider-derived report. Telegram activity does not affect the score.

### Add to watchlist

```text
/watch <contract-address>
```

The token is marked for follow-up tracking. Automatically detected tokens may also be tracked based on configuration.

### Add thesis note

```text
/note <contract-address> <text>
```

The bot stores a timestamped manual note. Notes do not change the score in the POC.

### Review a token

```text
/report <contract-address>
```

The bot returns the latest score, change since first scan, and available follow-up returns.

### Review rankings

```text
/top 24h
```

The bot returns the highest-ranked tokens first seen during the requested period.

## 6. Address Detection

A candidate Solana address must:

- use Base58 characters
- contain 32 to 44 characters
- decode to exactly 32 bytes
- resolve to a Solana token with at least one market pair before a full report is produced

Addresses are validated only when supplied to an explicit command. Ticker-only and plain-text messages do not trigger scans.

## 7. Data Sources

### Telegram

Provides commands and receives reports. Chat/user IDs may be checked in memory for authorization, but Telegram identifiers, updates, messages, and channel history must not be persisted, logged, or used in scoring.

### Dexscreener

Provides, when available:

- token name and symbol
- pair address and DEX
- quote asset
- pair creation time
- price in USD
- market cap and fully diluted valuation
- USD liquidity
- volume by available time window
- buys and sells by available time window
- price change by available time window
- external links supplied with the pair

The client must cache responses briefly and handle missing fields, rate limits, timeouts, and unavailable pairs.

### Solana RPC

Used in the POC only for address validation when needed. Rich holder, mint-authority, freeze-authority, deployer, and funding analysis is deferred.

## 8. Primary Pair Selection

When several pairs exist for a token:

1. Keep only Solana pairs for the requested token address.
2. Discard pairs with missing or zero liquidity.
3. Prefer established quote assets such as SOL, USDC, and USDT.
4. Select the remaining pair with the highest USD liquidity.
5. Store all returned pair identifiers so selection logic can be audited later.

The report must identify the selected DEX and pair.

## 9. Derived Metrics

For each scan, calculate when inputs are available:

- `pair_age_minutes`
- `liquidity_to_market_cap = liquidity_usd / market_cap_usd`
- `volume_1h_to_liquidity = volume_1h_usd / liquidity_usd`
- `volume_1h_to_market_cap = volume_1h_usd / market_cap_usd`
- `buy_sell_ratio_1h = buys_1h / max(sells_1h, 1)`
- `net_buys_1h = buys_1h - sells_1h`
- current provider-reported volume and transaction activity
- on-chain buyer/seller breadth, flow, acceleration, and concentration

Missing values must remain `null`; they must not silently become zero.

## 10. Opportunity Score

The score ranges from 0 to 100 and contains four independently stored components:

| Component | Weight | Meaning |
| --- | ---: | --- |
| Market quality | 25 | Whether liquidity and pair maturity are usable |
| Market activity | 25 | Whether trading activity and demand are currently present |
| Momentum | 25 | Whether provider-reported flow is strengthening |
| Relative value | 25 | Whether activity appears large relative to market size |

Initial thresholds must live in configuration, not be embedded throughout the code.

### Market quality inputs

- absolute USD liquidity
- liquidity-to-market-cap ratio
- pair age
- presence of a usable primary pair

### Market activity inputs

- one-hour transaction count
- buy/sell balance
- one-hour volume relative to liquidity
- recent price direction

### Momentum inputs

- one-hour volume relative to market cap
- one-hour transaction count
- buy/sell balance
- recent price direction

### Relative-value inputs

- one-hour volume-to-market-cap ratio
- rank against tokens in the same pair-age cohort

Until at least 30 comparable scans exist, relative-value scoring must be marked `PROVISIONAL`. Suggested age cohorts are less than 1 hour, 1-6 hours, 6-24 hours, 1-7 days, and over 7 days.

### Penalties and warnings

Configurable penalties may apply for:

- liquidity below the minimum usable threshold
- extreme recent price expansion
- very young pair with insufficient data
- sell imbalance
- suspiciously extreme volume relative to liquidity
- incomplete market data

These are warnings, not proof of fraud or wash trading.

### Verdict labels

| Score | Verdict |
| ---: | --- |
| 0-39 | `IGNORE` |
| 40-59 | `WATCH` |
| 60-79 | `INVESTIGATE` |
| 80-100 | `HIGH ATTENTION` |

A critical data-quality or liquidity warning may cap the verdict regardless of score. The bot must never label a token `SAFE`, `UNDERVALUED`, or `BUY` based on POC data.

## 11. Telegram Report

Reports should be concise enough to read without opening a dashboard:

```text
ORION | $TOKEN | 23m old

MC $180k | Liq $34k | Vol 1h $96k
Buys/Sells 184/91 | Price 1h +18%
Price trend rising | Volume/MC 53%

Score 68/100 | INVESTIGATE | PROVISIONAL
Quality 16 | Activity 20 | Momentum 19 | Value 13

+ Market momentum is strong vs capitalization
+ Liquidity is 18.9% of market cap
- Not checked yet: who holds the coins, who created them, or whether more can still be minted
- Price has already expanded recently

First seen 14:32 UTC | Dexscreener link
```

Messages must escape Telegram formatting correctly and split safely if they exceed platform limits.

## 12. Persistence Model

### `tokens`

- contract address, primary key
- name and symbol
- first seen and last seen timestamps
- selected pair address, DEX, and quote asset

### `scans`

- internal identifier
- token address and scan timestamp
- raw provider payload or payload reference
- market measurements
- derived metrics
- four component scores, penalties, total score, and verdict
- score configuration version
- data-quality status

### `watchlist`

- token address
- creation timestamp and creator
- status: `active`, `completed`, or `dismissed`

### `notes`

- token address
- author, timestamp, and text

### `followups`

- token address and baseline scan
- target horizon: `15m`, `1h`, `6h`, or `24h`
- scheduled and actual timestamps
- target price, market cap, liquidity, and score
- percentage return from baseline
- unique constraint on baseline scan and horizon

## 13. Follow-Up Evaluation

For every eligible baseline scan, collect snapshots at 15 minutes, 1 hour, 6 hours, and 24 hours. A delayed worker must tolerate restarts and process overdue jobs.

Evaluation should report:

- token count by score band
- median and mean forward return by score band
- percentage of tokens positive at each horizon
- percentage reaching +25%, +50%, and +100%
- percentage falling -25%, -50%, and -90%
- median liquidity change
- results compared with all observed tokens in the same age cohort

The POC should not claim an edge until sample size and results are shown. The initial target is at least 100 eligible token observations, with more required before risking capital.

## 14. Architecture

```text
Telegram Bot
    -> explicit command parser
    -> address validator
    -> scan service
        -> Dexscreener client
        -> metric calculator
        -> scoring engine
    -> report formatter
    -> SQLite repository
    -> follow-up scheduler/worker
```

Recommended implementation:

- Node.js with TypeScript
- grammY for Telegram
- built-in `fetch` or a small HTTP client
- SQLite with migrations
- structured logging
- Telegram long polling for local development

The scoring engine, provider client, and Telegram adapter must be separate modules so each can be tested independently.

## 15. Configuration and Secrets

Environment variables (secrets / access only):

```text
TELEGRAM_BOT_TOKEN=
ALLOWED_CHAT_IDS=
HELIUS_API_KEY=
```

Non-secret runtime settings live in `config/app.json` (database path, log level, provider timeouts, follow-up polling, default on-chain window). Thresholds, score weights, follow-up horizons, and automatic watch rules use a versioned scoring configuration file.

Secrets must never be committed or printed in logs. Provide `.env.example`; keep `.env` ignored.

## 16. Reliability and Safety

- Use timeouts and bounded retries for provider requests.
- Deduplicate concurrent scans for the same token.
- Cache recent provider results to reduce repeated calls.
- Store UTC timestamps and display UTC in reports.
- Continue operating when individual Telegram updates are malformed.
- Log scan failures without storing secrets or Telegram identifiers.
- Back up or copy the SQLite database before schema migrations once real observations exist.
- Do not accept seed phrases, private keys, or trading credentials.

## 17. Testing

Required automated tests:

- valid and invalid Solana address parsing
- invalid addresses and repeated commands
- primary-pair selection
- metric calculations with missing and zero values
- deterministic scoring for a fixed configuration version
- verdict caps and warning penalties
- Telegram report formatting and escaping
- absence of Telegram identity/message persistence
- follow-up scheduling and overdue-job recovery
- provider timeout and malformed-response handling

An end-to-end test should invoke a command with a mocked market response and verify the stored scan, outgoing report, and absence of Telegram metadata.

## 18. Delivery Milestones

### Milestone 1: Vertical slice

- Telegram bot receives `/scan <address>`
- Dexscreener data is fetched
- one report is returned
- errors are handled cleanly

### Milestone 2: Market and on-chain engine

- provider scans stored in SQLite
- Telegram metadata excluded from persistence and scoring
- market momentum and on-chain demand calculated
- opportunity score and flags displayed

### Milestone 3: Evidence loop

- watchlist and notes
- follow-up scheduler survives restarts
- 15-minute, 1-hour, 6-hour, and 24-hour outcomes stored
- `/report` and `/top` commands work

### Milestone 4: POC review

- at least 100 eligible observations collected
- results grouped by score band and age cohort
- scoring thresholds revised from evidence
- decision made to stop, iterate, or add on-chain risk analysis

## 19. Definition of Done

The POC is complete when all three functional milestones are running, the automated tests pass, setup instructions are documented, and the evaluation report can show whether higher opportunity scores corresponded with better forward outcomes.

The system's first product is information quality. Trading automation remains a separate decision after the evidence loop works.
