# Orion

Token research engine with a Telegram command-and-report interface. It scores provider-supplied market activity, stores research observations in SQLite, checks forward returns, and can independently score recent on-chain demand from an explicit chain and token address.

No trading. No keys. No `BUY`/`SELL` labels.

## Docker

```bash
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN + ALLOWED_CHAT_IDS (+ optional HELIUS_API_KEY)
docker compose up -d --build
docker compose logs -f orion
```

SQLite persists in the `orion-data` volume (`/data/orion.sqlite` in the container). Config used in Docker is `config/app.docker.json`.

## Local setup

```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_IDS
# add HELIUS_API_KEY to enable Solana on-chain sentiment
# tune non-secret settings in config/app.json
npm install
npm test
npm run dev
```

**Secrets** live in `.env` (`TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS`, optional `HELIUS_API_KEY`).

**App settings** live in `config/app.json` (database path, log level, Dexscreener/Helius/Robinhood/follow-up timeouts, default sentiment window). Scoring weights stay in `config/scoring.v4.json`.

`ALLOWED_CHAT_IDS` is a comma-separated list of Telegram chat IDs. Anyone in those chats can use every command. Chats not on the list are ignored.

## Commands

| Command | What it does |
| --- | --- |
| `/scan <ca>` | Market+score report (Solana or Robinhood `0x…`); sentiment adjusts the final score |
| `/watch <ca>` | Add to watchlist |
| `/note <ca> <text>` | Store a thesis note |
| `/report <ca>` | Latest score, delta, follow-ups, notes |
| `/sentiment solana\|robinhood <ca> [5\|15\|60]` | Full on-chain demand report; defaults to 15 minutes |
| `/top 24h` | Highest scores first-seen in the window (`1h`/`6h`/`24h`/`7d`) |
| `/rank` | All scanned tokens ranked by **latest** score |
| `/viable` | Same ranking, only recommendable (≥ `recommendMinScore`, non-critical) |
| `/eval` | 24h forward returns by score band |

Telegram is transport only. Orion responds to explicit commands in allowlisted chats; it does not passively inspect channel messages or use Telegram activity as market data.

## Layout

```text
src/
  address/       CA detection + validation
  onchain/       chain adapters, normalized swaps, analysis + scoring
  providers/     Dexscreener client + pair selection
  metrics/       provider-derived market ratios
  scoring/       opportunity score + verdicts
  db/            SQLite migrations + repository
  services/      scan orchestration + follow-up worker
  bot/           grammY handlers + report formatting
config/app.json
config/scoring.v3.json
```

Thresholds live in `config/scoring.v4.json`. Bump `version` when you change weights so stored scores stay auditable. The market score uses provider-derived quality, activity, momentum, and relative volume; on-chain sentiment then applies a capped adjustment (STRONG +8, CONSTRUCTIVE +4, WEAK −12; provisional/insufficient dampened). Telegram mentions do not contribute. Verdicts are capped: sub-usable liquidity or critical data never scores above `WATCH`, incomplete data never above `INVESTIGATE`.

## Telegram data policy

- Chat IDs are read in memory only for allowlist authorization.
- No chat ID, user ID, sender ID, message ID, update ID, message body, or channel history is persisted or included in logs.
- Plain messages and channel posts are ignored. Only explicit bot commands trigger work.
- Token addresses supplied in commands become research inputs. `/note` stores only the note text and token address, without Telegram authorship.
- Migration `003_telegram_transport_only` deletes the old mentions table and clears previously stored watch/note identity fields.

## On-chain sentiment

Run `/sentiment solana <token-address> 15`. Orion selects the token's primary Dexscreener pool, asks Helius for finalized transactions involving that pool over the current and previous windows, and classifies fee-payer token balance changes as buys or sells. Simple transfers without an opposing token or SOL flow are excluded.

The 100-point score measures buyer breadth (25), buy/sell volume balance (25), net flow (20), buyer acceleration versus the previous window (15), and buyer concentration (15). It reports `INSUFFICIENT` confidence below 5 swaps and `PROVISIONAL` below 20; this is a demand signal, not a valuation or trade recommendation.

Anti-gaming guards: verdicts are capped at `NEUTRAL` on insufficient data and `CONSTRUCTIVE` on provisional or truncated windows; truncated windows never score acceleration; one-sided flow ratios are capped at 5x instead of unbounded; wallets that buy and sell in the same window are excluded from breadth counts and, above a 20% participant share, dock the score as suspected wash activity.

The adapter boundary is chain-independent: Solana (Helius) and Robinhood Chain (public EVM RPC + ERC-20 Transfer logs) are wired today. Add another `OnchainAdapter` and register it in `src/index.ts` when another chain is needed.

Current limits:

- Helius `getTransactionsForAddress` access and `HELIUS_API_KEY` are required for Solana sentiment.
- Only the selected primary pool is measured. Multi-pool activity is not yet aggregated.
- At most `ONCHAIN_MAX_TRANSACTIONS` (default 100) are inspected; reports explicitly flag truncated windows.
- USD flow is estimated using the current Dexscreener price. Token-volume scoring remains available when price is missing.
- The heuristic measures transaction-level wallet flow; it does not yet identify funded wallet clusters, holder retention, or insider relationships.

## Logging

Orion writes structured JSON logs through Pino. Telegram updates, provider requests, retries, durations, score outcomes, and failures carry component context. Each sentiment run gets an `executionId`; the Telegram report shows its first eight characters so a result can be matched to logs.

Set `LOG_LEVEL=debug` for request lifecycle detail. API keys, tokens, authorization headers, and Telegram identifiers are not logged. In production, ship stdout to your normal collector and search by `executionId`, `requestId`, `component`, or event message.

## Notes

- Manual `/scan` is stored as a research scan and does not use Telegram activity.
- `/scan` and `/watch` also pull Solana on-chain sentiment (when `HELIUS_API_KEY` is set) and embed it in the report. `/sentiment` remains available for a deeper standalone pass.
- Follow-up notifications include key deltas: return, market score, sentiment score/verdict, buyers, and net flow vs the watch baseline.
- The first usable baseline per token owns the follow-up set; repeated commands do not duplicate experiments.
- Follow-up worker polls overdue jobs, retries transient failures, and records vanished markets as `unpriced` instead of silently excluding them.
- When a follow-up completes (or finalizes as unpriced/failed), Orion notifies every allowlisted chat with the horizon, return vs baseline, and score/price/MC/liq deltas.
- `/scan` reports without tracking; `/watch` creates a tracked baseline for manually supplied tokens.
- Copy `data/orion.sqlite` before migrating once you have real observations.
# orion
