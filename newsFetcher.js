/**
 * NewsFetcher
 *
 * Sources chosen for coverage + free/public access:
 *  1. CoinDesk RSS     — authoritative crypto journalism, no auth needed
 *  2. CoinTelegraph RSS— second major outlet, no auth needed
 *  3. Reddit r/CryptoCurrency — community sentiment, public JSON API
 *  4. Reddit r/Bitcoin        — BTC-focused community signal
 */

import axios from 'axios';

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

const REDDIT_SOURCES = [
  { name: 'reddit_crypto', subreddit: 'CryptoCurrency' },
  { name: 'reddit_bitcoin', subreddit: 'Bitcoin' },
];

// Coins we are willing to trade (Alpaca supports these)
export const SUPPORTED_COINS = [
  'BTC', 'ETH', 'SOL', 'AVAX', 'LINK',
  'UNI',  'AAVE', 'XRP', 'DOGE', 'LTC',
];

export class NewsFetcher {
  async fetchAll() {
    const results = await Promise.allSettled([
      ...RSS_SOURCES.map(s => this._fetchRSS(s)),
      ...REDDIT_SOURCES.map(s => this._fetchReddit(s)),
    ]);

    const articles = [];
    for (const r of results) {
      if (r.status === 'fulfilled') articles.push(...r.value);
      else console.warn('[NewsFetcher] source failed:', r.reason?.message);
    }

    // Deduplicate by title similarity and sort newest first
    const seen = new Set();
    const unique = articles.filter(a => {
      const key = a.title.slice(0, 60).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[NewsFetcher] Fetched ${unique.length} unique articles`);
    return unique;
  }

  // ── RSS feeds ─────────────────────────────────────────────────────────────────
  async _fetchRSS({ name, url }) {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
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

  // ── Reddit ───────────────────────────────────────────────────────────────────
  async _fetchReddit({ name, subreddit }) {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=25`;
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'CryptoNewsBot/1.0' },
    });

    return (data.data?.children || [])
      .filter(p => !p.data.stickied)
      .map(p => ({
        source: name,
        title: p.data.title,
        body: (p.data.selftext || '').slice(0, 500),
        url: `https://reddit.com${p.data.permalink}`,
        publishedAt: new Date(p.data.created_utc * 1000).toISOString(),
        coins: this._extractCoins(p.data.title + ' ' + (p.data.selftext || '')),
        score: p.data.score,
        comments: p.data.num_comments,
      }));
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
