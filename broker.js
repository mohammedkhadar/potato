/**
 * AlpacaBroker
 *
 * Alpaca Markets — chosen because:
 *  ✅ 0% commission on crypto trading
 *  ✅ Fractional crypto orders
 *  ✅ Free paper trading environment
 *  ✅ REST API with no monthly fees
 *  ✅ Supports BTC, ETH, SOL, AVAX, LINK, UNI, AAVE, XRP, DOGE, LTC and more
 *
 * Sign up: https://alpaca.markets
 * Docs:    https://docs.alpaca.markets/reference/crypto-trading
 */

import axios from 'axios';

const ENDPOINTS = {
  paper: 'https://paper-api.alpaca.markets',
  live:  'https://api.alpaca.markets',
  data:  'https://data.alpaca.markets',
};

// Alpaca uses symbol format "BTC/USD"
const toAlpacaSymbol = coin => `${coin}/USD`;
const fromAlpacaSymbol = symbol => symbol.replace(/\/?USD$/, '');

export class AlpacaBroker {
  constructor({ apiKey, apiSecret, paper = true }) {
    if (!apiKey || !apiSecret) throw new Error('Alpaca API key and secret are required');
    this.paper = paper;
    this.base  = paper ? ENDPOINTS.paper : ENDPOINTS.live;
    this.headers = {
      'APCA-API-KEY-ID':     apiKey,
      'APCA-API-SECRET-KEY': apiSecret,
      'Content-Type':        'application/json',
    };
    console.log(`[Broker] Alpaca ${paper ? 'PAPER' : 'LIVE'} trading — 0% commission`);
  }

  // ── Account ───────────────────────────────────────────────────────────────────
  async getAccount() {
    const { data } = await axios.get(`${this.base}/v2/account`, { headers: this.headers });
    return {
      buyingPower: parseFloat(data.buying_power),
      cash:        parseFloat(data.cash),
      portfolioValue: parseFloat(data.portfolio_value),
      currency:    data.currency,
    };
  }

  // ── Positions ─────────────────────────────────────────────────────────────────
  async getPositions() {
    const { data } = await axios.get(`${this.base}/v2/positions`, { headers: this.headers });
    return data.map(p => ({
      coin:         fromAlpacaSymbol(p.symbol),
      symbol:       p.symbol,
      qty:          parseFloat(p.qty),
      marketValue:  parseFloat(p.market_value),
      costBasis:    parseFloat(p.cost_basis),
      unrealizedPL: parseFloat(p.unrealized_pl),
      unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
      currentPrice: parseFloat(p.current_price),
      avgEntryPrice: parseFloat(p.avg_entry_price),
    }));
  }

  // ── Latest price ──────────────────────────────────────────────────────────────
  async getPrice(coin) {
    const symbol = toAlpacaSymbol(coin);
    const { data } = await axios.get(
      `${ENDPOINTS.data}/v1beta3/crypto/us/latest/trades?symbols=${encodeURIComponent(symbol)}`,
      { headers: this.headers }
    );
    const trade = data.trades?.[symbol];
    if (!trade) throw new Error(`No price data for ${symbol}`);
    return parseFloat(trade.p);
  }

  async getPrices(coins) {
    const symbols = coins.map(toAlpacaSymbol).join(',');
    const { data } = await axios.get(
      `${ENDPOINTS.data}/v1beta3/crypto/us/latest/trades?symbols=${encodeURIComponent(symbols)}`,
      { headers: this.headers }
    );
    const prices = {};
    for (const [sym, trade] of Object.entries(data.trades || {})) {
      prices[fromAlpacaSymbol(sym)] = parseFloat(trade.p);
    }
    return prices;
  }

  // ── Orders ────────────────────────────────────────────────────────────────────
  /**
   * Place a market buy order
   * @param {string} coin  e.g. 'BTC'
   * @param {number} usdAmount  dollar amount to spend
   */
  async buy(coin, usdAmount, { takeProfitPct, stopLossPct } = {}) {
    const symbol = toAlpacaSymbol(coin);

    if (
      typeof takeProfitPct === 'number' &&
      typeof stopLossPct === 'number' &&
      takeProfitPct > 0 &&
      stopLossPct > 0
    ) {
      try {
        return await this._buyWithBracket(coin, usdAmount, takeProfitPct, stopLossPct);
      } catch (err) {
        console.warn(
          `[Broker] Bracket buy failed for ${coin}, falling back to market buy:`,
          err.response?.data?.message || err.message
        );
      }
    }

    const body = {
      symbol,
      notional:   usdAmount.toFixed(2),   // USD notional = fractional friendly
      side:       'buy',
      type:       'market',
      time_in_force: 'gtc',
    };
    const { data } = await axios.post(`${this.base}/v2/orders`, body, { headers: this.headers });
    console.log(`[Broker] BUY  ${coin} $${usdAmount} → order ${data.id}`);
    return data;
  }

  async _buyWithBracket(coin, usdAmount, takeProfitPct, stopLossPct) {
    const symbol = toAlpacaSymbol(coin);
    const price = await this.getPrice(coin);
    const qty = (usdAmount / price).toFixed(8);
    const takeProfitPrice = (price * (1 + takeProfitPct / 100)).toFixed(2);
    const stopLossPrice = (price * (1 - stopLossPct / 100)).toFixed(2);

    const body = {
      symbol,
      qty,
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc',
      order_class: 'bracket',
      take_profit: {
        limit_price: takeProfitPrice,
      },
      stop_loss: {
        stop_price: stopLossPrice,
      },
    };

    const { data } = await axios.post(`${this.base}/v2/orders`, body, { headers: this.headers });
    console.log(
      `[Broker] BRACKET BUY ${coin} qty=${qty} tp=${takeProfitPrice} sl=${stopLossPrice} → order ${data.id}`
    );
    return data;
  }

  /**
   * Place a market sell order for a full position
   */
  async sell(coin, qty) {
    const symbol = toAlpacaSymbol(coin);
    const body = {
      symbol,
      qty:        qty.toString(),
      side:       'sell',
      type:       'market',
      time_in_force: 'gtc',
    };
    const { data } = await axios.post(`${this.base}/v2/orders`, body, { headers: this.headers });
    console.log(`[Broker] SELL ${coin} qty=${qty} → order ${data.id}`);
    return data;
  }

  /**
   * Close an entire position by coin
   */
  async closePosition(coin) {
    const primarySymbol = coin.includes('/') ? coin : toAlpacaSymbol(fromAlpacaSymbol(coin));
    const fallbackSymbol = primarySymbol.includes('/') ? primarySymbol.replace('/', '') : primarySymbol;

    const tryClose = async (symbol) => axios.delete(
      `${this.base}/v2/positions/${encodeURIComponent(symbol)}`,
      { headers: this.headers }
    );

    try {
      const { data } = await tryClose(primarySymbol);
      console.log(`[Broker] CLOSED position ${coin} via ${primarySymbol}`);
      return data;
    } catch (err) {
      if (err.response?.status === 404 && fallbackSymbol !== primarySymbol) {
        try {
          const { data } = await tryClose(fallbackSymbol);
          console.log(`[Broker] CLOSED position ${coin} via ${fallbackSymbol}`);
          return data;
        } catch (fallbackErr) {
          if (fallbackErr.response?.status === 404) {
            console.log(`[Broker] No open position for ${coin}`);
            return null;
          }
          throw fallbackErr;
        }
      }
      if (err.response?.status === 404) {
        console.log(`[Broker] No open position for ${coin}`);
        return null;
      }
      throw err;
    }
  }

  async cancelAllOrders() {
    await axios.delete(`${this.base}/v2/orders`, { headers: this.headers });
    console.log('[Broker] Cancelled all open orders');
  }
}
