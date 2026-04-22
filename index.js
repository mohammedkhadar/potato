/**
 * Crypto News Trading Bot — Main Entry Point
 *
 * Execution flow:
 *  1. Fetch news from CryptoPanic, CoinDesk, CoinTelegraph, Reddit
 *  2. Analyse sentiment with Claude AI
 *  3. Exit any positions that hit take-profit / stop-loss / 15-min expiry
 *  4. Enter new positions on strong bullish signals
 *
 * Runs as a GitHub Actions workflow on a schedule.
 */

import { NewsFetcher }       from './newsFetcher.js';
import { SentimentAnalyzer } from './sentimentAnalyzer.js';
import { TradeEngine }       from './tradeEngine.js';
import { AlpacaBroker }      from './broker.js';

async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════════════════');
  console.log('  Crypto News Trading Bot');
  console.log(`  ${new Date().toUTCString()}`);
  console.log('═══════════════════════════════════════════════════');

  // ── Validate env ─────────────────────────────────────────────────────────────
  const required = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ANTHROPIC_API_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('Missing required env vars:', missing.join(', '));
    process.exit(1);
  }

  // ── Init services ─────────────────────────────────────────────────────────────
  const broker = new AlpacaBroker({
    apiKey:    process.env.ALPACA_API_KEY,
    apiSecret: process.env.ALPACA_API_SECRET,
    paper:     process.env.PAPER_TRADING !== 'false',  // default: paper mode
  });

  const newsFetcher = new NewsFetcher({
    cryptoPanicKey: process.env.CRYPTOPANIC_API_KEY,   // optional but recommended
  });

  const analyzer = new SentimentAnalyzer({
    anthropicKey: process.env.ANTHROPIC_API_KEY,
  });

  const engine = new TradeEngine({ broker });

  // ── Step 1: Fetch news ────────────────────────────────────────────────────────
  console.log('\n[Bot] Step 1/3 — Fetching news...');
  let articles;
  try {
    articles = await newsFetcher.fetchAll();
  } catch (err) {
    console.error('[Bot] News fetch failed:', err.message);
    process.exit(1);
  }

  if (articles.length === 0) {
    console.log('[Bot] No articles fetched, exiting');
    process.exit(0);
  }

  // Filter to last 30 minutes only — stale news won't move price in 15-min window
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const recentArticles = articles.filter(a => {
    try { return new Date(a.publishedAt) >= thirtyMinAgo; } catch { return true; }
  });
  console.log(`[Bot] ${recentArticles.length}/${articles.length} articles published in last 30 min`);

  // ── Step 2: Sentiment analysis ────────────────────────────────────────────────
  console.log('\n[Bot] Step 2/3 — Analysing sentiment with Claude AI...');
  let sentiment;
  try {
    sentiment = await analyzer.analyze(recentArticles.length > 0 ? recentArticles : articles);
  } catch (err) {
    console.error('[Bot] Sentiment analysis failed:', err.message);
    process.exit(1);
  }

  console.log('\n[Bot] Sentiment Results:');
  if (sentiment.length === 0) {
    console.log('  No significant signals detected');
  } else {
    sentiment.forEach(r => {
      const bar  = r.score > 0 ? '▲' : '▼';
      const sign = r.score > 0 ? '+' : '';
      console.log(`  ${bar} ${r.coin.padEnd(5)} score=${sign}${r.score.toFixed(2)} conf=${r.confidence.toFixed(2)} articles=${r.articleCount}`);
      console.log(`         "${r.reasoning}"`);
    });
  }

  // ── Step 3: Trade ─────────────────────────────────────────────────────────────
  console.log('\n[Bot] Step 3/3 — Running trade engine...');
  try {
    await engine.run(sentiment);
  } catch (err) {
    console.error('[Bot] Trade engine error:', err.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Bot] Completed in ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
