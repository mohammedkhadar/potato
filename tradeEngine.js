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
  ENTRY_THRESHOLD:  0.60,   // stricter threshold to reduce noisy entries
  TAKE_PROFIT_PCT:  1.5,    // close at +1.5% gain
  STOP_LOSS_PCT:    0.8,    // close at -0.8% loss
  MAX_HOLD_MINUTES: 15,     // force-close after 15 min regardless
  MAX_POSITION_USD: 100,    // lower max risk per position while tuning
  POSITION_PCT:     0.05,   // use 5% of available buying power per trade
  MIN_POSITION_USD: 10,     // minimum trade size (Alpaca minimum)
  MAX_OPEN_POSITIONS: 3,    // never hold more than 3 coins simultaneously
  COOLDOWN_AFTER_STOP_MINUTES: 30, // wait after stop-loss before re-entry
  MAX_ENTRY_SLIPPAGE_PCT: 0.20, // skip if estimated entry slippage is too high
  MIN_MOMENTUM_30S_PCT: 0.0, // require non-negative momentum in last 30s
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
      const ageMinutes = entry ? (now - entry.timestamp) / 60000 : null;
      const currentSentiment = sentimentMap[coin] ?? 0;
      const ageDisplay = ageMinutes === null ? 'unknown' : `${ageMinutes.toFixed(1)}min`;

      console.log(`[Engine] ${coin}: P&L=${unrealizedPLPct.toFixed(2)}% | Age=${ageDisplay} | Sentiment=${currentSentiment.toFixed(2)}`);
      if (!entry) {
        console.warn(`[Engine] ${coin}: entry metadata missing; will force close to avoid unmanaged risk`);
      }

      let reason = null;

      if (unrealizedPLPct >= CONFIG.TAKE_PROFIT_PCT) {
        reason = `TAKE PROFIT (+${unrealizedPLPct.toFixed(2)}%)`;
      } else if (unrealizedPLPct <= -CONFIG.STOP_LOSS_PCT) {
        reason = `STOP LOSS (${unrealizedPLPct.toFixed(2)}%)`;
      } else if (ageMinutes !== null && ageMinutes >= CONFIG.MAX_HOLD_MINUTES) {
        reason = `15-MIN EXPIRY (${ageMinutes.toFixed(1)} min held)`;
      } else if (ageMinutes === null) {
        reason = 'MISSING ENTRY METADATA (forced risk close)';
      } else if (currentSentiment < -0.3) {
        reason = `SENTIMENT FLIP (${currentSentiment.toFixed(2)})`;
      }

      if (reason) {
        console.log(`[Engine] → CLOSING ${coin}: ${reason}`);
        await this.broker.closePosition(coin);
        delete this.state.entries[coin];
        if (reason.startsWith('STOP LOSS')) {
          const cooldownUntil = Date.now() + CONFIG.COOLDOWN_AFTER_STOP_MINUTES * 60 * 1000;
          this.state.cooldowns = this.state.cooldowns || {};
          this.state.cooldowns[coin] = cooldownUntil;
          console.log(
            `[Engine] ${coin} cooldown active until ${new Date(cooldownUntil).toISOString()} after stop-loss`
          );
        }
        this._logTrade({ action: 'SELL', coin, reason, pl: unrealizedPLPct });
      } else {
        console.log(`[Engine] → HOLDING ${coin}`);
      }
    }
  }

  // ── Entries ───────────────────────────────────────────────────────────────────
  async _evaluateEntries(sentimentResults, account, currentPositions) {
    this._pruneCooldowns();
    const heldCoins = new Set(currentPositions.map(p => p.coin));
    const slotsAvailable = CONFIG.MAX_OPEN_POSITIONS - currentPositions.length;
    const cooldowns = this.state.cooldowns || {};

    for (const [coin, untilTs] of Object.entries(cooldowns)) {
      const minsLeft = Math.max(0, (untilTs - Date.now()) / 60000);
      if (minsLeft > 0) {
        console.log(`[Engine] ${coin} is in cooldown for ${minsLeft.toFixed(1)} more minutes`);
      }
    }

    // Filter to strong bullish signals on coins we don't already hold
    const opportunities = sentimentResults
      .filter(r => r.score >= CONFIG.ENTRY_THRESHOLD && !heldCoins.has(r.coin) && !cooldowns[r.coin])
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
        try {
          const momentum30sPct = await this.broker.getMomentum30sPct(opp.coin);
          console.log(`[Engine] ${opp.coin} momentum(30s)=${momentum30sPct.toFixed(3)}%`);
          if (momentum30sPct <= CONFIG.MIN_MOMENTUM_30S_PCT) {
            console.log(
              `[Engine] Skipping ${opp.coin}: 30s momentum ${momentum30sPct.toFixed(3)}% <= ${CONFIG.MIN_MOMENTUM_30S_PCT.toFixed(3)}%`
            );
            continue;
          }
        } catch (momentumErr) {
          console.warn(`[Engine] 30s momentum unavailable for ${opp.coin}, continuing: ${momentumErr.message}`);
        }

        try {
          const estSlippagePct = await this.broker.estimateEntrySlippagePct(opp.coin);
          console.log(`[Engine] ${opp.coin} estimated entry slippage=${estSlippagePct.toFixed(3)}%`);
          if (estSlippagePct > CONFIG.MAX_ENTRY_SLIPPAGE_PCT) {
            console.log(
              `[Engine] Skipping ${opp.coin}: estimated slippage ${estSlippagePct.toFixed(3)}% > ${CONFIG.MAX_ENTRY_SLIPPAGE_PCT.toFixed(2)}%`
            );
            continue;
          }
        } catch (slippageErr) {
          console.warn(`[Engine] Slippage estimate unavailable for ${opp.coin}, continuing: ${slippageErr.message}`);
        }

        await this.broker.buy(opp.coin, positionUsd, {
          takeProfitPct: CONFIG.TAKE_PROFIT_PCT,
          stopLossPct: CONFIG.STOP_LOSS_PCT,
        });
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
    return { entries: {}, trades: [], cooldowns: {} };
  }

  _saveState() {
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  _logTrade(trade) {
    const record = { ...trade, timestamp: new Date().toISOString() };
    this.state.trades = [record, ...(this.state.trades || [])].slice(0, 100);
    console.log('[Engine] Trade logged:', JSON.stringify(record));
  }

  _pruneCooldowns() {
    const now = Date.now();
    this.state.cooldowns = this.state.cooldowns || {};
    for (const [coin, untilTs] of Object.entries(this.state.cooldowns)) {
      if (now >= untilTs) delete this.state.cooldowns[coin];
    }
  }
}
