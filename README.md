# Crypto News Trading Bot

A news-driven crypto trading bot that runs as a **GitHub Actions workflow** every 2 minutes. It fetches breaking crypto news, analyses sentiment with two OSS LLMs via OpenRouter (averaged for reliability), and executes ultra-selective short-term trades.

---

## Architecture

```
GitHub Actions (every 2 min)
        │
        ▼
  NewsFetcher
  ├── CoinDesk RSS      (authoritative crypto journalism)
  └── CoinTelegraph RSS (major crypto outlet)
        │
        ▼
  SentimentAnalyzer (OpenRouter / 2x OSS models)
  └── Averages each coin score (-1.0 to +1.0) for reliability
        │
        ▼
  TradeEngine
  ├── ENTRY: score ≥ 0.85, 30s momentum > 0.15%, low slippage
  ├── EXIT: take profit (+0.6%) / stop loss (-0.35%) / 8-min expiry / sentiment flip
  └── RISK: max 1 position, 1% buying power (max $50), daily guardrails
        │
        ▼
  AlpacaBroker (0% commission crypto)
  └── Market orders via REST API
```

---

## Why Alpaca?

- ✅ **0% commission** on all crypto trades
- ✅ Fractional orders (buy $10 of BTC)
- ✅ Free paper trading environment for safe testing
- ✅ No monthly fees, simple REST API
- ✅ Supports BTC, ETH, SOL, AVAX, LINK, UNI, AAVE, XRP, DOGE, LTC

Sign up at [alpaca.markets](https://alpaca.markets)

---

## Setup

### 1. Clone & install

```bash
git clone <your-repo>
cd crypto-news-trading-bot
npm install
```

### 2. Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Where to get it |
|--------|----------------|
| `ALPACA_API_KEY` | [alpaca.markets](https://alpaca.markets) → API Keys |
| `ALPACA_API_SECRET` | Same page |
| `LLM_API_KEY` | OpenRouter API key |

Optional repository variables:

- `LLM_BASE_URL` (default: `https://openrouter.ai/api/v1`)
- `LLM_MODEL_PRIMARY` (default: `meta-llama/llama-3.1-8b-instruct`)
- `LLM_MODEL_SECONDARY` (default: `qwen/qwen-2.5-7b-instruct`)
- `LLM_MODEL` (legacy fallback for primary model)

### 3. Enable the workflow

Push to `main` — the workflow runs automatically every 2 minutes.

To trigger manually: **Actions → Crypto Trading Bot → Run workflow**

---

## Strategy

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Entry threshold | 0.85 | Ultra-selective signals only |
| 30s momentum threshold | > +0.15% | Requires immediate price confirmation |
| Max entry slippage | 0.05% | Avoids wide-spread entries |
| Take profit | +0.6% | Smaller, more achievable profit target |
| Stop loss | -0.35% | Cut losers quickly |
| Max hold | 8 min | Short-term edge decays quickly |
| Max positions | 1 | One focused trade at a time |
| Position size | 1% buying power (max $50) | Slow accumulation and reduced drawdown |
| Cooldown after stop-loss | 60 min per coin | Prevents immediate re-entry churn |
| Daily loss guard | Stop after -$20 or 2 losing exits | Prevents repeated losses in bad conditions |
| Daily profit guard | Stop after +$20 estimated profit | Locks in slow-accumulation target |

### Exit triggers (in priority order)
1. **Take profit** — unrealised P&L ≥ +0.6%
2. **Stop loss** — unrealised P&L ≤ -0.35%
3. **8-min expiry** — position older than 8 minutes
4. **Sentiment flip** — LLM scores the coin < -0.3

---

## State Management

GitHub Actions runners are stateless, so open position metadata (entry time, entry price) is persisted in `/tmp/bot_state.json` and cached between runs using `actions/cache`. This allows the bot to track how long it has held each position and enforce the 15-minute exit rule across multiple workflow runs.

Alpaca crypto rejects advanced bracket/OTOCO order classes on this route, so entries use standard market buys. Take-profit, stop-loss, max-hold, and sentiment-flip exits are managed by the bot on subsequent runs.

---

## Running locally

```bash
cp .env.example .env
# Fill in your keys

node index.js
```

---

## Paper vs Live Trading

The workflow defaults to **paper trading** (safe simulation with real market data). To switch to live:

- Manual trigger: select `paper_trading = false`
- Or set `PAPER_TRADING=false` as a GitHub Actions variable

**Always test thoroughly in paper mode first.**

---

## Supported Coins

BTC, ETH, SOL, AVAX, LINK, UNI, AAVE, XRP, DOGE, LTC

---

## Disclaimer

This bot is for educational purposes. Crypto trading carries significant risk. Past performance does not guarantee future results. Never trade with money you cannot afford to lose.
