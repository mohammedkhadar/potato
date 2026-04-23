# Crypto News Trading Bot

A news-driven crypto trading bot that runs as a **GitHub Actions workflow** every 5 minutes. It fetches breaking crypto news, analyses sentiment with two OSS LLMs via OpenRouter (averaged for reliability), and executes short-term profit-taking trades within a 15-minute window.

---

## Architecture

```
GitHub Actions (every 5 min)
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
  ├── ENTRY: market bracket order with TP/SL on Alpaca (fallback to market buy)
  ├── EXIT: take profit (+1.5%) / stop loss (-0.8%) / 15-min expiry / sentiment flip
  └── ENTRY: score ≥ 0.60, max 3 positions, 5% buying power (max $100) each
        │
        ▼
  AlpacaBroker (0% commission crypto)
  └── Bracket + market orders via REST API
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

Push to `main` — the workflow runs automatically every 5 minutes.

To trigger manually: **Actions → Crypto Trading Bot → Run workflow**

---

## Strategy

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Entry threshold | 0.60 | More selective signals, reduced noise entries |
| Take profit | +1.5% | Realistic 15-min crypto move |
| Stop loss | -0.8% | Asymmetric risk/reward |
| Max hold | 15 min | News alpha decays quickly |
| Max positions | 3 | Diversified but focused |
| Position size | 5% buying power (max $100) | Lower per-trade risk while tuning |
| Cooldown after stop-loss | 30 min per coin | Prevents immediate re-entry churn |

### Exit triggers (in priority order)
1. **Take profit** — unrealised P&L ≥ +1.5%
2. **Stop loss** — unrealised P&L ≤ -0.8%
3. **15-min expiry** — position older than 15 minutes
4. **Sentiment flip** — LLM scores the coin < -0.3

---

## State Management

GitHub Actions runners are stateless, so open position metadata (entry time, entry price) is persisted in `/tmp/bot_state.json` and cached between runs using `actions/cache`. This allows the bot to track how long it has held each position and enforce the 15-minute exit rule across multiple workflow runs.

For entries, the bot now attempts an Alpaca bracket order (`order_class=bracket`) to attach broker-side take-profit and stop-loss immediately after fill. If bracket placement is rejected, it falls back to a standard market buy and keeps software-managed exits.

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
