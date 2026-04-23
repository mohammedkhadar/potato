/**
 * NewsFetcher
 *
 * Sources chosen for coverage + free/public access:
 *  1. CoinDesk RSS     — authoritative crypto journalism, no auth needed
 *  2. CoinTelegraph RSS— second major outlet, no auth needed
 */

import axios from 'axios';

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CryptoNewsBot/1.0; +https://github.com/)',
  Accept: 'application/rss+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

const RSS_SOURCES = [
  {
    name: 'coindesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  },
  {
    name: 'cointelegraph',
    url: 'https://cointelegraph.com/rss',
  },
];

// Coins we are willing to trade (Alpaca supports these)
export const SUPPORTED_COINS = [
  'BTC', 'ETH', 'SOL', 'AVAX', 'LINK',
  'UNI',  'AAVE', 'XRP', 'DOGE', 'LTC',
];

export class NewsFetcher {
  async fetchAll() {
    const tasks = [
      ...RSS_SOURCES.map(source => ({
        source: source.name,
        run: () => this._fetchRSS(source),
      })),
    ];
    const results = await Promise.allSettled(tasks.map(t => t.run()));

    const articles = [];
    for (const [idx, r] of results.entries()) {
      const source = tasks[idx].source;
      if (r.status === 'fulfilled') {
        articles.push(...r.value);
      } else {
        const status = r.reason?.response?.status;
        const suffix = status ? ` (HTTP ${status})` : '';
        console.warn(`[NewsFetcher] source failed (${source})${suffix}:`, r.reason?.message);
      }
    }

    // Deduplicate by title similarity and sort newest first
    const seen = new Set();
    const unique = articles.filter(a => {
      const key = a.title.slice(0, 60).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const coinRelevant = unique.filter(a => Array.isArray(a.coins) && a.coins.length > 0);
    console.log(
      `[NewsFetcher] Fetched ${unique.length} unique articles, ${coinRelevant.length} mention supported coins`
    );
    return coinRelevant;
  }

  // ── RSS feeds ─────────────────────────────────────────────────────────────────
  async _fetchRSS({ name, url }) {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: COMMON_HEADERS,
    });

    // Minimal XML parse without external deps
    const items = [...data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    return items.slice(0, 20).map(([, block]) => {
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     block.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || '';
      const desc  = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                     block.match(/<description>(.*?)<\/description>/))?.[1]
                      ?.replace(/<[^>]+>/g, '').trim() || '';
      const link  = block.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || '';
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';

      return {
        source: name,
        title,
        body: desc.slice(0, 500),
        url: link,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        coins: this._extractCoins(title + ' ' + desc),
      };
    }).filter(a => a.title);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  _extractCoins(text) {
    const upper = text.toUpperCase();
    return SUPPORTED_COINS.filter(coin => {
      // Match ticker as a whole word
      const re = new RegExp(`\\b${coin}\\b`);
      return re.test(upper);
    });
  }
}
