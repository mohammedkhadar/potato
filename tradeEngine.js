/**
 * TradeEngine
 *
 * Strategy: News-driven 15-minute profit-taking
 *
 * Entry rules:
 *  - Sentiment score >= ENTRY_THRESHOLD (strong positive signal)
 *  - No existing position in that coin
 *  - Sufficient buying power
 *
 * Exit rules (evaluated every run):
 *  - Take profit at TAKE_PROFIT_PCT gain
 *  - Stop loss at STOP_LOSS_PCT loss
 *  - Force close any position older than 15 minutes
 *  - Sentiment has flipped negative since entry
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const STATE_FILE = '/tmp/bot_state.json';

// ── Strategy parameters ───────────────────────────────────────────────────────
const CONFIG = {
  ENTRY_THRESHOLD:  0.45,   // minimum sentiment score to enter
  TAKE_PROFIT_PCT:  1.5,    // close at +1.5% gain
  STOP_LOSS_PCT:    0.8,    // close at -0.8% loss
  MAX_HOLD_MINUTES: 15,     // force-close after 15 min regardless
  MAX_POSITION_USD: 200,    // max $ per position
  POSITION_PCT:     0.10,   // use 10% of available buying power per trade
  MIN_POSITION_USD: 10,     // minimum trade size (Alpaca minimum)
  MAX_OPEN_POSITIONS: 3,    // never hold more than 3 coins simultaneously
};

export class TradeEngine {
  constructor({ broker }) {
    this.broker = broker;
    this.state  = this._loadState();
  }

  /**
   * Main entry point called each GitHub Actions run.
   * 1. Checks exits on existing positions
   * 2. Evaluates new entries from sentiment signals
   */
  async run(sentimentResults) {
    console.log('\n[Engine] ── Trade Engine Starting ──────────────────────');
    const account   = await this.broker.getAccount();
    const positions = await this.broker.getPositions();

    console.log(`[Engine] Account: $${account.portfolioValue.toFixed(2)} | Buying Power: $${account.buyingPower.toFixed(2)}`);
    console.log(`[Engine] Open positions: ${positions.length}`);

    // ── Step 1: Exit evaluation ───────────────────────────────────────────────
    await this._evaluateExits(positions, sentimentResults);

    // ── Step 2: Entry evaluation ──────────────────────────────────────────────
    const updatedPositions = await this.broker.getPositions();
    if (updatedPositions.length < CONFIG.MAX_OPEN_POSITIONS) {
      await this._evaluateEntries(sentimentResults, account, updatedPositions);
    } else {
      console.log(`[Engine] Max positions (${CONFIG.MAX_OPEN_POSITIONS}) reached, skipping entries`);
    }

    this._saveState();
    console.log('[Engine] ── Run Complete ────────────────────────────────\n');
  }

  // ── Exits ─────────────────────────────────────────────────────────────────────
  async _evaluateExits(positions, sentimentResults) {
    if (positions.length === 0) {
      console.log('[Engine] No open positions to evaluate');
      return;
    }

    const sentimentMap = Object.fromEntries(sentimentResults.map(r => [r.coin, r.score]));
    const now = Date.now();

    for (const pos of positions) {
      const { coin, unrealizedPLPct, qty } = pos;
      const entry = this.state.entries[coin];
      const ageMinutes = entry ? (now - entry.timestamp) / 60000 : 999;
      const currentSentiment = sentimentMap[coin] ?? 0;

      console.log(`[Engine] ${coin}: P&L=${unrealizedPLPct.toFixed(2)}% | Age=${ageMinutes.toFixed(1)}min | Sentiment=${currentSentiment.toFixed(2)}`);

      let reason = null;

      if (unrealizedPLPct >= CONFIG.TAKE_PROFIT_PCT) {
        reason = `TAKE PROFIT (+${unrealizedPLPct.toFixed(2)}%)`;
      } else if (unrealizedPLPct <= -CONFIG.STOP_LOSS_PCT) {
        reason = `STOP LOSS (${unrealizedPLPct.toFixed(2)}%)`;
      } else if (ageMinutes >= CONFIG.MAX_HOLD_MINUTES) {
        reason = `15-MIN EXPIRY (${ageMinutes.toFixed(1)} min held)`;
      } else if (currentSentiment < -0.3) {
        reason = `SENTIMENT FLIP (${currentSentiment.toFixed(2)})`;
      }

      if (reason) {
        console.log(`[Engine] → CLOSING ${coin}: ${reason}`);
        await this.broker.closePosition(coin);
        delete this.state.entries[coin];
        this._logTrade({ action: 'SELL', coin, reason, pl: unrealizedPLPct });
      } else {
        console.log(`[Engine] → HOLDING ${coin}`);
      }
    }
  }

  // ── Entries ───────────────────────────────────────────────────────────────────
  async _evaluateEntries(sentimentResults, account, currentPositions) {
    const heldCoins = new Set(currentPositions.map(p => p.coin));
    const slotsAvailable = CONFIG.MAX_OPEN_POSITIONS - currentPositions.length;

    // Filter to strong bullish signals on coins we don't already hold
    const opportunities = sentimentResults
      .filter(r => r.score >= CONFIG.ENTRY_THRESHOLD && !heldCoins.has(r.coin))
      .slice(0, slotsAvailable);

    if (opportunities.length === 0) {
      console.log('[Engine] No entry opportunities meet threshold');
      return;
    }

    for (const opp of opportunities) {
      const positionUsd = Math.min(
        account.buyingPower * CONFIG.POSITION_PCT,
        CONFIG.MAX_POSITION_USD
      );

      if (positionUsd < CONFIG.MIN_POSITION_USD) {
        console.log(`[Engine] Insufficient buying power for ${opp.coin} (need $${CONFIG.MIN_POSITION_USD})`);
        continue;
      }

      console.log(`[Engine] → ENTERING ${opp.coin} | Score=${opp.score.toFixed(2)} | $${positionUsd.toFixed(2)}`);
      console.log(`[Engine]   Reason: ${opp.reasoning}`);

      try {
        await this.broker.buy(opp.coin, positionUsd);
        this.state.entries[opp.coin] = {
          timestamp: Date.now(),
          score: opp.score,
          usdAmount: positionUsd,
          reasoning: opp.reasoning,
        };
        this._logTrade({
          action: 'BUY',
          coin: opp.coin,
          usd: positionUsd,
          score: opp.score,
          reason: opp.reasoning,
        });
      } catch (err) {
        console.error(`[Engine] Failed to buy ${opp.coin}:`, err.message);
      }
    }
  }

  // ── State persistence ─────────────────────────────────────────────────────────
  _loadState() {
    try {
      if (existsSync(STATE_FILE)) {
        return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      }
    } catch {}
    return { entries: {}, trades: [] };
  }

  _saveState() {
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  _logTrade(trade) {
    const record = { ...trade, timestamp: new Date().toISOString() };
    this.state.trades = [record, ...(this.state.trades || [])].slice(0, 100);
    console.log('[Engine] Trade logged:', JSON.stringify(record));
  }
}
