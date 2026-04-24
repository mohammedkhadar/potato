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
    // Alpaca crypto on this route rejects advanced order_class (bracket/otoco),
    // so default to direct market orders and keep TP/SL in engine logic.
    this.bracketSupportedForCrypto = false;
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

  async getQuote(coin) {
    const symbol = toAlpacaSymbol(coin);
    const { data } = await axios.get(
      `${ENDPOINTS.data}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(symbol)}`,
      { headers: this.headers }
    );
    const quote = data.quotes?.[symbol];
    if (!quote) throw new Error(`No quote data for ${symbol}`);
    return {
      bid: parseFloat(quote.bp),
      ask: parseFloat(quote.ap),
    };
  }

  /**
   * Estimate entry slippage as ask-side distance from mid price (percentage).
   * For a market buy, this is a practical proxy for immediate execution drag.
   */
  async estimateEntrySlippagePct(coin) {
    const { bid, ask } = await this.getQuote(coin);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
      throw new Error(`Invalid quote for ${coin}: bid=${bid} ask=${ask}`);
    }
    const mid = (bid + ask) / 2;
    return ((ask - mid) / mid) * 100;
  }

  /**
   * Compute momentum over the last 30 seconds from recent trades.
   * Returns percentage change between earliest and latest trade in window.
   */
  async getMomentum30sPct(coin) {
    const symbol = toAlpacaSymbol(coin);
    const end = new Date();
    const start = new Date(end.getTime() - 30_000);
    const url = `${ENDPOINTS.data}/v1beta3/crypto/us/trades?symbols=${encodeURIComponent(symbol)}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&limit=1000`;
    const { data } = await axios.get(url, { headers: this.headers });

    const trades = data?.trades?.[symbol];
    if (!Array.isArray(trades) || trades.length < 2) {
      throw new Error(`Insufficient trades for 30s momentum (${symbol})`);
    }

    const first = parseFloat(trades[0]?.p);
    const last = parseFloat(trades[trades.length - 1]?.p);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) {
      throw new Error(`Invalid trade prices for 30s momentum (${symbol})`);
    }

    return ((last - first) / first) * 100;
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
      this.bracketSupportedForCrypto &&
      typeof takeProfitPct === 'number' &&
      typeof stopLossPct === 'number' &&
      takeProfitPct > 0 &&
      stopLossPct > 0
    ) {
      try {
        return await this._buyWithBracket(coin, usdAmount, takeProfitPct, stopLossPct);
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message || '';
        if (/crypto orders not allowed for advanced order_class/i.test(errMsg)) {
          this.bracketSupportedForCrypto = false;
          console.warn('[Broker] Disabling bracket attempts for crypto in this run (unsupported order_class)');
        }
        console.warn(
          `[Broker] Bracket buy failed for ${coin}, falling back to market buy:`,
          errMsg
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
